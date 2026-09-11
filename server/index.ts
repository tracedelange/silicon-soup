import express from 'express';
import { createServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadWorld } from './world/loader.ts';
import { watchWorld } from './world/watcher.ts';
import { World } from './game/world.ts';
import { GameLoop, type LoopEvent } from './game/loop.ts';
import { Wilderness } from './game/wilderness.ts';
import { planRotation } from './game/rotation.ts';
import { ATLAS_REV, buildAtlas, type RegionAtlas } from '../shared/worldgen/atlas.ts';
import { bakeAtlasFootprints } from './game/mapgen/bake.ts';
import { deriveSeeds } from '../shared/worldgen/field.ts';
import { epochEndsAt, epochOf, epochSeed, WILD_EPOCH_MS } from '../shared/worldgen/epoch.ts';
import { WILD, DEFAULT_WORLD_SEED } from '../shared/worldgen/config.ts';
import { makePlayer, EQUIPMENT_SLOTS, CLASSES } from './game/entities.ts';
import { grantXp, allocateStat, xpForNext } from './game/systems/progress.ts';
import { dropLootFromMob, dropPlayerInventory } from './game/systems/loot.ts';
import { clearCcFromSource } from './game/systems/stats.ts';
import { breakLeash, clearThreatOn } from './game/systems/ai.ts';
import { equipFromSlot, unequipSlot, dropFromSlot, makeStack, refreshDerivedFields } from './game/systems/inventory.ts';
import { generateItem } from './game/items/generator.ts';
import { sellPriceOf } from './game/items/pricing.ts';
import { featuredRefreshAt, featuredStockFor } from './game/items/featured_stock.ts';
import {
  upsertAccount, upsertCharacter, getActiveCharacter, getCharacterById,
  getCharactersByAccount, setActiveCharacter,
  countCharacters, saveCharacters, closeDb,
  recordDiscovery, getDiscoveries,
  getBoardMessages, postBoardMessage,
  type CharacterRow, type StoredCharacterRow,
} from './db/index.ts';
import { verifyFirebaseToken } from './auth.ts';
import {
  buildGiverIndex, handleQuestAction, notifyKill, notifyMove, notifyPickup,
} from './game/systems/quests.ts';
import { getCommand, parseCommand } from './game/systems/commands.ts';
import { clearReveals, pickRevealTarget, revealedSites, revealSite } from './game/systems/scrolls.ts';
import type {
  CharacterSummary,
  ClientToServerEvents, ServerToClientEvents,
  ClassId, CorpseEntity, Direction, Equipment, EquipSlot, InventoryStack,
  LootCorpseResponse, LootSlot, MobEntity, PlayerEntity,
  PostBoardResponse, ReadBoardResponse,
  DiscoveriesEvent, QuestsComponent, StatId, TradeMessage, TradeResponse, UseItemResponse,
  TrainMessage, TrainListResponse, TrainResponse, TrainOffer, AbilityDef, DungeonDef, WorldDefs,
} from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// World root is overridable so a staged FORGE run (forge/stage.ts) can be booted
// in isolation: `WORLD_DIR=forge/runs/<id>/world npm start`. Defaults to world/.
const WORLD_DIR = process.env.WORLD_DIR ? resolve(process.env.WORLD_DIR) : join(ROOT, 'world');
const CLIENT_DIST = join(ROOT, 'client', 'dist');

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN?.split(',') ?? ['http://localhost:5173']
// Re-exported for existing importers (e.g. systems/commands.ts); canonical
// definition now lives in shared/constants.ts so the pipeline can use it too.
export { PREFERRED_STARTING_ZONE } from '../shared/constants.ts';
import { PREFERRED_STARTING_ZONE, CLASS_STARTERS, CLASS_STARTER_WEAPON, ABILITY_SLOTS, equipInFirstEmpty } from '../shared/constants.ts';
// Resolve the spawn zone at call time: the preferred zone if it's loaded, else
// the first available zone. Prevents null/missing-zone spawns when the world
// changes (e.g. a clean-slate rebuild removed the old starting zone).
function startingZone(): string {
  if (world.zones[PREFERRED_STARTING_ZONE]) return PREFERRED_STARTING_ZONE;
  // Generated worlds (FORGE) don't use the canonical village id. Prefer the
  // lowest-tier village zone so the player starts in town, not whatever zone
  // happens to load first (which is often a high-tier wilderness).
  const village = Object.entries(world.zones)
    .filter(([, z]) => z.def?.biome === 'village')
    .sort(([, a], [, b]) => (a.def?.level_band?.tier ?? 99) - (b.def?.level_band?.tier ?? 99))[0];
  if (village) return village[0];
  const first = Object.keys(world.zones)[0];
  if (!first) throw new Error('No zones loaded — cannot place a player.');
  return first;
}

/** The mainhand a brand-new character of this class is created holding. Returns
 *  an empty equipment map if the world has no such base (a generated world may
 *  compose a different material set) — starting bare-handed is a worse opening
 *  than starting armed, but it is a playable one, so a missing base must not
 *  block character creation. */
function starterEquipment(klass: ClassId): Record<string, InventoryStack | null> {
  const baseId = CLASS_STARTER_WEAPON[klass];
  const base = baseId ? world.defs.itemBases[baseId] : undefined;
  if (!base) return {};
  const item = generateItem({ baseId, defs: world.defs, rarity: 'common', ilvl: base.min_ilvl ?? 1 });
  return { mainhand: makeStack(world.defs, baseId, item) };
}

const RESPAWN_DELAY_MS = 10_000;

const app = express();
const httpServer = createServer(app);
const io: IOServer<ClientToServerEvents, ServerToClientEvents> = new IOServer(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

import { existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CLIENT_ORIGIN.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  next();
});

if (existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));

const world = new World();

// ── Continuous wilderness: prebake (or load) the region atlas once and wire the
// field seeds onto the world BEFORE setDefinitions, so portal synthesis (which
// resolves the village→wild gate from the atlas) sees it (docs/rework.md §5.2).
const BASE_SEED = process.env.WORLD_SEED || DEFAULT_WORLD_SEED;
// The wilds rotate on the epoch clock (shared/worldgen/epoch.ts): terrain,
// spawns, and dungeon placement/layout all re-roll together because they all
// derive from this one seed. WILD_ROTATE=0 pins epoch 0 — the stable world the
// generator tooling and fixtures expect.
const ROTATE_WILDS = process.env.WILD_ROTATE !== '0';
// Rotation interval, overridable so the whole path can be exercised without
// waiting for midnight — WILD_EPOCH_MS=180000 rolls the world every 3 minutes.
// Only the server reads the clock (the client takes the live epoch off the
// atlas), so shortening it needs no client rebuild. A boundary lands wherever
// the interval divides Unix time, not at "now + interval".
const EPOCH_INTERVAL_MS = Number(process.env.WILD_EPOCH_MS) || WILD_EPOCH_MS;
// Mutable: rotateWilds() swaps both in place, so everything that stamps or
// compares an epoch (character saves, atlas cache pruning, definition reloads)
// must read these rather than capture a boot-time copy.
let wildEpoch = ROTATE_WILDS ? epochOf(Date.now(), EPOCH_INTERVAL_MS) : 0;
let worldSeed = ROTATE_WILDS ? epochSeed(BASE_SEED, wildEpoch) : BASE_SEED;

// Definitions load BEFORE the atlas: the dungeon roster is world content, and
// the atlas needs it to place entrances. The atlas is then wired onto the world
// before setDefinitions, because portal synthesis resolves village gates and
// dungeon entrances out of it (docs/rework.md §5.2).
const worldDefs = loadWorld(WORLD_DIR, wildEpoch);
const atlas = loadOrBuildAtlas(worldSeed, Object.values(worldDefs.dungeons), wildEpoch, worldDefs);
world.atlas = atlas;
world.wildSeeds = deriveSeeds(atlas.numericSeed);
// Surface the resolved seed at boot — the wilderness terrain derives entirely
// from this, so it's the one thing to check when a WORLD_SEED override "does
// nothing" (the hand-authored starting village is seed-independent; only the
// open wilderness past the gate changes).
console.log(
  `[world] seed="${worldSeed}" base="${BASE_SEED}"${process.env.WORLD_SEED ? '' : ' (default)'} `
  + `epoch=${wildEpoch}${ROTATE_WILDS ? '' : ' (rotation off)'} numericSeed=${atlas.numericSeed} `
  + `sites=${atlas.sites.length}`,
);

world.setDefinitions(worldDefs);

const loop = new GameLoop(world);
const wilderness = new Wilderness(world, atlas, io);

// Every discontinuous relocation — /tp, a portal, a blink, a wilds rotation —
// funnels through World.teleportFx and lands here. Broadcast per-end to the
// zone the puff belongs to, so bystanders at the origin see the vanish even
// though the traveller is already somewhere else. WILD is a room like any
// other zone id, so the wilderness needs no special case.
world.onTeleport = (fx) => {
  const own = socketsByEntity.get(fx.entityId);
  // Everyone in the zone except the traveller, who is handled below — a socket
  // that is in the room would otherwise get the puff twice and draw it twice.
  let room = io.to(fx.zoneId);
  for (const sid of own ?? []) room = room.except(sid);
  room.emit('teleport_fx', fx);
  // The traveller's own sockets, directly. At the moment a teleport resolves
  // they have not joined the destination room yet (and are about to leave the
  // origin one), so a room broadcast alone would miss the one player who is
  // guaranteed to be looking at it. The client draws each puff whenever its
  // zone becomes the rendered one, so the arrival still lands in time.
  for (const sid of own ?? []) io.sockets.sockets.get(sid)?.emit('teleport_fx', fx);
};

function loadOrBuildAtlas(seed: string, dungeons: DungeonDef[], epoch: number, defs: WorldDefs): RegionAtlas {
  // The cache is keyed by the full epoch seed, so a rotation is a cache MISS
  // rather than an invalidation — yesterday's atlas stays readable (handy when
  // debugging "where was this dungeon yesterday") until pruned below.
  const path = join(ROOT, 'data', `atlas-${seed}.json`);
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as RegionAtlas;
      // Reject caches whose baked layout revision is behind the current one, so
      // a footprint/gate/roster change always rebuilds instead of serving a
      // stale bake. `sites` is checked separately: a roster edit changes the
      // placement without touching ATLAS_REV.
      if (cached.rev === ATLAS_REV && cached.stamps && cached.sites?.length === dungeons.length) {
        console.log(`[atlas] loaded cache ${path}`);
        return cached;
      }
      console.log(`[atlas] cache ${path} is stale (rev ${cached.rev ?? '?'} != ${ATLAS_REV}) — rebuilding`);
    }
    catch { /* corrupt cache — rebuild below */ }
  }
  console.log(`[atlas] building fresh atlas for seed="${seed}" (${dungeons.length} dungeons)`);
  const built = buildAtlas(seed, PREFERRED_STARTING_ZONE, dungeons, epoch);
  // Authored exteriors are painted on here, not inside buildAtlas: that lives in
  // shared/ and must never import mapgen (docs/plan-poi-authoring.md). Baking
  // before the cache write keeps the footprint in the cached atlas.
  bakeAtlasFootprints(built, dungeons, defs.blockingTiles, defs.prefabs);
  try { writeFileSync(path, JSON.stringify(built, null, 2)); }
  catch (err) { console.warn('[atlas] cache write failed:', (err as Error).message); }
  pruneAtlasCaches(seed, epoch);
  return built;
}

/** Rotation mints a new atlas file per epoch; without this they accumulate
 *  forever. Keeps the current one plus the immediately previous epoch. */
function pruneAtlasCaches(currentSeed: string, epoch: number): void {
  const dir = join(ROOT, 'data');
  const keep = new Set([`atlas-${currentSeed}.json`, `atlas-${epochSeed(BASE_SEED, epoch - 1)}.json`]);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('atlas-') || !name.endsWith('.json') || keep.has(name)) continue;
      unlinkSync(join(dir, name));
    }
  } catch (err) { console.warn('[atlas] cache prune failed:', (err as Error).message); }
}
loop.onTick = (dirtyZones) => {
  for (const zoneId of dirtyZones) {
    if (zoneId === WILD) { wilderness.broadcast(); continue; }
    broadcastZone(zoneId);
  }
};
loop.onEvents = (events: LoopEvent[]) => {
  for (const ev of events) {
    if (ev.type === 'pickup') {
      emitToEntity(ev.entityId, 'pickup', {
        kind: ev.kind,
        name: ev.name,
        amount: ev.amount,
        slot: ev.slot,
      });
      if (ev.kind === 'item' && ev.base) {
        const player = world.entities.get(ev.entityId);
        if (player && player.type === 'player') {
          const r = notifyPickup(player, world.defs.quests, ev.base, 1);
          emitQuestRewards(player, r);
        }
      }
      continue;
    }
    if (ev.type === 'utterance') {
      const speaker = world.entities.get(ev.entityId);
      if (speaker) {
        io.to(speaker.position.zone).emit('chat', {
          from: { id: speaker.id, name: speaker.name, type: speaker.type },
          text: ev.text,
          at: Date.now(),
        });
      }
      continue;
    }
    if (ev.type === 'cast_failed') {
      emitToEntity(ev.entityId, 'cast_failed', { abilityId: ev.abilityId, reason: ev.reason });
      continue;
    }
    if (ev.type === 'player_moved') {
      const player = world.entities.get(ev.entityId);
      if (player && player.type === 'player') {
        const r = notifyMove(player, world.defs.quests, world);
        emitQuestRewards(player, r);
        // Reconcile chunk subscriptions as the player walks the wilderness.
        if (player.position.zone === WILD) {
          wilderness.syncPlayer(player, socketsByEntity.get(player.id) ?? []);
          checkWildDiscoveries(player.id, player.position.x, player.position.y);
        }
      }
      continue;
    }
    if (ev.type === 'zone_change') {
      applyZoneChange(ev.entityId, ev.from, ev.to);
      continue;
    }
    if (ev.type === 'cast') {
      const caster = world.entities.get(ev.casterId);
      const castTarget = world.entities.get(ev.targetId);
      const zoneId = caster?.position.zone || castTarget?.position.zone;
      if (zoneId) {
        io.to(zoneId).emit('ability_cast', {
          casterId: ev.casterId,
          abilityId: ev.abilityId,
          targetId: ev.targetId,
          at: caster ? { x: caster.position.x, y: caster.position.y } : null,
        });
      }
      continue;
    }
    if (ev.type === 'heal') {
      const source = world.entities.get(ev.sourceId);
      const healTarget = world.entities.get(ev.targetId);
      const zoneId = healTarget?.position.zone || source?.position.zone;
      if (zoneId) {
        io.to(zoneId).emit('heal', {
          sourceId: ev.sourceId,
          targetId: ev.targetId,
          amount: ev.amount,
          at: healTarget ? { x: healTarget.position.x, y: healTarget.position.y } : null,
        });
      }
      // Send updated self immediately so the caster's mana bar refreshes.
      if (source?.type === 'player') emitToEntity(source.id, 'self', { self: source });
      continue;
    }
    if (ev.type !== 'attack') continue;
    const attacker = world.entities.get(ev.attackerId);
    const target = world.entities.get(ev.targetId);
    const zoneId = target?.position.zone || attacker?.position.zone;
    if (zoneId) {
      io.to(zoneId).emit('combat', {
        attackerId: ev.attackerId,
        targetId: ev.targetId,
        damage: ev.damage,
        fatal: ev.fatal,
        dodged: ev.dodged || false,
        at: target ? { x: target.position.x, y: target.position.y } : null,
      });
    }
    // Immediately push updated self so mana bar reflects the cost without waiting for a zone snap.
    if (attacker?.type === 'player' && (attacker.components.mana?.current ?? -1) >= 0) {
      emitToEntity(attacker.id, 'self', { self: attacker });
    }
    if (!ev.fatal) continue;
    if (!target || !zoneId) continue;
    // Fear only makes sense while its source is alive to run from; antagonize
    // only makes sense while there's still a fight to leash the target to.
    for (const z of clearCcFromSource(world, target.id, 'fear')) loop.markZoneDirty(z);
    for (const z of clearCcFromSource(world, target.id, 'antagonize')) loop.markZoneDirty(z);
    if (target.type === 'mob') {
      if (attacker?.type === 'player') {
        const r = notifyKill(attacker, world.defs.quests, target as MobEntity);
        emitQuestRewards(attacker, r);
      }
      if (attacker?.type === 'player' && (target as MobEntity).xpReward) {
        const result = grantXp(attacker, (target as MobEntity).xpReward);
        emitToEntity(attacker.id, 'xp', {
          gained: (target as MobEntity).xpReward,
          xp: attacker.components.progress.xp,
          level: attacker.components.progress.level,
          xp_to_next: xpForNext(attacker.components.progress.level),
          source: { name: target.name, id: target.id },
        });
        if (result.leveled > 0) {
          emitToEntity(attacker.id, 'levelup', {
            level: result.toLevel!,
            from_level: result.fromLevel!,
            unspent_points: attacker.components.progress.unspent_points,
          });
          io.emit('chat', {
            from: { id: 'system', name: 'System', type: 'player' as const },
            text: `${attacker.name} has reached level ${result.toLevel}!`,
            at: Date.now(),
            channel: 'system',
          });
          loop.markZoneDirty(attacker.position.zone);
        }
      }
      dropLootFromMob(world, target as MobEntity, attacker?.type === 'player' ? attacker : null);
      world.scheduleRespawn(target as MobEntity, loop.tick);
      world.removeEntity(target.id);
      loop.markZoneDirty(zoneId);
    } else if (target.type === 'player') {
      const deathZone = target.position.zone;
      const deathAt = { x: target.position.x, y: target.position.y };
      if (deathZone === WILD) wilderness.removePlayer(target.id, socketsByEntity.get(target.id) ?? []);
      dropPlayerInventory(world, target);
      movePlayerToRespawn(target);
      emitToEntity(target.id, 'died', {});
      // Blood for everyone in the zone, not just the one who bled. The victim's
      // own sockets are excluded from the room broadcast and emitted to
      // directly: a wilds death drops them from the chunk rooms (removePlayer,
      // above), and either way they are about to leave the zone room for the
      // respawn point.
      const splat = { zone: deathZone, x: deathAt.x, y: deathAt.y };
      const ownSockets = socketsByEntity.get(target.id) ?? [];
      let splatRoom = io.to(deathZone);
      for (const sid of ownSockets) splatRoom = splatRoom.except(sid);
      splatRoom.emit('death_splat', splat);
      emitToEntity(target.id, 'death_splat', splat);
      io.emit('chat', {
        from: { id: 'system', name: 'System', type: 'player' as const },
        text: `${target.name} has fallen!`,
        at: Date.now(),
        channel: 'system',
      });
      loop.markZoneDirty(deathZone);
      loop.markZoneDirty(target.position.zone);
      const dyingPlayer = target;
      setTimeout(() => sendRespawnEvent(dyingPlayer), RESPAWN_DELAY_MS);
    }
  }
};

function emitToEntity<E extends keyof ServerToClientEvents>(
  entityId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): void {
  const sockets = socketsByEntity.get(entityId);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid) as Socket<ClientToServerEvents, ServerToClientEvents> | undefined;
    // The generic constraint resolves at the call site, not here — cast to bypass.
    (s?.emit as ((e: E, p: unknown) => void) | undefined)?.(event, payload);
  }
}
loop.start();

import type { NotifyResult } from './game/systems/quests.ts';
function emitQuestRewards(player: PlayerEntity, r: NotifyResult): void {
  if (!r.changed) return;
  emitToEntity(player.id, 'quests', { quests: player.components.quests });
  if (r.rewardsGranted.gold || r.rewardsGranted.items.length || r.rewardsGranted.xp) {
    emitToEntity(player.id, 'self', { self: player });
  }
  if (r.rewardsGranted.xp) {
    emitToEntity(player.id, 'xp', {
      gained: r.rewardsGranted.xp,
      xp: player.components.progress.xp,
      level: player.components.progress.level,
      xp_to_next: xpForNext(player.components.progress.level),
      source: { name: 'Quest', id: '' },
    });
  }
  if (r.rewardsGranted.leveled > 0) {
    emitToEntity(player.id, 'levelup', {
      level: r.rewardsGranted.toLevel!,
      from_level: r.rewardsGranted.fromLevel!,
      unspent_points: player.components.progress.unspent_points,
    });
    io.emit('chat', {
      from: { id: 'system', name: 'System', type: 'player' as const },
      text: `${player.name} has reached level ${r.rewardsGranted.toLevel}!`,
      at: Date.now(),
      channel: 'system',
    });
  }
}

function movePlayerToRespawn(player: PlayerEntity): void {
  const sz = startingZone();
  const sp = world.getZoneSpawnPoint(sz);
  world.teleportPlayer(player, sz, sp.x, sp.y);
  player.components.health.current = player.components.health.max;
  if (player.components.progress) {
    // Lose 25% of current-level XP progress on death
    player.components.progress.xp = Math.floor(player.components.progress.xp * 0.75);
  }
  // The mobs that just killed this player won their fight: full reset, back to
  // where they engaged. Dropping threat alone would leave them chipped down and
  // out of position, so dying next to a nearly-dead mob would be a cheap way to
  // keep the fight where you left it.
  for (const e of world.entities.values()) {
    if (e.type === 'mob' && e.components.ai?.target === player.id) breakLeash(e, loop.tick);
  }
  // Every other mob that merely traded a hit with them drops them off its threat
  // table. The player entity survives death (it respawns), so nothing would
  // prune those entries on its own and a mob left holding one would keep the
  // respawned player as its top threat and go hunting across the world.
  clearThreatOn(world, player.id);
}

function sendRespawnEvent(player: PlayerEntity): void {
  const sockets = socketsByEntity.get(player.id);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      for (const room of s.rooms) {
        if (room !== sid && room !== player.position.zone) s.leave(room);
      }
      s.join(player.position.zone);
      const zone = world.snapshotZone(player.position.zone);
      if (zone) s.emit('respawn', { zone, self: player });
    }
  }
}

watchWorld(WORLD_DIR, ({ event, path }) => {
  console.log(`[world] ${event}: ${path} — reloading`);
  try {
    world.setDefinitions(loadWorld(WORLD_DIR, wildEpoch));
    giverIndexCache = null;
    // The wilderness caches its spawnable roster, so a reloaded mob never
    // reaches the open world without this.
    wilderness.refreshTemplates();
    for (const e of world.entities.values()) {
      if (e.type !== 'player') continue;
      if (!world.zones[e.position.zone]) {
        const fallback = Object.keys(world.zones)[0]!;
        const sp = world.getZoneSpawnPoint(fallback);
        e.position = { zone: fallback, x: sp.x, y: sp.y };
        world.byZone.get(fallback)!.add(e.id);
      }
    }
    for (const zoneId of Object.keys(world.zones)) broadcastZone(zoneId);
  } catch (err) {
    console.error('[world] reload failed:', (err as Error).message);
  }
});


// ── Live wilds rotation (docs/rotating-wilds.md) ─────────────────────────────
// Swaps the entire open world out from under a running server. A full rebuild
// measures ~35-55ms against a 100ms tick, so this happens inside one tick and
// needs no downtime — the difficulty is never the cost, it is evicting every
// piece of state that was derived from the outgoing seed.
//
// The ORDER below is the whole trick. In particular the next world is built
// before anything live is touched, so a bad roster or a disk error leaves the
// current epoch running instead of a half-swapped world.

/** How often to check whether the epoch has turned over. Deliberately a poll
 *  rather than a timer to the boundary: a setTimeout hours out does not survive
 *  a laptop sleeping or the clock stepping, and silently never fires. Scaled to
 *  the interval so a short test epoch is not served by a 30s poll. */
const ROTATION_POLL_MS = Math.min(30_000, Math.max(1_000, Math.round(EPOCH_INTERVAL_MS / 20)));
/** Lead times at which players are warned, longest first. Without this a player
 *  fighting in the wilds is teleported to town with no explanation, which reads
 *  as a bug rather than a feature. A lead of half an epoch or more would fire
 *  the instant that epoch began, so short intervals drop the leads that do not
 *  fit and fall back to a single warning a third of the way through. */
const ROTATION_WARNINGS_MS = (() => {
  const fits = [5 * 60_000, 60_000].filter(ms => ms < EPOCH_INTERVAL_MS / 2);
  return fits.length ? fits : [Math.round(EPOCH_INTERVAL_MS / 3)];
})();

const sysChat = (text: string): void => {
  io.emit('chat', {
    from: { id: 'system', name: 'System', type: 'player' as const },
    text,
    at: Date.now(),
  });
};

/** Warning lead times already announced for the current epoch. */
const warnedFor = new Set<number>();

/** @param epoch the epoch to move to. Only ever moves FORWARD — a clock that
 *  steps backwards (NTP correction, a VM restored from a snapshot) must not
 *  drag players back into a world that has already been retired. */
function rotateWilds(epoch: number): boolean {
  if (epoch <= wildEpoch) return false;
  const seed = epochSeed(BASE_SEED, epoch);
  const startedAt = Date.now();

  // 1. Build the next world first. Nothing live has been touched yet, so a
  //    throw here is survivable: log it and keep serving the current epoch.
  let nextDefs, nextAtlas;
  try {
    nextDefs = loadWorld(WORLD_DIR, epoch);
    nextAtlas = loadOrBuildAtlas(seed, Object.values(nextDefs.dungeons), epoch, nextDefs);
  } catch (err) {
    console.error(`[rotate] building epoch ${epoch} failed — staying on ${wildEpoch}:`, (err as Error).message);
    return false;
  }

  // 2. Decide what moves and what dies, against the OUTGOING world.
  const plan = planRotation(world.entities.values(), (world.atlas?.sites ?? []).map(st => st.id));

  sysChat('The wilds shift. You feel the land rearrange itself around you.');

  // 3. Evacuate before the rebuild, so nobody is standing in a zone that is
  //    about to be regenerated (or on wilderness tiles that may become water).
  //    applyZoneChange does the socket-room bookkeeping and persists; the zone
  //    snapshot it sends is superseded by the broadcast in step 8.
  for (const player of plan.evacuate) {
    const from = player.position.zone;
    const home = wildRestorePoint();
    world.teleportPlayer(player, home.zone, home.x, home.y);
    applyZoneChange(player.id, from, home.zone);
  }

  // 4. Cull the wilderness. World._rebuildZone clears and respawns each grid
  //    zone it rebuilds, but it iterates defs.zones and WILD is not one of
  //    them — so the open world's mobs, corpses and dropped loot are ours.
  for (const id of plan.cull) world.removeEntity(id);
  for (const [id, z] of world.activeZones) {
    if (z.zoneId === WILD) world.activeZones.delete(id);
  }

  // 5. Every stored path is a list of tiles in a world that no longer exists.
  loop.clearAllAutopaths();

  // 6. Swap the seed. The atlas must be on the world BEFORE setDefinitions,
  //    because portal synthesis resolves village gates and dungeon entrances
  //    out of it — the same ordering constraint boot has.
  wildEpoch = epoch;
  worldSeed = seed;
  world.atlas = nextAtlas;
  world.wildSeeds = deriveSeeds(nextAtlas.numericSeed);
  wilderness.rotate(nextAtlas);
  world.setDefinitions(nextDefs);
  giverIndexCache = null;
  warnedFor.clear();
  // Scroll reveals are positions in the world that just ended (systems/scrolls.ts).
  clearReveals();

  // 7. Tell clients to drop everything they derived from the old seed and
  //    refetch the atlas. Sent to everyone: a player in town has stale
  //    wilderness caches too, and will walk back out into the new world.
  io.emit('wild_reset', { epoch, endsAt: epochEndsAt(epoch, EPOCH_INTERVAL_MS) });

  // 8. Fresh snapshots for the rebuilt grids, then re-stream the wilderness to
  //    anyone still out there (nobody is, after step 3 — but a rotation must
  //    not depend on that being true forever).
  for (const zoneId of Object.keys(world.zones)) broadcastZone(zoneId);
  for (const e of world.entities.values()) {
    if (e.type === 'player' && e.position.zone === WILD) {
      wilderness.syncPlayer(e, socketsByEntity.get(e.id) ?? []);
    }
  }

  // 9. Persist immediately, so a crash in the next few seconds cannot strand
  //    anyone at a position stamped with the wrong epoch.
  flushOnlinePlayers();

  console.log(
    `[rotate] epoch ${epoch} live in ${Date.now() - startedAt}ms — seed="${seed}" `
    + `sites=${nextAtlas.sites.length} evacuated=${plan.evacuate.length} culled=${plan.cull.length}`,
  );
  return true;
}

/** Announce the upcoming rotation once per configured lead time. */
function warnBeforeRotation(): void {
  const remaining = epochEndsAt(wildEpoch, EPOCH_INTERVAL_MS) - Date.now();
  for (const lead of ROTATION_WARNINGS_MS) {
    if (remaining > lead || warnedFor.has(lead)) continue;
    warnedFor.add(lead);
    const minutes = Math.round(lead / 60_000);
    sysChat(
      `The wilds will shift in about ${minutes} minute${minutes === 1 ? '' : 's'}. `
      + 'Anyone outside the village will be returned to town.',
    );
    break;
  }
}

if (ROTATE_WILDS) {
  const endsIn = epochEndsAt(wildEpoch, EPOCH_INTERVAL_MS) - Date.now();
  const human = endsIn > 90 * 60_000
    ? `${(endsIn / 3_600_000).toFixed(1)}h`
    : `${Math.round(endsIn / 1_000)}s`;
  console.log(
    `[world] wilds epoch ${wildEpoch} ends in ~${human} (interval ${EPOCH_INTERVAL_MS}ms, `
    + `poll ${ROTATION_POLL_MS}ms) — it rotates in place, no restart needed`,
  );
  setInterval(() => {
    try {
      if (!rotateWilds(epochOf(Date.now(), EPOCH_INTERVAL_MS))) warnBeforeRotation();
    } catch (err) {
      console.error('[rotate] unexpected failure:', err);
    }
  }, ROTATION_POLL_MS);

  // Force the next epoch on demand: `kill -USR2 <pid>`. The ops lever for
  // rolling the world early, and the only way to exercise the rotation path
  // without waiting for midnight. It advances one epoch ahead of the wall
  // clock, so the scheduled rotation resumes once the clock catches up.
  process.on('SIGUSR2', () => {
    console.log('[rotate] SIGUSR2 — forcing the next epoch');
    try { rotateWilds(wildEpoch + 1); }
    catch (err) { console.error('[rotate] forced rotation failed:', err); }
  });
}

let giverIndexCache: Record<string, string[]> | null = null;
function getGiverIndex(): Record<string, string[]> {
  if (!giverIndexCache) giverIndexCache = buildGiverIndex(world.defs.quests);
  return giverIndexCache;
}

app.get('/tilesets/:name', (req, res) => {
  const ts = world.defs.tilesets[req.params.name!];
  if (!ts) { res.status(404).end(); return; }
  res.json(ts);
});

app.get('/api/quests', (_req, res) => {
  res.json({ defs: world.defs.quests, byGiver: getGiverIndex() });
});

// The region atlas, shipped to clients as a static asset. Clients derive
// wilderness terrain from it + the shared field module; they never regenerate
// it (the determinism contract, R8.8).
app.get('/api/atlas', (_req, res) => {
  res.json(world.atlas);
});

app.get('/api/abilities', (_req, res) => {
  const out: Record<string, unknown> = {};
  for (const [id, def] of Object.entries(world.defs.abilities)) {
    if (def.actor === 'player') out[id] = def;
  }
  res.json(out);
});

app.get('/api/shop/:templateId', (req, res) => {
  const templateId = req.params.templateId!;
  const template = world.defs.mobs[templateId];
  if (!template?.shop?.length && !template?.featured_stock) { res.status(404).json({ items: [] }); return; }
  const items = (template.shop ?? []).map((entry) => {
    const base = world.defs.itemBases[entry.item];
    return {
      item: entry.item,
      price: entry.price,
      name: base?.name ?? entry.item,
      sprite: base?.sprite ?? 'item_misc',
      slot: base?.slot,
      base_damage: base?.base_damage,
      base_defense: base?.base_defense,
      base_speed: base?.base_speed,
      scaling: base?.scaling,
    };
  });
  // The rotating shelf rides along with the staple stock: one fetch. Both
  // fields are present only for a merchant that HAS a shelf, so the client can
  // tell "no shelf" from "shelf sold out" without combining two checks.
  res.json(template.featured_stock
    ? { items, featured: featuredStockFor(world.defs, templateId), refreshAt: featuredRefreshAt() }
    : { items });
});

// Coords may be negative — grown worlds expand from an origin village into
// negative space (e.g. zone_0_-2). Match the sign, then offset to a 0-based grid.
const ZONE_COORD_RE = /^(zone|city|village)_(-?\d+)_(-?\d+)$/;

app.get('/api/world-map', (_req, res) => {
  // Read from the loaded definitions (populated from BOTH .yaml and .json) rather
  // than re-scanning the dir for .json only — staged FORGE runs write .yaml zones.
  const zones: { id: string; name: string; biome: string | null; gridX: number; gridY: number; type: string }[] = [];

  for (const zone of Object.values(world.defs.zones)) {
    const m = ZONE_COORD_RE.exec(zone.id);
    if (!m) continue;
    zones.push({
      id:    zone.id,
      name:  zone.display_name ?? zone.name ?? zone.id,
      biome: zone.biome ?? null,
      gridX: parseInt(m[2]!, 10),
      gridY: parseInt(m[3]!, 10),
      type:  m[1]!,
    });
  }

  if (!zones.length) {
    res.json({ cols: 0, rows: 0, cells: [], settlements: [] });
    return;
  }

  // Offset every coord by the min so a world spanning negative coords still maps
  // onto a 0-based grid. originX/originY let the client translate a player's raw
  // zone coords back into cell indices.
  const minX = Math.min(...zones.map(z => z.gridX));
  const minY = Math.min(...zones.map(z => z.gridY));
  const maxX = Math.max(...zones.map(z => z.gridX));
  const maxY = Math.max(...zones.map(z => z.gridY));
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;

  const cells: (null | { worldBiome: string; zoneName: string; zoneId: string })[][] =
    Array.from({ length: rows }, () => Array(cols).fill(null));
  const settlements: { type: string; gridX: number; gridY: number; name: string }[] = [];

  for (const z of zones) {
    const col = z.gridX - minX, row = z.gridY - minY;
    cells[row]![col] = { worldBiome: z.biome ?? 'plains', zoneName: z.name, zoneId: z.id };
    // A settlement is flagged by biome (grown/forged worlds name every zone
    // zone_X_Y) or by id prefix (hand-built worlds use village_/city_ ids).
    const kind = (z.biome === 'village' || z.biome === 'city') ? z.biome
      : (z.type === 'village' || z.type === 'city') ? z.type : null;
    if (kind) {
      settlements.push({ type: kind, gridX: col, gridY: row, name: z.name });
    }
  }

  res.json({ cols, rows, originX: minX, originY: minY, cells, settlements });
});

app.get('/api/players', (_req, res) => {
  const players: { id: string; name: string; zone: string; x: number; y: number; level: number; klass: string }[] = [];
  for (const [entityId] of playerMeta) {
    const e = world.entities.get(entityId);
    if (!e || e.type !== 'player') continue;
    players.push({
      id: entityId,
      name: e.name,
      zone: e.position.zone,
      // Wilderness coords are signed world tiles and are the only way to name a
      // spot out there (no zone id to read) — the panel shows them for WILD.
      x: e.position.x,
      y: e.position.y,
      level: e.components.progress?.level ?? 1,
      klass: e.klass,
    });
  }
  res.json({ players });
});

const socketsByEntity = new Map<string, Set<string>>();

/** Moves a player's socket rooms and client view from one zone to another.
 *  Shared by the loop's zone_change event (portals, edge walks) and the /tp
 *  command path, so teleporting handles the wilderness the same way walking
 *  into it does: chunk subscriptions, the shared 'wild' room, and the client's
 *  wilderness render mode. */
function applyZoneChange(entityId: string, from: string, to: string): void {
  const sockets = socketsByEntity.get(entityId);
  const player = world.entities.get(entityId);
  if (sockets) {
    // Leaving the wilderness: drop chunk subscriptions before entering the zone.
    if (from === WILD) wilderness.removePlayer(entityId, sockets);
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      if (from === WILD) s.leave(WILD);
      else s.leave(from);
      if (to === WILD) {
        // Entering the wilderness: join the shared 'wild' room (zone-wide
        // combat/heal/chat broadcasts target it), switch the client to
        // wilderness render mode, then syncPlayer joins the chunk rooms.
        s.join(WILD);
        if (player && player.type === 'player') {
          s.emit('wild_enter', { x: player.position.x, y: player.position.y, self: player, tick: world.currentTick });
        }
      } else {
        s.join(to);
        const snap = world.snapshotZone(to);
        if (snap) s.emit('zone', snap);
      }
    }
    if (to === WILD && player && player.type === 'player') {
      wilderness.syncPlayer(player, sockets);
    }
  }
  // Entering a dungeon counts as finding it, even if the player never walked
  // the wilds up to its mouth (e.g. a /tp, or a portal from another zone).
  const site = world.atlas?.sites.find(st => st.id === to);
  if (site) noteDiscovery(entityId, site.id, site.name);

  // Natural checkpoint: persist on every zone transition.
  const meta = playerMeta.get(entityId);
  if (meta && player && player.type === 'player') {
    try { upsertCharacter(characterToRow(player, meta.accountId, meta.characterId, meta.slot)); }
    catch (err) { console.error('[zone_change] save failed:', (err as Error).message); }
  }
}

const CHAT_LIMIT_COUNT = 5;
const CHAT_LIMIT_WINDOW_MS = 10_000;
const chatTimestamps = new Map<string, number[]>();
function checkChatRate(entityId: string): boolean {
  const now = Date.now();
  const arr = (chatTimestamps.get(entityId) || []).filter(t => now - t < CHAT_LIMIT_WINDOW_MS);
  if (arr.length >= CHAT_LIMIT_COUNT) {
    chatTimestamps.set(entityId, arr);
    return false;
  }
  arr.push(now);
  chatTimestamps.set(entityId, arr);
  return true;
}

const BOARD_POST_COOLDOWN_MS = 60_000;
const boardPostLastAt = new Map<string, number>();

// Per-entity server-only metadata. Kept out of PlayerEntity so it never leaks
// over the wire via snapshots or the `self` event.
interface PlayerMeta { accountId: string; characterId: string; slot: 1 | 2 | 3 }
const playerMeta = new Map<string, PlayerMeta>();

// entityId -> id of the player they most recently whispered with, for /r.
const lastWhisperPartner = new Map<string, string>();

// --- Persistence: periodic autosave + graceful shutdown -------------------

const AUTOSAVE_INTERVAL_MS = Number(process.env.MMO_AUTOSAVE_INTERVAL_MS) || 30_000;

function snapshotOnlinePlayers(): CharacterRow[] {
  const rows: CharacterRow[] = [];
  for (const [entityId, meta] of playerMeta) {
    const e = world.entities.get(entityId);
    if (!e || e.type !== 'player') continue;
    rows.push(characterToRow(e, meta.accountId, meta.characterId, meta.slot));
  }
  return rows;
}

function flushOnlinePlayers(): number {
  const rows = snapshotOnlinePlayers();
  if (rows.length === 0) return 0;
  try { saveCharacters(rows); } catch (err) {
    console.error('[autosave] flush failed:', (err as Error).message);
    return 0;
  }
  return rows.length;
}

const autosaveTimer = setInterval(flushOnlinePlayers, AUTOSAVE_INTERVAL_MS);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(autosaveTimer);
  const n = flushOnlinePlayers();
  console.log(`[mmo] ${signal} received — flushed ${n} player(s), closing.`);
  try { closeDb(); } catch (err) { console.error('[shutdown] db close failed:', err); }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

let restarting = false;
async function broadcastCountdownAndRestart(): Promise<void> {
  if (restarting || shuttingDown) return;
  restarting = true;
  clearInterval(autosaveTimer);

  sysChat('Server is restarting in 10 seconds...');
  for (let i = 9; i > 0; i--) {
    await new Promise<void>(r => setTimeout(r, 1000));
    sysChat(`${i}...`);
  }
  await new Promise<void>(r => setTimeout(r, 1000));

  const n = flushOnlinePlayers();
  console.log(`[restart] flushed ${n} player(s)`);
  io.disconnectSockets(true);
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGUSR2', () => { void broadcastCountdownAndRestart(); });

io.on('connection', (socket) => {
  let entityId: string | null = null;

  socket.on('list_characters', (req, ack) => {
    void (async () => {
      try {
        let uid: string;
        let email: string | null;
        try {
          ({ uid, email } = await verifyFirebaseToken(req.firebase_token));
        } catch (err) {
          ack?.({ characters: [], error: `Auth failed: ${(err as Error).message}` });
          return;
        }
        upsertAccount({ firebase_uid: uid, email });
        const rows = getCharactersByAccount(uid);
        const characters: CharacterSummary[] = rows.map((r) => ({
          id: r.id,
          slot: r.slot,
          name: r.name,
          klass: r.klass,
          color: r.color,
          level: r.level,
          zone: r.zone,
        }));
        ack?.({ characters });
      } catch (err) {
        ack?.({ characters: [], error: 'Internal server error.' });
        console.error('[list_characters]', err);
      }
    })();
  });

  socket.on('join', (req, ack) => {
    void (async () => {
      try {
        // --- Firebase token verification ---
        let uid: string;
        let email: string | null;
        try {
          ({ uid, email } = await verifyFirebaseToken(req.firebase_token));
        } catch (err) {
          console.error('[auth] verifyFirebaseToken failed:', (err as Error).message);
          ack?.({ entityId: '', error: `Auth verification failed: ${(err as Error).message}` });
          return;
        }
        console.log('[auth] verified uid=%s email=%s', uid, email);

        // --- Ensure account row exists ---
        upsertAccount({ firebase_uid: uid, email });

        // --- Switch to a specific character if requested ---
        if (req.character_id) {
          setActiveCharacter(uid, req.character_id);
        }

        // --- Resolve or create character ---
        let record: StoredCharacterRow | undefined;


        if (!req.character_id && req.name) {
          // Explicit new-character request: create and activate it regardless of any existing active char.
          const newId = randomUUID();
          const sz = startingZone();
          const sp = world.getZoneSpawnPoint(sz);
          const cleanName = sanitizeName(req.name) || 'Hero';
          const pickedKlass: ClassId = req.klass && CLASSES[req.klass] ? req.klass : 'fighter';
          const pickedColor = /^#[0-9a-fA-F]{6}$/.test(req.color ?? '') ? req.color! : '#6ec6f0';
          upsertCharacter({
            id: newId,
            account_id: uid,
            slot: (countCharacters(uid) + 1) as 1 | 2 | 3,
            is_active: 1,
            name: cleanName,
            klass: pickedKlass,
            color: pickedColor,
            zone: sz,
            x: sp.x,
            y: sp.y,
            // Seeded here rather than in makePlayer because the login path below
            // restores equipment from the stored row wholesale, which would wipe
            // anything the entity was born holding. The weapon decides how you
            // attack (see attackAbilityFor), so this is what makes a wizard open
            // as a caster instead of a brawler.
            equipment: starterEquipment(pickedKlass),
          });
          setActiveCharacter(uid, newId);
          record = getCharacterById(newId)!;
        } else {
          record = getActiveCharacter(uid);
          if (!record) {
            // First-time user, no character yet — tell client to show character creation
            ack?.({ entityId: '', needsCharacter: true });
            return;
          }
        }

        // --- Reconstruct or create PlayerEntity ---
        // A character saved in the wilderness (zone === WILD) has no grid zone;
        // restore it at its signed world coords and resume wilderness streaming.
        let player: PlayerEntity;
        if (world.zones[record.zone] || record.zone === WILD) {
          // A save from a previous epoch points at a tile in a world that no
          // longer exists — it could now be open water, or inside a tree blob.
          // Restore those characters at the village gate instead. Enclosed
          // zones are seed-independent, so only wilderness saves are affected.
          const stale = record.zone === WILD && record.wild_epoch !== wildEpoch;
          const home = stale ? wildRestorePoint() : null;
          player = makePlayer({
            id: record.id,
            zone: home ? home.zone : record.zone,
            x: home ? home.x : record.x,
            y: home ? home.y : record.y,
            name: record.name,
            klass: record.klass,
          });
          if (stale) {
            console.log(`[join] '${record.name}' was saved in wilds epoch ${record.wild_epoch} (now ${wildEpoch}) — restored to town`);
          }
          player.color = record.color || '#6ec6f0';
          player.components.progress.level          = record.level;
          player.components.progress.xp             = record.xp;
          player.components.progress.unspent_points = record.unspent_points;
          player.components.stats.strength          = record.strength;
          player.components.stats.dexterity         = record.dexterity;
          player.components.stats.intelligence      = record.intelligence;
          player.components.stats.constitution      = record.constitution;
          const maxHp = record.max_hp;
          player.components.health.max     = maxHp;
          player.components.health.current = maxHp;
          player.components.wallet.gold = record.gold;
          try {
            const inv = JSON.parse(record.inventory_json || '[]') as (InventoryStack | null)[];
            const slots = player.components.inventory.slots;
            for (let i = 0; i < slots.length && i < inv.length; i++) slots[i] = inv[i] || null;
            const eq = JSON.parse(record.equipment_json || '{}') as Record<string, InventoryStack | null>;
            for (const slot of EQUIPMENT_SLOTS) player.components.equipment[slot] = eq[slot] || null;
            // Sale price and attack style are derived from the item's roll and
            // base, so a character saved before either was true carries stale
            // values on its stacks.
            refreshDerivedFields(player, world.defs);
            const q = JSON.parse(record.quests_json || '{"active":[],"completed":[]}') as QuestsComponent;
            player.components.quests = {
              active:    Array.isArray(q.active)    ? q.active    : [],
              completed: Array.isArray(q.completed) ? q.completed : [],
            };
            const ka = JSON.parse(record.known_abilities_json || '{}') as Record<string, number>;
            if (ka && typeof ka === 'object') {
              // Drop ability ids whose def no longer exists (renamed/removed
              // abilities left over from older saves); they can't be cast and
              // render as a blank hotbar slot.
              const defs = world.defs.abilities ?? {};
              player.components.knownAbilities = Object.fromEntries(
                Object.entries(ka).filter(([id]) => id in defs),
              );
            }
            if (record.hotbar_json) {
              const hb = JSON.parse(record.hotbar_json) as unknown;
              // Normalize to exactly ABILITY_SLOTS entries; keep only strings/null.
              // Unknown-ability filtering happens in resolveHotbar at use time.
              if (Array.isArray(hb)) {
                player.components.hotbar = Array.from({ length: ABILITY_SLOTS }, (_, i) =>
                  typeof hb[i] === 'string' ? (hb[i] as string) : null,
                );
              }
            }
          } catch {/* corrupt JSON — start clean */}
          // Backfill the class starter for characters that predate this feature.
          const starter = CLASS_STARTERS[player.klass];
          if (starter && !player.components.knownAbilities[starter]) player.components.knownAbilities[starter] = 1;
        } else {
          const sz = startingZone();
          const sp = world.getZoneSpawnPoint(sz);
          player = makePlayer({
            id: record.id,
            zone: sz, x: sp.x, y: sp.y,
            name: record.name, klass: record.klass,
          });
          player.color = record.color || '#6ec6f0';
        }

        world.addEntity(player);
        entityId = player.id;
        playerMeta.set(entityId, {
          accountId:   uid,
          characterId: record.id,
          slot:        record.slot as 1 | 2 | 3,
        });

        if (!socketsByEntity.has(entityId)) socketsByEntity.set(entityId, new Set());
        socketsByEntity.get(entityId)!.add(socket.id);
        socket.join(player.position.zone);

        // Resuming in the wilderness: no zone snapshot — switch the client to
        // wilderness render mode and stream its chunks.
        if (player.position.zone === WILD) {
          ack?.({ entityId, self: player });
          socket.emit('wild_enter', { x: player.position.x, y: player.position.y, self: player, tick: world.currentTick });
          wilderness.syncPlayer(player, socketsByEntity.get(entityId)!);
          socket.emit('quests', { quests: player.components.quests });
          socket.emit('discoveries', discoveriesPayload(record.id));
          return;
        }

        const snap = world.snapshotZone(player.position.zone);
        if (!snap) {
          console.error(`[join] no snapshot for zone '${player.position.zone}' — aborting join`);
          ack?.({ entityId: '', error: `Spawn zone '${player.position.zone}' is unavailable.` });
          return;
        }
        ack?.({ entityId, zone: snap, self: player });
        socket.emit('quests', { quests: player.components.quests });
        socket.emit('discoveries', discoveriesPayload(record.id));
      } catch (err) {
        console.error('[join] unexpected error:', err);
        ack?.({ entityId: '', error: 'Internal server error.' });
      }
    })();
  });

  socket.on('quest_action', ({ questId, action, talkingTo }, ack) => {
    if (!entityId) { ack?.({ ok: false, reason: 'not_joined' }); return; }
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') { ack?.({ ok: false, reason: 'no_entity' }); return; }
    if (typeof questId !== 'string' || typeof action !== 'string') {
      ack?.({ ok: false, reason: 'bad_args' }); return;
    }
    const beforeGold = player.components.wallet.gold;
    const beforeXp = player.components.progress.xp;
    const beforeLevel = player.components.progress.level;
    const result = handleQuestAction(
      player, world.defs.quests, questId, action,
      { talkingTo: typeof talkingTo === 'string' ? talkingTo : undefined, world },
    );
    if (result.ok) {
      socket.emit('quests', { quests: player.components.quests });
      const xpGained = player.components.progress.xp - beforeXp +
        (player.components.progress.level - beforeLevel) * 100; // rough: handles level-up xp reset
      if (player.components.wallet.gold !== beforeGold || xpGained > 0) {
        socket.emit('self', { self: player });
      }
      if (xpGained > 0) {
        socket.emit('xp', {
          gained: xpGained,
          xp: player.components.progress.xp,
          level: player.components.progress.level,
          xp_to_next: xpForNext(player.components.progress.level),
          source: { name: 'Quest', id: '' },
        });
      }
      if (player.components.progress.level > beforeLevel) {
        socket.emit('levelup', {
          level: player.components.progress.level,
          from_level: beforeLevel,
          unspent_points: player.components.progress.unspent_points,
        });
      }
    }
    ack?.(result);
  });

  socket.on('action', (msg) => {
    if (!entityId) return;
    if (msg.action === 'move' && typeof msg.dir === 'string') {
      loop.enqueue({ entityId, action: 'move', dir: msg.dir as Direction });
    } else if (msg.action === 'attack') {
      const targetId = typeof msg.targetId === 'string' ? msg.targetId : undefined;
      loop.enqueue({ entityId, action: 'attack', targetId });
    } else if (msg.action === 'ability' && typeof msg.abilityId === 'string') {
      // Gate to the player's learned abilities so a client can't cast arbitrary
      // registry abilities (rank/level/cost are enforced in executeAbility).
      const player = world.entities.get(entityId);
      const known = player?.type === 'player' && player.components.knownAbilities[msg.abilityId];
      if (known) {
        const targetId = typeof msg.targetId === 'string' ? msg.targetId : undefined;
        // Ground-targeted casts (shape 'point', e.g. blink) carry a clicked tile.
        const tx = typeof msg.tx === 'number' ? msg.tx | 0 : undefined;
        const ty = typeof msg.ty === 'number' ? msg.ty | 0 : undefined;
        loop.enqueue({ entityId, action: 'ability', abilityId: msg.abilityId, targetId, tx, ty });
      }
    } else if (msg.action === 'autopath' && typeof msg.tx === 'number' && typeof msg.ty === 'number') {
      const chaseTargetId = typeof msg.chaseTargetId === 'string' ? msg.chaseTargetId : undefined;
      loop.enqueue({ entityId, action: 'autopath', tx: msg.tx | 0, ty: msg.ty | 0, chaseTargetId });
    }
  });

  function runPlayerOp<R extends { ok: boolean; reason?: string }>(
    ack: ((r: { ok: boolean; reason?: string; self?: PlayerEntity }) => void) | undefined,
    op: (p: PlayerEntity) => R,
  ): void {
    if (!entityId) { ack?.({ ok: false, reason: 'not_joined' }); return; }
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') { ack?.({ ok: false, reason: 'no_entity' }); return; }
    const res = op(player);
    if (res?.ok) {
      emitToEntity(entityId, 'self', { self: player });
      loop.markZoneDirty(player.position.zone);
    }
    ack?.({ ...res, self: player });
  }

  socket.on('allocate', ({ stat }, ack) => {
    runPlayerOp(ack, (player) => ({ ok: allocateStat(player, stat as StatId) }));
  });

  socket.on('equip', ({ slot }, ack) => {
    runPlayerOp(ack, (player) => equipFromSlot(player, Number(slot), world.defs));
  });

  socket.on('unequip', ({ slot }, ack) => {
    if (typeof slot !== 'string') { ack?.({ ok: false, reason: 'missing_slot' }); return; }
    runPlayerOp(ack, (player) => unequipSlot(player, slot as EquipSlot));
  });

  socket.on('drop_item', ({ slot }, ack) => {
    runPlayerOp(ack, (player) => dropFromSlot(world, player, Number(slot)));
  });

  socket.on('chat', (msg) => {
    if (!entityId) return;
    const text = typeof msg?.text === 'string' ? msg.text.trim().slice(0, 200) : '';
    if (!text) return;
    if (!checkChatRate(entityId)) return;
    const sender = world.entities.get(entityId);
    if (!sender) return;

    const toSender = (line: string) => socket.emit('chat', {
      from: { id: 'system', name: 'System', type: 'player' as const },
      text: line, at: Date.now(),
    });

    const cmd = parseCommand(text);
    if (cmd && !['g', 'global', 'w', 'whisper', 'r', 'reply'].includes(cmd.name)) {
      if (sender.type !== 'player') return;
      const def = getCommand(cmd.name);
      if (!def) { toSender(`Unknown command: /${cmd.name}`); return; }
      const result = def.handler({ player: sender, world, args: cmd.args });
      if (result.error) { toSender(result.error); return; }
      if (result.message) toSender(result.message);
      if (result.openMap) socket.emit('open_map');
      if (result.refreshSelf) {
        socket.emit('self', { self: sender });
        socket.emit('quests', { quests: sender.components.quests });
        loop.markZoneDirty(sender.position.zone);
      }
      if (result.persist) {
        const meta = playerMeta.get(entityId);
        if (meta) {
          try { upsertCharacter(characterToRow(sender, meta.accountId, meta.characterId, meta.slot)); }
          catch (err) { console.error('[command] persist failed:', (err as Error).message); }
        }
      }
      if (result.teleported) {
        const { fromZone, toZone } = result.teleported;
        if (fromZone !== toZone) {
          applyZoneChange(entityId, fromZone, toZone);
        } else {
          // Same-zone jump: no room changes, but the client still needs its own
          // new position, and in the wilds the chunk subscriptions have to
          // follow the jump the way syncPlayer follows a walk.
          socket.emit('self', { self: sender });
          if (toZone === WILD) wilderness.syncPlayer(sender, socketsByEntity.get(entityId) ?? []);
        }
        loop.markZoneDirty(fromZone);
        loop.markZoneDirty(toZone);
      }
      return;
    }

    // Global channel: /g <message>
    if (/^\/g(?:lobal)? /i.test(text)) {
      const body = text.replace(/^\/g(?:lobal)? /i, '').trim();
      if (!body) return;
      io.emit('chat', {
        from: { id: sender.id, name: sender.name, type: sender.type },
        text: body, at: Date.now(), channel: 'global' as const,
      });
      return;
    }

    // Whisper: /w <name> <message>
    if (/^\/w(?:hisper)? /i.test(text)) {
      const rest = text.replace(/^\/w(?:hisper)? /i, '');
      const space = rest.indexOf(' ');
      if (space === -1) { toSender('Usage: /w <name> <message>'); return; }
      const targetName = rest.slice(0, space).toLowerCase();
      const body = rest.slice(space + 1).trim();
      if (!body) return;

      let targetId: string | null = null;
      for (const [eid] of playerMeta) {
        const e = world.entities.get(eid);
        if (e && e.name.toLowerCase() === targetName) { targetId = eid; break; }
      }
      if (!targetId) { toSender(`Player "${rest.slice(0, space)}" not found or offline.`); return; }
      if (targetId === entityId) { toSender('You cannot whisper to yourself.'); return; }

      const targetEntity = world.entities.get(targetId)!;
      const from = { id: sender.id, name: sender.name, type: sender.type };
      const at = Date.now();

      // Deliver to target
      emitToEntity(targetId, 'chat', { from, text: body, at, channel: 'whisper' as const });
      // Echo to sender so they see what they sent
      socket.emit('chat', { from, text: `(to ${targetEntity.name}) ${body}`, at, channel: 'whisper' as const });
      lastWhisperPartner.set(entityId, targetId);
      lastWhisperPartner.set(targetId, entityId);
      return;
    }

    // Reply: /r <message> — routes to the last whisper partner
    if (/^\/r(?:eply)? /i.test(text)) {
      const body = text.replace(/^\/r(?:eply)? /i, '').trim();
      if (!body) return;

      const targetId = lastWhisperPartner.get(entityId);
      if (!targetId || !world.entities.get(targetId) || !playerMeta.has(targetId)) {
        toSender('No one to reply to.');
        return;
      }

      const targetEntity = world.entities.get(targetId)!;
      const from = { id: sender.id, name: sender.name, type: sender.type };
      const at = Date.now();

      emitToEntity(targetId, 'chat', { from, text: body, at, channel: 'whisper' as const });
      socket.emit('chat', { from, text: `(to ${targetEntity.name}) ${body}`, at, channel: 'whisper' as const });
      lastWhisperPartner.set(entityId, targetId);
      lastWhisperPartner.set(targetId, entityId);
      return;
    }

    io.to(sender.position.zone).emit('chat', {
      from: { id: sender.id, name: sender.name, type: sender.type },
      text,
      at: Date.now(),
    });
  });

  socket.on('poke_mob', ({ mobId }) => {
    if (!entityId) return;
    const player = world.entities.get(entityId);
    if (!player) return;
    const mob = world.entities.get(mobId);
    if (!mob || mob.type !== 'mob') return;
    if (mob.position.zone !== player.position.zone) return;
    if ((mob.components.health?.current ?? 0) <= 0) return;
    const lines = mob.dialogue;
    if (!lines || lines.length === 0) return;
    const text = lines[Math.floor(Math.random() * lines.length)]!;
    io.to(mob.position.zone).emit('chat', {
      from: { id: mob.id, name: mob.name, type: mob.type },
      text,
      at: Date.now(),
    });
  });

  socket.on('trade', (msg: TradeMessage, ack: (r: TradeResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });

    const mob = world.entities.get(msg.mobId);
    if (!mob || mob.type !== 'mob') return ack({ ok: false, reason: 'no_mob' });
    if (mob.position.zone !== player.position.zone) return ack({ ok: false, reason: 'out_of_range' });
    const dist = Math.max(Math.abs(player.position.x - mob.position.x), Math.abs(player.position.y - mob.position.y));
    if (dist > 2) return ack({ ok: false, reason: 'out_of_range' });

    const templateId = mob.components.ai?.template_id ?? '';
    const template = world.defs.mobs[templateId];
    if (!template?.shop?.length && !template?.featured_stock) return ack({ ok: false, reason: 'no_shop' });

    if (msg.action === 'buy') {
      // Resolve the two kinds of row — a staple base at a fixed price, or one
      // specific rolled item off the featured shelf — down to a price and a way
      // to obtain the stack, so gold is spent in exactly one place. `take` runs
      // only once the sale is certain: for a featured row it splices the shelf,
      // which is destructive and there's only ever one copy.
      const wallet = player.components.wallet;
      const slots = player.components.inventory.slots;
      let price: number;
      let take: () => InventoryStack;
      if (msg.featuredId) {
        const shelf = featuredStockFor(world.defs, templateId);
        const i = shelf.findIndex((e) => e.id === msg.featuredId);
        if (i === -1) return ack({ ok: false, reason: 'sold_out' });
        price = shelf[i]!.price;
        take = () => shelf.splice(i, 1)[0]!.stack;
      } else {
        const entry = template.shop?.find((s) => s.item === msg.itemBase);
        if (!entry) return ack({ ok: false, reason: 'not_for_sale' });
        if (!world.defs.itemBases[entry.item]) return ack({ ok: false, reason: 'unknown_item' });
        price = entry.price;
        take = () => makeStack(world.defs, entry.item, null);
      }
      if (wallet.gold < price) return ack({ ok: false, reason: 'insufficient_gold' });
      const freeSlot = slots.findIndex((sl) => !sl);
      if (freeSlot === -1) return ack({ ok: false, reason: 'inventory_full' });

      wallet.gold -= price;
      slots[freeSlot] = take();
      emitToEntity(entityId, 'self', { self: player });
      return ack({ ok: true, self: player });
    }

    if (msg.action === 'sell') {
      if (typeof msg.slotIndex !== 'number') return ack({ ok: false, reason: 'no_slot' });
      const slots = player.components.inventory.slots;
      const stack = slots[msg.slotIndex];
      if (!stack) return ack({ ok: false, reason: 'empty_slot' });
      // Priced off the item's rolled budget, recomputed here rather than read
      // off the stack — the stamped `sell_value` is a display hint the client
      // can hold a stale copy of, this is the number that moves gold.
      const sellPrice = sellPriceOf(stack, world.defs);
      if (sellPrice === null) return ack({ ok: false, reason: 'cannot_sell' });
      player.components.wallet.gold += sellPrice;
      slots[msg.slotIndex] = null;
      emitToEntity(entityId, 'self', { self: player });
      return ack({ ok: true, self: player });
    }

    ack({ ok: false, reason: 'unknown_action' });
  });

  // --- Class trainers (learn / rank up abilities for gold) ------------------
  // Resolve the trainer mob the player is standing next to, sharing the trade
  // handler's proximity rules. Returns the mob template's trainer class or an
  // error reason.
  function resolveTrainer(mobId: string): { ok: true; player: PlayerEntity; trainerClass: ClassId } | { ok: false; reason: string } {
    const player = world.entities.get(entityId!);
    if (!player || player.type !== 'player') return { ok: false, reason: 'not_player' };
    const mob = world.entities.get(mobId);
    if (!mob || mob.type !== 'mob') return { ok: false, reason: 'no_mob' };
    if (mob.position.zone !== player.position.zone) return { ok: false, reason: 'out_of_range' };
    const dist = Math.max(Math.abs(player.position.x - mob.position.x), Math.abs(player.position.y - mob.position.y));
    if (dist > 2) return { ok: false, reason: 'out_of_range' };
    const template = world.defs.mobs[mob.components.ai?.template_id ?? ''];
    if (!template?.trainer) return { ok: false, reason: 'no_trainer' };
    return { ok: true, player, trainerClass: template.trainer.class };
  }

  // The abilities this trainer offers THIS player: globals always, plus the
  // class set only when the trainer's class matches the player's (hard gating).
  function trainerAbilitiesFor(player: PlayerEntity, trainerClass: ClassId): AbilityDef[] {
    return Object.values(world.defs.abilities).filter((a) =>
      a.actor === 'player' && a.ranks &&
      (a.class === 'global' || (a.class === trainerClass && a.class === player.klass)));
  }

  socket.on('train_list', (msg: { mobId: string }, ack: (r: TrainListResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const t = resolveTrainer(msg.mobId);
    if (!t.ok) return ack({ ok: false, reason: t.reason });
    const { player } = t;
    const level = player.components.progress.level;
    const gold = player.components.wallet.gold;
    const offers: TrainOffer[] = trainerAbilitiesFor(player, t.trainerClass).map((a) => {
      const currentRank = player.components.knownAbilities[a.id] ?? 0;
      const next = a.ranks![currentRank]; // ranks[0] is rank 1; currentRank doubles as the next index
      const offer: TrainOffer = { abilityId: a.id, name: a.name, currentRank };
      if (next) {
        offer.nextRank = next.rank;
        offer.costGold = next.cost_gold;
        offer.requiresLevel = next.requires_level;
        if (level < next.requires_level) offer.locked = 'under_level';
        else if (gold < next.cost_gold) offer.locked = 'insufficient_gold';
      }
      return offer;
    });
    offers.sort((a, b) => a.name.localeCompare(b.name));
    ack({ ok: true, offers });
  });

  socket.on('train', (msg: TrainMessage, ack: (r: TrainResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const t = resolveTrainer(msg.mobId);
    if (!t.ok) return ack({ ok: false, reason: t.reason });
    const { player, trainerClass } = t;

    const ability = world.defs.abilities[msg.abilityId];
    if (!ability || ability.actor !== 'player' || !ability.ranks) return ack({ ok: false, reason: 'unknown_ability' });
    // Hard class gate: globals from any trainer; class abilities only from your
    // own class's trainer.
    if (!(ability.class === 'global' || (ability.class === trainerClass && ability.class === player.klass))) {
      return ack({ ok: false, reason: 'wrong_class' });
    }
    const currentRank = player.components.knownAbilities[msg.abilityId] ?? 0;
    const next = ability.ranks[currentRank];
    if (!next) return ack({ ok: false, reason: 'max_rank' });
    if (player.components.progress.level < next.requires_level) return ack({ ok: false, reason: 'under_level' });
    if (player.components.wallet.gold < next.cost_gold) return ack({ ok: false, reason: 'insufficient_gold' });

    player.components.wallet.gold -= next.cost_gold;
    player.components.knownAbilities[msg.abilityId] = next.rank; // auto-equipped: hotbar derives from knownAbilities
    // If the player has a custom layout, drop a newly-learned ability into the
    // first empty slot (an unedited hotbar derives from knownAbilities anyway).
    if (player.components.hotbar) equipInFirstEmpty(player.components.hotbar, msg.abilityId);
    emitToEntity(entityId, 'self', { self: player });
    return ack({ ok: true, self: player, rank: next.rank });
  });

  socket.on('set_hotbar', ({ hotbar }, ack) => {
    runPlayerOp(ack, (player) => {
      if (!Array.isArray(hotbar) || hotbar.length !== ABILITY_SLOTS) {
        return { ok: false, reason: 'bad_layout' };
      }
      // Every non-null entry must be an ability the player actually knows.
      for (const id of hotbar) {
        if (id !== null && !player.components.knownAbilities[id]) {
          return { ok: false, reason: 'not_learned' };
        }
      }
      player.components.hotbar = hotbar.map((id) => (typeof id === 'string' ? id : null));
      return { ok: true };
    });
  });

  socket.on('use_item', (msg, ack: (r: UseItemResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });

    const slots = player.components.inventory.slots;
    const stack = slots[msg.slot];
    if (!stack) return ack({ ok: false, reason: 'empty_slot' });

    const base = world.defs.itemBases[stack.base];
    if (!base?.use_effect) return ack({ ok: false, reason: 'not_usable' });

    // Scrolls resolve BEFORE anything is spent, so a scroll with nothing left to
    // do stays in the bag rather than burning for a shrug (see ScrollEffect).
    // Only `scribe` exists today; a second kind branches here.
    const meta = playerMeta.get(entityId);
    let justRevealed: { id: string; name: string; x: number; y: number } | undefined;
    if (base.use_effect.scroll) {
      if (!meta) return ack({ ok: false, reason: 'not_joined' });
      // Already-charted sites count as known: a second scroll should chart a
      // second place, not re-sell the one you are holding.
      const known = new Set([
        ...getDiscoveries(meta.characterId),
        ...revealedSites(meta.characterId, wildEpoch),
      ]);
      const site = pickRevealTarget(world.atlas?.sites ?? [], known);
      if (!site) return ack({ ok: false, reason: 'nothing_to_reveal' });
      revealSite(meta.characterId, wildEpoch, site.id);
      justRevealed = { id: site.id, name: site.name, x: site.worldX, y: site.worldY };
    }

    let healed = 0;
    if (base.use_effect.heal !== undefined) {
      const h = base.use_effect.heal;
      const amount = Array.isArray(h)
        ? h[0] + Math.floor(Math.random() * (h[1] - h[0] + 1))
        : h;
      const health = player.components.health;
      const prev = health.current;
      health.current = Math.min(health.max, health.current + amount);
      healed = health.current - prev;
    }

    let restored = 0;
    if (base.use_effect.mana !== undefined) {
      const m = base.use_effect.mana;
      const amount = Array.isArray(m)
        ? m[0] + Math.floor(Math.random() * (m[1] - m[0] + 1))
        : m;
      const mana = player.components.mana;
      if (mana) {
        const prev = mana.current;
        mana.current = Math.min(mana.max, mana.current + amount);
        restored = mana.current - prev;
      }
    }

    if (base.use_effect.modifier) {
      const mod = base.use_effect.modifier;
      (player.components.modifiers ??= []).push({
        source: entityId,
        stats: mod.stats,
        expiresAt: loop.tick + mod.duration_ticks,
        cc: mod.cc,
      });
    }

    slots[msg.slot] = null;
    emitToEntity(entityId, 'self', { self: player });
    if (justRevealed && meta) {
      emitToEntity(entityId, 'discoveries', {
        ...discoveriesPayload(meta.characterId),
        justRevealed,
      });
    }
    loop.markZoneDirty(player.position.zone);
    return ack({ ok: true, self: player, healed, restored });
  });

  socket.on('loot_corpse', (msg, ack: (r: LootCorpseResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const corpseEntity = world.entities.get(msg.corpseId);
    if (!corpseEntity || corpseEntity.type !== 'corpse') return ack({ ok: false, reason: 'not_found' });
    const corpse = corpseEntity as CorpseEntity;
    const playerEntity = world.entities.get(entityId);
    if (!playerEntity || playerEntity.type !== 'player') return ack({ ok: false, reason: 'not_player' });
    const player: PlayerEntity = playerEntity;
    const dist = Math.max(
      Math.abs(player.position.x - corpse.position.x),
      Math.abs(player.position.y - corpse.position.y),
    );
    if (dist > 2) return ack({ ok: false, reason: 'too_far' });

    function takeSlot(slot: LootSlot): boolean {
      if (slot.gold > 0) {
        player.components.wallet.gold += slot.gold;
        return true;
      }
      if (slot.item) {
        const inv = player.components.inventory.slots;
        const freeIdx = inv.findIndex((s: InventoryStack | null) => s === null);
        if (freeIdx === -1) return false;
        inv[freeIdx] = makeStack(world.defs, slot.base, slot.item, { name: slot.name });
        const r = notifyPickup(player, world.defs.quests, slot.base, 1);
        emitQuestRewards(player, r);
        return true;
      }
      return true;
    }

    if (msg.slotId === 'all') {
      const remaining: LootSlot[] = [];
      for (const slot of corpse.loot) {
        if (!takeSlot(slot)) remaining.push(slot);
      }
      corpse.loot = remaining;
    } else {
      const idx = corpse.loot.findIndex((s) => s.id === msg.slotId);
      if (idx === -1) return ack({ ok: false, reason: 'slot_not_found' });
      if (!takeSlot(corpse.loot[idx]!)) return ack({ ok: false, reason: 'inventory_full' });
      corpse.loot.splice(idx, 1);
    }

    if (corpse.loot.length === 0) loop.corpseEmptiedTick.set(corpse.id, loop.tick);
    loop.markZoneDirty(corpse.position.zone);
    return ack({ ok: true, self: player });
  });

  socket.on('read_board', ({ boardId }, ack: (r: ReadBoardResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    if (typeof boardId !== 'string' || !boardId) return ack({ ok: false, reason: 'bad_args' });
    try {
      const rows = getBoardMessages(boardId);
      const messages = rows.map(r => ({
        id: r.id,
        authorName: r.author_name,
        text: r.text,
        postedAt: r.posted_at,
      }));
      return ack({ ok: true, messages });
    } catch (err) {
      console.error('[read_board]', err);
      return ack({ ok: false, reason: 'server_error' });
    }
  });

  socket.on('post_to_board', ({ boardId, text }, ack: (r: PostBoardResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });
    if (typeof boardId !== 'string' || !boardId) return ack({ ok: false, reason: 'bad_args' });
    if (typeof text !== 'string') return ack({ ok: false, reason: 'bad_args' });
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!trimmed) return ack({ ok: false, reason: 'empty' });
    if (trimmed.length > 200) return ack({ ok: false, reason: 'too_long' });

    // Verify board entity exists and player is in range.
    // boardId is zone-scoped ("zoneId:board_id"); match on both parts.
    const colonIdx = boardId.indexOf(':');
    const boardZone = colonIdx >= 0 ? boardId.slice(0, colonIdx) : '';
    const boardTemplate = colonIdx >= 0 ? boardId.slice(colonIdx + 1) : boardId;
    let boardInRange = false;
    for (const e of world.entities.values()) {
      if (e.type !== 'mob') continue;
      if (e.components.ai?.board_id !== boardTemplate) continue;
      if (e.position.zone !== player.position.zone) continue;
      if (boardZone && e.position.zone !== boardZone) continue;
      const dist = Math.max(Math.abs(player.position.x - e.position.x), Math.abs(player.position.y - e.position.y));
      if (dist <= 2) { boardInRange = true; break; }
    }
    if (!boardInRange) return ack({ ok: false, reason: 'out_of_range' });

    // Rate limit: one post per minute per player
    const last = boardPostLastAt.get(entityId) ?? 0;
    if (Date.now() - last < BOARD_POST_COOLDOWN_MS) {
      return ack({ ok: false, reason: 'rate_limited' });
    }
    boardPostLastAt.set(entityId, Date.now());

    try {
      postBoardMessage(boardId, player.name, trimmed);
      return ack({ ok: true });
    } catch (err) {
      console.error('[post_to_board]', err);
      return ack({ ok: false, reason: 'server_error' });
    }
  });

  socket.on('disconnect', () => {
    if (!entityId) return;
    const set = socketsByEntity.get(entityId);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      const e = world.entities.get(entityId);
      if (e && e.type === 'player') {
        const meta = playerMeta.get(entityId);
        if (meta) {
          try { upsertCharacter(characterToRow(e, meta.accountId, meta.characterId, meta.slot)); }
          catch (err) { console.error('[disconnect] save failed:', (err as Error).message); }
        }
        if (e.position.zone === WILD) wilderness.removePlayer(entityId, socketsByEntity.get(entityId) ?? []);
        world.removeEntity(entityId);
      }
      socketsByEntity.delete(entityId);
      chatTimestamps.delete(entityId);
      playerMeta.delete(entityId);
      lastWhisperPartner.delete(entityId);
      if (e) loop.markZoneDirty(e.position.zone);
    }
  });
});

function sanitizeName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : null;
}

function characterToRow(
  player: PlayerEntity,
  accountId: string,
  characterId: string,
  slot: number,
): CharacterRow {
  const c = player.components;
  return {
    id:          characterId,
    account_id:  accountId,
    slot:        slot as 1 | 2 | 3,
    is_active:   1,
    name:        player.name  || 'Hero',
    klass:       player.klass || 'fighter',
    color:       player.color || '#6ec6f0',
    zone:        player.position.zone,
    x:           player.position.x,
    y:           player.position.y,
    level:       c.progress?.level          ?? 1,
    xp:          c.progress?.xp             ?? 0,
    max_hp:      c.health?.max              ?? 100,
    strength:    c.stats?.strength          ?? 5,
    dexterity:   c.stats?.dexterity         ?? 5,
    intelligence: c.stats?.intelligence     ?? 5,
    constitution: c.stats?.constitution     ?? 5,
    unspent_points: c.progress?.unspent_points ?? 0,
    gold:        c.wallet?.gold             ?? 0,
    inventory:   c.inventory?.slots         ?? [],
    equipment:   c.equipment               ?? {} as Equipment,
    quests:      c.quests                  ?? { active: [], completed: [] },
    known_abilities: c.knownAbilities       ?? {},
    hotbar:      c.hotbar                   ?? null,
    wild_epoch:  wildEpoch,
  };
}

/** Where a character saved in a previous epoch's wilds comes back: just inside
 *  the central village's primary gate — the one place guaranteed to exist and
 *  be walkable in every epoch. */
function wildRestorePoint(): { zone: string; x: number; y: number } {
  const st = world.atlas?.settlements[0];
  const gate = st?.gates[0];
  if (st && gate && world.zones[st.id]) return { zone: st.id, x: gate.returnX, y: gate.returnY };
  const zone = startingZone();
  const sp = world.getZoneSpawnPoint(zone);
  return { zone, x: sp.x, y: sp.y };
}

// How close a player must come to a dungeon entrance to have "found" it. Two
// chunks-ish — you have to actually walk up on it, not stream it from across
// the map, but you don't have to step inside.
const DISCOVERY_RADIUS = 14;

/** Every map marker this character is entitled to: the permanent discoveries
 *  plus this epoch's scroll reveals. Both lists ride EVERY `discoveries` event
 *  so the client mirrors them wholesale — an event carrying only one of them
 *  would silently wipe the other. */
function discoveriesPayload(characterId: string): DiscoveriesEvent {
  return {
    ids: getDiscoveries(characterId),
    revealed: revealedSites(characterId, wildEpoch),
  };
}

/** Record + announce a first sighting. Idempotent: after the first call for a
 *  (character, site) pair this is a no-op, so it's safe to call every move. */
function noteDiscovery(entityId: string, siteId: string, siteName: string): void {
  const meta = playerMeta.get(entityId);
  if (!meta) return;
  try {
    if (!recordDiscovery(meta.characterId, siteId)) return;
    emitToEntity(entityId, 'discoveries', {
      ...discoveriesPayload(meta.characterId),
      justFound: { id: siteId, name: siteName },
    });
  } catch (err) { console.error('[discovery] save failed:', (err as Error).message); }
}

/** Any dungeon entrance close enough to (x,y) to count as sighted. */
function checkWildDiscoveries(entityId: string, x: number, y: number): void {
  for (const site of world.atlas?.sites ?? []) {
    if (Math.hypot(site.worldX - x, site.worldY - y) <= DISCOVERY_RADIUS) {
      noteDiscovery(entityId, site.id, site.name);
    }
  }
}

function broadcastZone(zoneId: string): void {
  const snap = world.snapshotZone(zoneId);
  if (!snap) return;
  io.to(zoneId).emit('zone', snap);
}

httpServer.listen(PORT, () => {
  console.log(`[mmo] listening on http://localhost:${PORT} (autosave every ${AUTOSAVE_INTERVAL_MS}ms)`);
  writeFileSync(join(ROOT, '.game.pid'), String(process.pid));
});
