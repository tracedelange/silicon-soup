// Client-side continuous wilderness (docs/rework.md §8.2). Terrain is derived
// locally from the SAME shared field module the server validates against
// (determinism contract, R8.7); only entities arrive over the wire, per chunk.

import { state } from './state.ts';
import { CHUNK_SIZE, WILD } from '../../shared/worldgen/config.ts';
import { deriveSeeds, isWildBlocked, wildTileAt, type FieldSeeds } from '../../shared/worldgen/field.ts';
import type { RegionAtlas } from '../../shared/worldgen/atlas.ts';
import type {
  ActiveZoneSnapshot, DiscoveriesEvent, EntitySnapshot, WildChunkEvent, WildEnterEvent, WildResetEvent,
} from '../../shared/types.ts';

const BACKEND = import.meta.env.VITE_SERVER_URL ?? '';

let atlas: RegionAtlas | null = null;
let seeds: FieldSeeds | null = null;

// Per-chunk derived tile-id cache (R8.4: compute terrain once per chunk, not
// per frame). Keyed by "cx,cy"; flat array indexed (ly*CHUNK_SIZE + lx).
const tileCache = new Map<string, string[]>();
// Entities streamed per chunk; full-replace semantics from wild_chunk.
const chunkEntities = new Map<string, EntitySnapshot[]>();
// Active ground zones streamed per chunk, same full-replace semantics.
const chunkActiveZones = new Map<string, ActiveZoneSnapshot[]>();
// Named dungeons/POIs this character has discovered, from the server (see
// DiscoveriesEvent). Permanent and cross-epoch: the world map draws a marker
// for each of these at whatever position the CURRENT atlas gives it. There is
// deliberately no per-chunk "explored" set — the wilds re-roll on the epoch
// clock, so exploration fog would be wiped daily and could never mean anything.
const discovered = new Set<string>();
// Sites merely CHARTED by a scribe's scroll: a position for this epoch only,
// mirrored from the same event as `discovered` and drawn differently on the
// map. Unlike `discovered` these ARE keyed to the current world, so they go
// with it at the rotation (see onWildReset).
const revealed = new Set<string>();

export const chunkOf = (x: number, y: number) => ({
  cx: Math.floor(x / CHUNK_SIZE),
  cy: Math.floor(y / CHUNK_SIZE),
});
const key = (cx: number, cy: number) => `${cx},${cy}`;

export function isWild(): boolean {
  return state.zone?.id === WILD;
}

export async function ensureAtlas(): Promise<void> {
  if (atlas) return;
  const r = await fetch(`${BACKEND}/api/atlas`);
  if (!r.ok) { console.error('[wild] atlas fetch failed', r.status); return; }
  atlas = await r.json() as RegionAtlas;
  seeds = deriveSeeds(atlas.numericSeed);
}

// One-entry memo in front of tileCache. The renderer and minimap sweep tiles in
// scanline order, so consecutive calls almost always land in the same chunk —
// this skips rebuilding the "cx,cy" string key (an allocation) thousands of
// times per frame.
let lastCx = NaN, lastCy = NaN;
let lastTiles: string[] | null = null;

/** Tile id at a signed world coord. Caches a whole chunk on first touch. */
export function wildTile(x: number, y: number): string {
  if (!seeds) return 'void';
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  if (cx === lastCx && cy === lastCy && lastTiles) return lastTiles[ly * CHUNK_SIZE + lx]!;
  const k = key(cx, cy);
  let tiles = tileCache.get(k);
  if (!tiles) {
    tiles = new Array(CHUNK_SIZE * CHUNK_SIZE);
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        tiles[ly * CHUNK_SIZE + lx] = wildTileAt(ox + lx, oy + ly, seeds, atlas ?? undefined);
      }
    }
    tileCache.set(k, tiles);
  }
  lastCx = cx; lastCy = cy; lastTiles = tiles;
  return tiles[ly * CHUNK_SIZE + lx]!;
}

// Any eviction from tileCache must drop the memo too, or a stale chunk survives.
function invalidateTileMemo(): void { lastCx = NaN; lastCy = NaN; lastTiles = null; }

/** Whether a wilderness tile blocks movement (client-side prediction; the
 *  server is authoritative). Mirrors World.canMoveTo's wild branch. */
export function wildWalkable(x: number, y: number): boolean {
  return !isWildBlocked(wildTile(x, y), atlas ?? undefined);
}

/** All currently-streamed wilderness entities, flattened for render/pick. */
export function wildEntities(): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  for (const list of chunkEntities.values()) out.push(...list);
  return out;
}

/** All currently-streamed wilderness ground zones, flattened for render. */
export function wildActiveZones(): ActiveZoneSnapshot[] {
  const out: ActiveZoneSnapshot[] = [];
  for (const list of chunkActiveZones.values()) out.push(...list);
  return out;
}

// ── Socket handlers ──────────────────────────────────────────────────────────

export async function onWildEnter(ev: WildEnterEvent): Promise<void> {
  await ensureAtlas();
  chunkEntities.clear();
  chunkActiveZones.clear();
  state.self = ev.self;
  // A minimal stub stands in for state.zone so the existing render guard passes;
  // id === WILD switches every wilderness-aware branch.
  state.zone = {
    id: WILD,
    name: 'The Wilds',
    width: 0,
    height: 0,
    grid: [],
    entities: [],
    tileset: 'overworld',
    no_edge_haze: true,
    timeOfDay: 0.5,
    tick: ev.tick,
  };
  // Seeds the same tick-extrapolation baseline applyZoneSnap sets for regular
  // zones, so status-effect countdowns and zone-fade timing work here too.
  state._zoneSnapshotAtMs = performance.now();
  window.dispatchEvent(new CustomEvent('mmo:zone'));
  window.dispatchEvent(new CustomEvent('mmo:self'));
}

/** Site ids this character has discovered, across all epochs. */
export function discoveredSites(): ReadonlySet<string> { return discovered; }

/** Site ids charted for this epoch only (a scribe's scroll), never discovered. */
export function revealedSites(): ReadonlySet<string> { return revealed; }

export function onDiscoveries(ev: DiscoveriesEvent): void {
  discovered.clear();
  for (const id of ev.ids) discovered.add(id);
  // Both sets ride every event in full, so mirroring wholesale is correct and
  // an absent `revealed` means "none", not "unchanged".
  revealed.clear();
  for (const id of ev.revealed ?? []) revealed.add(id);
  window.dispatchEvent(new CustomEvent('mmo:discoveries', { detail: ev }));
}

/** The loaded region atlas (settlements, sites, danger radius), or null pre-load. */
export function getWildAtlas(): RegionAtlas | null { return atlas; }
/** Field seeds for the loaded atlas — lets the world map derive coarse terrain
 *  for places the player has never been, which is the whole point of having an
 *  atlas client-side. */
export function getWildSeeds(): FieldSeeds | null { return seeds; }

export function onWildChunk(ev: WildChunkEvent): void {
  chunkEntities.set(key(ev.cx, ev.cy), ev.entities);
  chunkActiveZones.set(key(ev.cx, ev.cy), ev.activeZones);
  // Refresh the tick baseline on every chunk update — wild_chunk is the
  // wilderness's per-tick "snapshot" equivalent to a regular zone's 'zone' event.
  if (state.zone?.id === WILD) state.zone.tick = ev.tick;
  state._zoneSnapshotAtMs = performance.now();
  // Adopt the server's authoritative copy of self if present in this chunk.
  if (state.entityId) {
    const me = ev.entities.find(e => e.id === state.entityId);
    if (me && me.type === 'player') state.self = me as unknown as typeof state.self;
  }
  // wild_chunk is the wilderness's per-tick snapshot; fire mmo:zone so the same
  // panel refreshers a regular 'zone' event drives (loot, inventory, char sheet,
  // map) stay live out here too — otherwise loot gives no visual feedback.
  window.dispatchEvent(new CustomEvent('mmo:zone'));
}

export function onWildLeave(ev: { cx: number; cy: number }): void {
  const k = key(ev.cx, ev.cy);
  chunkEntities.delete(k);
  chunkActiveZones.delete(k);
  tileCache.delete(k);
  invalidateTileMemo();
}

/** Drop all wilderness state when returning to an enclosed zone. */
export function exitWild(): void {
  chunkEntities.clear();
  tileCache.clear();
  invalidateTileMemo();
}

/**
 * The wilds rotated (docs/rotating-wilds.md). Everything here is derived from
 * the atlas seed, so all of it is now wrong: cached chunk terrain would render
 * the previous world, and streamed entities belong to mobs the server has just
 * deleted. Drop the atlas too and refetch — the seed, the settlement gates and
 * the dungeon sites all changed.
 *
 * `discovered` is deliberately NOT cleared: discovery is keyed by site id, not
 * position, and surviving the rotation is the entire point of it. Scroll
 * reveals are the opposite — a position in the world that just ended — so they
 * go, mirroring the server's epoch-stamped store (server/game/systems/scrolls.ts).
 */
export async function onWildReset(ev: WildResetEvent): Promise<void> {
  revealed.clear();
  chunkEntities.clear();
  chunkActiveZones.clear();
  tileCache.clear();
  invalidateTileMemo();
  atlas = null;
  seeds = null;
  await ensureAtlas();
  window.dispatchEvent(new CustomEvent('mmo:wild_reset', { detail: ev }));
}
