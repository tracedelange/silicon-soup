import {
  applyMovement, applyStep, DIRS,
} from './systems/movement.ts';
import { type AttackEvent } from './systems/combat.ts';
import { attackInFacing, attackTarget, attackRange, executeAbility, tickModifiers, tickZones, type HealEvent, type CastEvent } from './systems/abilities.ts';
import { aiTick, applyFearFlee, maybeConfuse, creditDamageThreat, creditHealThreat } from './systems/ai.ts';
import { dialogueTick } from './systems/dialogue.ts';
import { pickupGroundItemsAt, type PickupResult } from './systems/inventory.ts';
import { planPath } from './systems/autopath.ts';
import { isAlive } from './entities.ts';
import { effectiveMaxHealth, effectiveMaxMana, attackCooldown, effectiveStat, ccFlags } from './systems/stats.ts';
import { MANA_REGEN_INTERVAL_TICKS, MANA_REGEN_PER_TICK, TICK_MS, PLAYER_BASE_ACT_TICKS } from '../../shared/constants.ts';
import { WILD } from '../../shared/worldgen/config.ts';
import type { CastFailure, CorpseEntity, Direction, PlayerEntity } from '../../shared/types.ts';
import type { World } from './world.ts';

// Global cooldown shared by the basic attack and every ability — the floor between
// any two actions. Shorter than the attack gate so abilities can be woven between
// auto-attack swings instead of replacing one (the old model gated both on
// PLAYER_BASE_ACT_TICKS, locking a caster to one action per attack interval).
// Mirrored client-side as GCD_MS in game.ts.
const GCD_TICKS = 8;
// Autopath movement speed in tiles per second. Supports fractional values (e.g. 7.5).
// Max is 1000/TICK_MS (10 at TICK_MS=100). Uses a per-entity accumulator for sub-tick precision.
// Was 9 (near the hard cap) — leftover debug speed; slowed to a normal walk pace.
// Then 6 → 5.1: click-walk read as too fast next to the smoothed camera. This
// also lands it on WASD's real rate — see PLAYER_MOVE_BASE_TICKS below — and
// evens out the step cadence: at 6 the accumulator emitted a repeating
// 200/200/100ms pattern, at 5.1 it is 200ms with a 100ms catch-up every ~25
// steps, which reads as steadier motion under camera smoothing.
const AUTOPATH_TILES_PER_SEC = 5.1;
// WASD movement base rate. NOT actually in lockstep with AUTOPATH_TILES_PER_SEC,
// despite deriving from it: the gate below is `ceil`'d to whole ticks, so any
// value in (5, 10] lands on 2 ticks — keyboard walking has been a flat 5 tiles/
// sec at both 6 and 5.1. Tick quantization only admits 10 / 5 / 3.33 / 2.5, so
// slowing WASD in step with click-walk needs the fractional accumulator the
// autopath stepper uses, not a smaller constant here.
const PLAYER_MOVE_BASE_TICKS = (1000 / TICK_MS) / AUTOPATH_TILES_PER_SEC;
// Full day = 20 real minutes.
const TICKS_PER_DAY = 12_000;
const REGEN_COMBAT_LOCKOUT_TICKS = 30;
const REGEN_INTERVAL_TICKS = 10;
const CORPSE_EMPTY_TTL_TICKS = 150;  // 15 s after last item taken
const CORPSE_MAX_TTL_MS = 120_000;   // 2 min hard cap

export type PendingAction =
  | { entityId: string; action: 'move'; dir: Direction }
  | { entityId: string; action: 'attack'; targetId?: string }
  | { entityId: string; action: 'ability'; abilityId: string; targetId?: string; tx?: number; ty?: number }
  | { entityId: string; action: 'autopath'; tx: number; ty: number; chaseTargetId?: string };

export type LoopEvent =
  | AttackEvent
  | (PickupResult & { type: 'pickup'; entityId: string })
  | HealEvent
  | CastEvent
  | { type: 'utterance'; entityId: string; text: string }
  | { type: 'zone_change'; entityId: string; from: string; to: string }
  | { type: 'cast_failed'; entityId: string; abilityId: string; reason: CastFailure }
  | { type: 'player_moved'; entityId: string };

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function dirFromDelta(dx: number, dy: number): Direction | null {
  if (dx === 1  && dy === 0) return 'east';
  if (dx === -1 && dy === 0) return 'west';
  if (dx === 0  && dy === 1) return 'south';
  if (dx === 0  && dy === -1) return 'north';
  return null;
}

export class GameLoop {
  world: World;
  actions: PendingAction[] = [];
  autopathPaths = new Map<string, Array<{ x: number; y: number }>>();
  autopathMoveAccum = new Map<string, number>();
  // Live-target chase: entityId -> the mob being pursued, plus the target
  // position the current path was last aimed at (so we only replan when it
  // actually moves, not every tick). Set alongside autopathPaths when the
  // client engages a mob, so the server keeps re-aiming server-side instead
  // of relying solely on the client resending autopath commands (R: a moving
  // mob was leaving players walking to a stale click-time snapshot).
  autopathChaseTarget = new Map<string, string>();
  autopathChaseLastPos = new Map<string, { x: number; y: number }>();

  private _clearAutopath(entityId: string): void {
    this.autopathPaths.delete(entityId);
    this.autopathMoveAccum.delete(entityId);
    this.autopathChaseTarget.delete(entityId);
    this.autopathChaseLastPos.delete(entityId);
  }

  /** Drop every in-flight path. A stored path is a list of tiles against a
   *  specific world; a wilds rotation or a definition reload invalidates all of
   *  them at once, and a chase target may not survive the swap either. */
  clearAllAutopaths(): void {
    this.autopathPaths.clear();
    this.autopathMoveAccum.clear();
    this.autopathChaseTarget.clear();
    this.autopathChaseLastPos.clear();
  }
  corpseEmptiedTick = new Map<string, number>();
  dirtyZones = new Set<string>();
  tick = 0;
  timer: ReturnType<typeof setInterval> | null = null;
  onTick: ((dirty: Set<string>) => void) | null = null;
  onEvents: ((events: LoopEvent[]) => void) | null = null;
  /** The wilderness's respawn tick. World.tickRespawns iterates `defs.zones`,
   *  and WILD is not one of them, so authored site entities in the open world
   *  need their own hook (see Wilderness.tickSiteSpawns). Returns whether
   *  anything spawned, i.e. whether the wild needs a broadcast. */
  onWildRespawn: ((tick: number) => boolean) | null = null;

  constructor(world: World) {
    this.world = world;
  }

  enqueue(action: PendingAction): void { this.actions.push(action); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private _tick(): void {
    this.tick++;
    this.world.currentTick = this.tick;
    const events: LoopEvent[] = [];

    // Feared players have no autonomous "turn" the way mobs do (see stepMob's
    // fear branch in ai.ts) — this is that same behavior applied once per
    // tick for every feared player, forcing them to flee their fear source
    // regardless of what they queued below (rejected there instead).
    const fearedThisTick = new Set<string>();
    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' || !isAlive(e)) continue;
      if (!ccFlags(e).has('fear')) continue;
      fearedThisTick.add(e.id);
      this._clearAutopath(e.id);
      if (applyFearFlee(this.world, e, ccFlags(e).has('confuse'))) this.dirtyZones.add(e.position.zone);
    }

    const batch = this.actions;
    this.actions = [];
    const actedThisTick = new Set<string>();
    for (const a of batch) {
      const e = this.world.entities.get(a.entityId);
      if (!e || !isAlive(e)) continue;
      // A feared player can't act deliberately this tick — their forced flee
      // step above already happened; drop whatever they queued.
      if (fearedThisTick.has(a.entityId) && (a.action === 'move' || a.action === 'attack' || a.action === 'ability' || a.action === 'autopath')) continue;
      if (a.action === 'autopath') {
        if (e.type === 'player') {
          if (a.chaseTargetId) {
            this.autopathChaseTarget.set(e.id, a.chaseTargetId);
            this.autopathChaseLastPos.delete(e.id); // force a re-aim check next replan tick
          } else {
            this.autopathChaseTarget.delete(e.id);
            this.autopathChaseLastPos.delete(e.id);
          }
          const path = planPath(this.world, e.position.zone, e.position.x, e.position.y, a.tx, a.ty, e.id);
          if (path && path.length > 0) {
            this.autopathPaths.set(e.id, path);
            this.autopathMoveAccum.delete(e.id);
          } else {
            this.autopathPaths.delete(e.id);
            this.autopathMoveAccum.delete(e.id);
          }
        }
        continue;
      }
      // Explicit move or attack cancels any active autopath (and any chase)
      this._clearAutopath(a.entityId);
      actedThisTick.add(a.entityId);
      if (a.action === 'move') {
        if (e.type === 'player') {
          // Movement-speed gate: mobs already share one cadence for their
          // whole turn via nextActTick, but players previously had none for
          // movement specifically — so "slow" lengthened their attack gate
          // (nextActTick) but never actually slowed their walking at all.
          if (this.tick < (e.nextMoveTick || 0)) continue;
          // ceil (not actCooldown's round) so even a modest "slow" pushes the
          // gate past 1 tick — WASD is tick-quantized, so this is inherently
          // coarse; the autopath stepper below scales speed continuously.
          const moveSp = Math.max(0.1, effectiveStat(e, 'speed') || 1);
          e.nextMoveTick = this.tick + Math.max(1, Math.ceil(PLAYER_MOVE_BASE_TICKS / moveSp));
        }
        // Confuse randomizes movement direction — already enforced for mobs
        // inside stepMob (ai.ts); nothing applied it to a player's own input.
        const confused = (e.type === 'player' || e.type === 'mob') && ccFlags(e).has('confuse');
        const dir = maybeConfuse(a.dir, confused) ?? a.dir;
        if (e.type === 'player' && this._tryEdgeWalk(e, dir, events)) {
          continue;
        }
        if (applyMovement(this.world, e, dir)) {
          this.dirtyZones.add(e.position.zone);
          if (e.type === 'player') {
            events.push({ type: 'player_moved', entityId: e.id });
            const picked = pickupGroundItemsAt(this.world, e);
            for (const p of picked) {
              events.push({ type: 'pickup', entityId: e.id, ...p });
            }
            this._tryPortal(e, events);
          }
        }
      } else if (a.action === 'attack') {
        if (e.type === 'ground_item' || e.type === 'corpse') continue;
        if (this.tick < (e.nextActTick || 0)) continue;     // attack-speed gate
        if (this.tick < (e.nextGcdTick || 0)) continue;     // global cooldown (e.g. just cast)
        e.nextActTick = this.tick + attackCooldown(e, PLAYER_BASE_ACT_TICKS, this.world.defs);
        e.nextGcdTick = this.tick + GCD_TICKS;
        const ev = a.targetId
          ? attackTarget(this.world, e, a.targetId, this.tick)
          : attackInFacing(this.world, e, this.tick);
        if (ev) {
          events.push(ev);
          this.dirtyZones.add(e.position.zone);
        }
      } else if (a.action === 'ability') {
        if (e.type !== 'player') continue;
        if (this.tick < (e.nextGcdTick || 0)) continue; // global cooldown gates casts (not the attack gate)
        const ability = this.world.defs.abilities?.[a.abilityId];
        if (!ability) continue;
        const point = (typeof a.tx === 'number' && typeof a.ty === 'number') ? { x: a.tx, y: a.ty } : undefined;
        const res = executeAbility(this.world, e, ability, this.tick, a.targetId, point);
        if (res.cast) {
          e.nextGcdTick = this.tick + GCD_TICKS; // a cast burns the GCD but leaves the attack gate alone
          events.push(...res.events);
          this.dirtyZones.add(e.position.zone);
        } else if (res.reason) {
          // Tell the caster why nothing happened so the client can explain + roll
          // back its optimistic cooldown (see castAbility / onCastFailed).
          events.push({ type: 'cast_failed', entityId: e.id, abilityId: a.abilityId, reason: res.reason });
        }
      }
    }

    // Advance server-side autopaths using a fractional accumulator for smooth speed control.
    // Each tick adds (AUTOPATH_TILES_PER_SEC * TICK_MS / 1000) to the accumulator;
    // a step is taken (and 1.0 consumed) whenever it reaches 1.0.
    const baseStep = AUTOPATH_TILES_PER_SEC * TICK_MS / 1000;
    for (const [entityId, path] of this.autopathPaths) {
      if (actedThisTick.has(entityId)) continue;
      const e = this.world.entities.get(entityId);
      if (!e || !isAlive(e) || e.type !== 'player') {
        this._clearAutopath(entityId);
        continue;
      }
      // Live-target chase: re-aim at the mob's current tile instead of riding
      // out a path planned against wherever it stood when the chase started.
      const chaseId = this.autopathChaseTarget.get(entityId);
      if (chaseId) {
        const target = this.world.entities.get(chaseId);
        if (!target || !isAlive(target) || target.position.zone !== e.position.zone) {
          this._clearAutopath(entityId);
          continue;
        }
        if (chebyshev(e.position.x, e.position.y, target.position.x, target.position.y) <= attackRange(this.world, e)) {
          // Already in range — stop approaching; auto-attack takes over. For a
          // ranged attacker that's several tiles out, so the chase ends without
          // ever walking into melee; the mob closes the rest itself once provoked.
          this._clearAutopath(entityId);
          continue;
        }
        const lastPos = this.autopathChaseLastPos.get(entityId);
        if (!lastPos || lastPos.x !== target.position.x || lastPos.y !== target.position.y) {
          this.autopathChaseLastPos.set(entityId, { x: target.position.x, y: target.position.y });
          const dest = this.world.findFreeNear(e.position.zone, target.position.x, target.position.y);
          const replanned = dest
            ? planPath(this.world, e.position.zone, e.position.x, e.position.y, dest.x, dest.y, e.id)
            : null;
          if (replanned && replanned.length > 0) {
            path.length = 0;
            path.push(...replanned);
          } else {
            this._clearAutopath(entityId);
            continue;
          }
        }
      }
      while (path.length > 0 && path[0]!.x === e.position.x && path[0]!.y === e.position.y) {
        path.shift();
      }
      if (path.length === 0) {
        this._clearAutopath(entityId);
        continue;
      }
      // Scale click-to-move by the player's effective speed so "slow" (and
      // haste) affect it the same way they gate WASD/attacks — otherwise
      // autopath walked at a flat rate regardless of any speed modifier.
      const accumStep = baseStep * Math.max(0.1, effectiveStat(e, 'speed') || 1);
      // Advance accumulator; only step when it reaches 1.0
      const accum = (this.autopathMoveAccum.get(entityId) ?? 0) + accumStep;
      if (accum < 1) {
        this.autopathMoveAccum.set(entityId, accum);
        continue;
      }
      const next = path[0]!;
      const dx = next.x - e.position.x, dy = next.y - e.position.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
        this._clearAutopath(entityId);
        continue;
      }
      // A diagonal covers √2 tiles of ground, so it bills √2 — otherwise walking
      // a staircase would be 41% faster than walking a straight line.
      const cost = (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1;
      if (accum < cost) {
        this.autopathMoveAccum.set(entityId, accum);
        continue;
      }
      // Only a cardinal step can walk off the edge of a zone: the planner works
      // inside one grid, so a diagonal is always interior.
      const dir = dirFromDelta(dx, dy);
      if (dir && this._tryEdgeWalk(e, dir, events)) {
        // Zone changed — path is now invalid
        this._clearAutopath(entityId);
        continue;
      }
      const prevZone = e.position.zone;
      if (applyStep(this.world, e, dx, dy)) {
        // Consume the step's cost, carrying over any remainder
        this.autopathMoveAccum.set(entityId, accum - cost);
        path.shift();
        this.dirtyZones.add(e.position.zone);
        events.push({ type: 'player_moved', entityId: e.id });
        const picked = pickupGroundItemsAt(this.world, e);
        for (const p of picked) events.push({ type: 'pickup', entityId: e.id, ...p });
        this._tryPortal(e, events);
        if (e.position.zone !== prevZone) {
          this._clearAutopath(entityId);
        } else if (path.length === 0) {
          // Path completed — if the player landed at a zone boundary, walk through it
          if (dir && this._tryEdgeWalk(e, dir, events)) {
            this.dirtyZones.add(e.position.zone);
          }
          this._clearAutopath(entityId);
        }
      } else {
        // Movement blocked — carry accumulator forward so we retry next tick
        this.autopathMoveAccum.set(entityId, accum);
      }
    }

    const aiResult = aiTick(this.world, this.tick);
    for (const z of aiResult.dirtyZones) this.dirtyZones.add(z);
    events.push(...aiResult.events);

    for (const u of dialogueTick(this.world, this.tick)) {
      events.push({ type: 'utterance', entityId: u.entityId, text: u.text });
    }

    // Advance status effects (dots/hots). Their damage/heal events join the
    // stream before the lockout loop, so a dot's fatal hit gets the same death
    // handling as any attack and a poison victim's regen is suppressed.
    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' && e.type !== 'mob') continue;
      if (!isAlive(e)) continue;
      const modEvents = tickModifiers(this.world, e, this.tick);
      if (modEvents.length > 0) {
        events.push(...modEvents);
        this.dirtyZones.add(e.position.zone);
      }
    }

    // Persistent ground zones (see World.activeZones) — same event/dirty-zone
    // handling as the modifier pass above, just world-scoped instead of per-entity.
    const zoneEvents = tickZones(this.world, this.tick);
    for (const ev of zoneEvents) {
      events.push(ev);
      const t = this.world.entities.get(ev.targetId);
      if (t) this.dirtyZones.add(t.position.zone);
    }

    // Threat accrual + regen lockout — both read this tick's damage/heal events.
    // Threat is folded in here, after the AI has already run, so a mob's target
    // selection sees the previous tick's hits: one 100 ms tick of lag, against a
    // 15-tick attack cadence. Doing it here instead of inside combat.ts keeps
    // the threat table owned solely by ai.ts (see the threat section there) and
    // catches dot/zone ticks, which land after aiTick, in the same pass.
    for (const ev of events) {
      if (ev.type === 'heal') {
        creditHealThreat(this.world, ev);
        continue;
      }
      if (ev.type !== 'attack') continue;
      creditDamageThreat(this.world, ev);
      const t = this.world.entities.get(ev.targetId);
      if (t && t.type !== 'ground_item' && t.type !== 'corpse') {
        t.nextRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
        t.nextManaRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
      }
    }

    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' && e.type !== 'mob') continue;
      const h = e.components.health;
      const maxHp = effectiveMaxHealth(e);
      if (h && h.current < maxHp && h.current > 0 && this.tick >= (e.nextRegenTick || 0)) {
        e.nextRegenTick = this.tick + REGEN_INTERVAL_TICKS;
        h.current = Math.min(maxHp, h.current + 1);
        this.dirtyZones.add(e.position.zone);
      }
      // Mana regen mirrors health regen: flat amount on an interval, combat-locked.
      const m = e.components.mana;
      const maxMp = effectiveMaxMana(e);
      if (m && m.current < maxMp && this.tick >= (e.nextManaRegenTick || 0)) {
        e.nextManaRegenTick = this.tick + MANA_REGEN_INTERVAL_TICKS;
        m.current = Math.min(maxMp, m.current + MANA_REGEN_PER_TICK);
        this.dirtyZones.add(e.position.zone);
      }
    }

    if (events.length > 0 && this.onEvents) this.onEvents(events);

    // Corpse TTL cleanup (every 10 ticks)
    if (this.tick % 10 === 0) {
      const now = Date.now();
      for (const [id, emptiedTick] of this.corpseEmptiedTick) {
        if (this.tick - emptiedTick >= CORPSE_EMPTY_TTL_TICKS) {
          const e = this.world.entities.get(id);
          if (e) { this.dirtyZones.add(e.position.zone); this.world.removeEntity(id); }
          this.corpseEmptiedTick.delete(id);
        }
      }
      for (const e of this.world.entities.values()) {
        if (e.type !== 'corpse') continue;
        if (now - (e as CorpseEntity).createdAtMs >= CORPSE_MAX_TTL_MS) {
          this.dirtyZones.add(e.position.zone);
          this.world.removeEntity(e.id);
          this.corpseEmptiedTick.delete(e.id);
        }
      }
    }

    const respawnDirty = this.world.tickRespawns(this.tick);
    for (const z of respawnDirty) this.dirtyZones.add(z);
    if (this.onWildRespawn?.(this.tick)) this.dirtyZones.add(WILD);

    // Advance the global day/night clock.
    this.world.timeOfDay = (this.tick % TICKS_PER_DAY) / TICKS_PER_DAY;
    // Every 100 ticks (10 s) push a time update even to quiet zones so clients
    // don't stall on stale timeOfDay when nothing else is happening.
    if (this.tick % 100 === 0) {
      for (const zoneId of Object.keys(this.world.zones)) this.dirtyZones.add(zoneId);
    }

    if (this.dirtyZones.size > 0 && this.onTick) {
      const zones = this.dirtyZones;
      this.dirtyZones = new Set();
      this.onTick(zones);
    }
  }

  markZoneDirty(zoneId: string): void { this.dirtyZones.add(zoneId); }

  private _tryPortal(entity: PlayerEntity, events: LoopEvent[]): void {
    const { zone, x, y } = entity.position;
    // Wilderness has no zone def / portal list — its return gates live on the
    // atlas. Stepping onto a settlement gate returns to that enclosed zone.
    if (zone === WILD) {
      const ret = this.world.wildReturnTargetAt(x, y);
      if (ret && this.world.exitWilderness(entity, ret.zoneId, ret.gate)) {
        events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: ret.zoneId });
        this.dirtyZones.add(WILD);
        this.dirtyZones.add(ret.zoneId);
        return;
      }
      // Dungeon entrances are the other kind of wilderness portal tile. Same
      // shape as a settlement gate, but the destination is the dungeon's own
      // spawn point rather than a gate's return tile.
      const site = this.world.wildSiteAt(x, y);
      if (site && this.world.zones[site.id]) {
        const sp = this.world.getZoneSpawnPoint(site.id);
        if (this.world.teleportPlayer(entity, site.id, sp.x, sp.y)) {
          events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: site.id });
          this.dirtyZones.add(WILD);
          this.dirtyZones.add(site.id);
        }
      }
      return;
    }
    const portal = this.world.portalAt(zone, x, y);
    if (!portal?.to?.zone) return;
    const ok = this.world.teleportPlayer(entity, portal.to.zone, portal.to.x | 0, portal.to.y | 0);
    if (ok) {
      events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: portal.to.zone });
      this.dirtyZones.add(zone);
      this.dirtyZones.add(portal.to.zone);
    }
  }

  private _tryEdgeWalk(entity: PlayerEntity, dir: Direction, events: LoopEvent[]): boolean {
    const d = DIRS[dir];
    if (!d) return false;
    const { zone, x, y } = entity.position;
    const z = this.world.zones[zone];
    if (!z) return false;
    const nx = x + d.dx, ny = y + d.dy;
    const inBounds = nx >= 0 && nx < z.width && ny >= 0 && ny < z.height;
    if (inBounds) return false;
    const toZoneId = z.def?.connections?.[dir];
    if (!toZoneId) return false;
    const ok = this.world.transitionPlayer(entity, dir, toZoneId);
    if (ok) {
      events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: toZoneId });
      this.dirtyZones.add(zone);
      this.dirtyZones.add(toZoneId);
    }
    return true;
  }
}
