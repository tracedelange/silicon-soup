// Op-driven zone generator. Builds a Blackboard, runs each op as a pass that
// reads/writes it (tiles, cost, keepout, features), then derives the legacy
// bounds map and focal point. 100% deterministic: same ZoneDef → same grid.
//
// Atoms operate on the shared Blackboard so later passes can see earlier ones'
// output. Tile-only ops (fill/region/road/...) just paint grid + register
// region features; placement/network atoms (to come) use the cost/keepout masks.

import {
  paintArc, paintCircle, paintEllipse, paintLine, paintPath,
  paintPolygon, paintRect, paintScatter, paintWalls, type Grid,
} from './primitives.ts';
import { resolveSeed, valueNoise } from './rng.ts';
import { ARCHETYPES } from './archetypes.ts';
import { generateCave, openExtent } from './caves.ts';
import { Blackboard, CLAIM, type RegionBounds } from './blackboard.ts';
import { BLOCKING_TILES as BLOCKING } from '../../../shared/constants.ts';
import type {
  BoundsRef, ClaimCategory, Direction, GenOp, Landmark, PointRef, PositionSpec,
  Prefab, PrefabData, PrefabRef, SemanticAt, ShapeSpec, ZoneDef,
} from '../../../shared/types.ts';

const CARDINAL = new Set<Direction>(['north', 'south', 'east', 'west']);

/** Resolve a stamp/place prefab ref: an inline definition, or a named prefab
 *  id looked up in the Blackboard registry. Returns null when an id is unknown. */
function resolvePrefab(ref: PrefabRef, bb: Blackboard): PrefabData | null {
  if (typeof ref !== 'string') return ref;
  const found = bb.prefabs[ref];
  if (!found) {
    console.warn(`[mapgen] prefab '${ref}' not found in registry — op skipped.`);
    return null;
  }
  return found;
}

/**
 * Snapshot the AABB, call painter, then restore cells whose original tile was
 * not in `onlyOver`. Lets any shape-based op skip already-placed terrain.
 * Works for all shape kinds (rect/circle/ellipse/polygon) since they all
 * write into the same flat grid rows.
 */
function filteredPaint(
  grid: Grid,
  bounds: { x: number; y: number; w: number; h: number },
  onlyOver: Set<string>,
  painter: () => void,
): void {
  const { x: bx, y: by, w: bw, h: bh } = bounds;
  // Snapshot
  const snap: string[][] = [];
  for (let dy = 0; dy < bh; dy++) {
    const row = grid[by + dy];
    const snapRow: string[] = [];
    for (let dx = 0; dx < bw; dx++) snapRow.push(row?.[bx + dx] ?? '');
    snap.push(snapRow);
  }
  // Apply
  painter();
  // Restore cells the filter disallows
  for (let dy = 0; dy < bh; dy++) {
    const row = grid[by + dy];
    if (!row) continue;
    const snapRow = snap[dy]!;
    for (let dx = 0; dx < bw; dx++) {
      const orig = snapRow[dx]!;
      if (!onlyOver.has(orig)) row[bx + dx] = orig;
    }
  }
}

/** Normalise `only_over` field (string | string[] | undefined) to a Set or null. */
function resolveOnlyOver(raw: string | string[] | undefined): Set<string> | null {
  if (raw == null) return null;
  return new Set(Array.isArray(raw) ? raw : [raw]);
}

const CLAIM_BY_NAME: Record<ClaimCategory, number> = {
  reserved: CLAIM.RESERVED,
  building: CLAIM.BUILDING,
  road: CLAIM.ROAD,
  water: CLAIM.WATER,
  site: CLAIM.SITE,
};

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const DEFAULT_FALLBACK_TILE = 'grass';

export interface ZoneGrid {
  grid: Grid;
  bounds: Record<string, RegionBounds>;
  width: number;
  height: number;
  /** Resolved focal point — the narrative anchor tile. Null if unresolvable. */
  focal: { x: number; y: number } | null;
  /** The full generation state (tiles, cost, keepout, features) for debug overlays. */
  blackboard: Blackboard;
  /**
   * Portal tiles that were auto-painted for connections with no explicit portal
   * on that edge. Source coordinates only — World resolves destination after all
   * zones are loaded and injects full ZonePortal entries into def.portals.
   */
  autoConnectionPortals: Array<{ at: { x: number; y: number }; dir: Direction; toZone: string }>;
  /**
   * Portals placed by `portal` post-ops. Source coordinates and target zone
   * only — World resolves the destination tile (the target's spawn point) after
   * all zones load and injects full ZonePortal entries into def.portals.
   */
  postOpPortals: Array<{
    at: { x: number; y: number };
    toZone: string;
    transition?: 'descend' | 'ascend' | 'teleport';
  }>;
}

interface ResolvedShape {
  // Axis-aligned bounding box, post-positioning.
  bounds: RegionBounds;
  // Paints the shape onto a grid.
  paint: (grid: Grid, tile: string) => void;
}

function shapeAABBSize(shape: ShapeSpec): { w: number; h: number } {
  switch (shape.kind) {
    case 'rect':    return { w: shape.w, h: shape.h };
    case 'circle':  return { w: shape.r * 2, h: shape.r * 2 };
    case 'ellipse': return { w: shape.rx * 2, h: shape.ry * 2 };
    case 'polygon': {
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const [x, y] of shape.points) {
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      return { w: Math.ceil(xMax - xMin), h: Math.ceil(yMax - yMin) };
    }
  }
}

function resolvePosition(size: { w: number; h: number }, at: PositionSpec, bb: Blackboard): { x: number; y: number } {
  if ('center' in at) {
    return { x: Math.floor((bb.width - size.w) / 2), y: Math.floor((bb.height - size.h) / 2) };
  }
  if ('x' in at) {
    return { x: at.x, y: at.y };
  }
  const parent = bb.regionBounds(at.relative_to);
  if (!parent) throw new Error(`relative_to: '${at.relative_to}' — region not yet defined`);
  const gap = at.gap ?? 1;
  const cx = parent.x + Math.floor(parent.w / 2);
  const cy = parent.y + Math.floor(parent.h / 2);
  switch (at.side) {
    case 'north': return { x: cx - Math.floor(size.w / 2), y: parent.y - size.h - gap };
    case 'south': return { x: cx - Math.floor(size.w / 2), y: parent.y + parent.h + gap };
    case 'east':  return { x: parent.x + parent.w + gap,    y: cy - Math.floor(size.h / 2) };
    case 'west':  return { x: parent.x - size.w - gap,      y: cy - Math.floor(size.h / 2) };
  }
}

function resolveShape(shape: ShapeSpec, at: PositionSpec, bb: Blackboard): ResolvedShape {
  const size = shapeAABBSize(shape);
  const pos = resolvePosition(size, at, bb);
  const aabb = { x: pos.x, y: pos.y, w: size.w, h: size.h };
  const cx = pos.x + size.w / 2;
  const cy = pos.y + size.h / 2;
  let paint: ResolvedShape['paint'];
  switch (shape.kind) {
    case 'rect':
      paint = (grid, tile) => paintRect(grid, pos.x, pos.y, size.w, size.h, tile);
      break;
    case 'circle':
      paint = (grid, tile) => paintCircle(grid, cx, cy, shape.r, tile);
      break;
    case 'ellipse':
      paint = (grid, tile) => paintEllipse(grid, cx, cy, shape.rx, shape.ry, tile);
      break;
    case 'polygon': {
      // Polygon points are in absolute zone coords; `at` is always ignored.
      // Warn when the caller supplied a meaningful at value so they know it had
      // no effect. (at: { x:0, y:0 } is the default fallback — skip it.)
      const isNonTrivialAt =
        ('center' in at) ||
        ('relative_to' in at) ||
        ('x' in at && ((at as { x: number }).x !== 0 || (at as { y: number }).y !== 0));
      if (isNonTrivialAt) {
        console.warn(
          `[mapgen] polygon shape: 'at' field (${JSON.stringify(at)}) is ignored. ` +
          `Polygon points are always in absolute zone coordinates. ` +
          `Encode the intended position directly in the points array.`,
        );
      }
      const points = shape.points;
      paint = (grid, tile) => paintPolygon(grid, points, tile);
      // Recompute AABB from absolute points.
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const [x, y] of points) {
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      aabb.x = Math.floor(xMin);
      aabb.y = Math.floor(yMin);
      aabb.w = Math.ceil(xMax - xMin);
      aabb.h = Math.ceil(yMax - yMin);
      break;
    }
  }
  return { bounds: aabb, paint };
}

function resolveBoundsRef(ref: BoundsRef, bb: Blackboard): RegionBounds {
  if ('all' in ref) return { x: 0, y: 0, w: bb.width, h: bb.height };
  if ('rect' in ref) return ref.rect;
  if ('inset' in ref) {
    const i = ref.inset;
    return { x: i, y: i, w: Math.max(0, bb.width - i * 2), h: Math.max(0, bb.height - i * 2) };
  }
  if ('edge_strip' in ref) {
    const d = Math.max(1, ref.depth);
    switch (ref.edge_strip) {
      case 'north': return { x: 0, y: 0,                   w: bb.width, h: d };
      case 'south': return { x: 0, y: bb.height - d,       w: bb.width, h: d };
      case 'west':  return { x: 0, y: 0,                   w: d, h: bb.height };
      case 'east':  return { x: bb.width - d, y: 0,        w: d, h: bb.height };
    }
  }
  if ('corner_patch' in ref) {
    const d = Math.max(1, ref.depth);
    switch (ref.corner_patch) {
      case 'NW': return { x: 0,              y: 0,              w: d, h: d };
      case 'NE': return { x: bb.width - d,   y: 0,              w: d, h: d };
      case 'SW': return { x: 0,              y: bb.height - d,  w: d, h: d };
      case 'SE': return { x: bb.width - d,   y: bb.height - d,  w: d, h: d };
    }
  }
  const r = bb.regionBounds(ref.region);
  if (!r) throw new Error(`bounds ref: region '${ref.region}' not defined`);
  return r;
}

function resolvePoint(ref: PointRef, bb: Blackboard): { x: number; y: number } {
  if ('x' in ref) return { x: ref.x, y: ref.y };
  if ('feature' in ref) {
    const f = bb.features.get(ref.feature);
    if (!f) throw new Error(`point ref: feature '${ref.feature}' not defined`);
    if (f.at) return f.at;
    if (f.rect) return { x: f.rect.x + Math.floor(f.rect.w / 2), y: f.rect.y + Math.floor(f.rect.h / 2) };
    throw new Error(`point ref: feature '${ref.feature}' has no position`);
  }
  if ('center' in ref) {
    return { x: Math.floor(bb.width / 2), y: Math.floor(bb.height / 2) };
  }
  if ('edge' in ref) {
    const t   = Math.min(1, Math.max(0, ref.t ?? 0.5));
    const ins = Math.max(0, ref.inset ?? 0);
    switch (ref.edge) {
      case 'north': return { x: ins + Math.round(t * (bb.width  - 1 - ins * 2)), y: ins };
      case 'south': return { x: ins + Math.round(t * (bb.width  - 1 - ins * 2)), y: bb.height - 1 - ins };
      case 'west':  return { x: ins,                                               y: ins + Math.round(t * (bb.height - 1 - ins * 2)) };
      case 'east':  return { x: bb.width - 1 - ins,                               y: ins + Math.round(t * (bb.height - 1 - ins * 2)) };
    }
  }
  const r = bb.regionBounds(ref.region);
  if (!r) throw new Error(`point ref: region '${ref.region}' not defined`);
  const cx = r.x + Math.floor(r.w / 2);
  const cy = r.y + Math.floor(r.h / 2);
  switch (ref.anchor) {
    case 'north': return { x: cx, y: r.y };
    case 'south': return { x: cx, y: r.y + r.h - 1 };
    case 'east':  return { x: r.x + r.w - 1, y: cy };
    case 'west':  return { x: r.x,           y: cy };
    case 'center':
    default:      return { x: cx, y: cy };
  }
}

// ─── Post-ops: semantic placement + portal pass ──────────────────────────────

/** State threaded through a zone's post_ops sequence. */
interface PostOpCtx {
  /** Cell indices claimed by prior post-ops, so placements don't stack. */
  claimed: Set<number>;
  /** Centres of stamps placed earlier this run, for `spacing` checks. */
  stampCentres: Array<{ x: number; y: number }>;
}

/** True when `at` is a coordinate-free SemanticAt rather than a PointRef. */
function isSemanticAt(at: PointRef | SemanticAt): at is SemanticAt {
  return (
    'near_tile' in at || 'on_tile' in at || 'random_free' in at ||
    'in_region' in at || 'near_region' in at || 'center_of_region' in at ||
    'free_edge' in at || 'anchor_of' in at
  );
}

/** A cell is placeable when in bounds, non-blocking, not building/reserved, and
 *  not already claimed by an earlier post-op. */
function isPlaceable(bb: Blackboard, ctx: PostOpCtx, x: number, y: number): boolean {
  if (!bb.inBounds(x, y)) return false;
  if (ctx.claimed.has(bb.idx(x, y))) return false;
  if (bb.blocking.has(bb.tileAt(x, y)!)) return false;
  return bb.isFree(x, y, CLAIM.BUILDING | CLAIM.RESERVED);
}

/** True if any tile within Chebyshev `margin` of (x,y) is a blocking tile. */
function nearBlocking(bb: Blackboard, x: number, y: number, margin: number): boolean {
  for (let dy = -margin; dy <= margin; dy++) {
    for (let dx = -margin; dx <= margin; dx++) {
      const t = bb.tileAt(x + dx, y + dy);
      if (t !== undefined && bb.blocking.has(t)) return true;
    }
  }
  return false;
}

/** Region features whose id exactly equals or starts with `prefix` (e.g.
 *  "building" matches "building_0", "building_1"). */
function regionsMatching(bb: Blackboard, prefix: string): RegionBounds[] {
  const out: RegionBounds[] = [];
  for (const f of bb.features.byKind('region')) {
    if (f.rect && (f.id === prefix || f.id.startsWith(prefix))) out.push(f.rect);
  }
  return out;
}

/** Chebyshev distance from (x,y) to the nearest matching region's AABB (0 if inside). */
function distanceToRegions(regions: RegionBounds[], x: number, y: number): number {
  let best = Infinity;
  for (const r of regions) {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w - 1));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h - 1));
    const d = Math.max(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/** All cells of a region ordered center-out (centroid first), for placement
 *  that prefers the middle of a region but will settle anywhere inside it. */
function regionCellsCenterOut(r: RegionBounds): Array<{ x: number; y: number }> {
  const cx = r.x + (r.w >> 1), cy = r.y + (r.h >> 1);
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) cells.push({ x, y });
  }
  return cells.sort((a, b) =>
    Math.max(Math.abs(a.x - cx), Math.abs(a.y - cy)) - Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy)),
  );
}

/** Cells in expanding Chebyshev rings (0..radius) around a centre, near-to-far. */
function ringCells(cx: number, cy: number, radius: number): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let rad = 0; rad <= radius; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad) cells.push({ x: cx + dx, y: cy + dy });
      }
    }
  }
  return cells;
}

/**
 * Expands a semantic descriptor into an ORDERED list of candidate centre tiles,
 * restricted to the descriptor's area/tile constraints but NOT yet checked for
 * placeability or footprint fit — that is the consumer's job. Order encodes
 * preference (centre-out for regions, near-to-far for near_*, scan order
 * otherwise). Point descriptors (anchor_of, explicit PointRef) yield one cell.
 * Returns null when the descriptor references something that does not exist.
 */
function semanticCandidates(
  at: PointRef | SemanticAt,
  bb: Blackboard,
): Array<{ x: number; y: number }> | null {
  if (!isSemanticAt(at)) {
    try { return [resolvePoint(at, bb)]; }
    catch (e) { console.warn(`[mapgen] post_op at unresolvable — ${(e as Error).message}`); return null; }
  }

  const out: Array<{ x: number; y: number }> = [];

  if ('near_tile' in at) {
    const margin = at.margin ?? 0;
    const regions = at.near_region ? regionsMatching(bb, at.near_region) : null;
    for (let y = 0; y < bb.height; y++) {
      for (let x = 0; x < bb.width; x++) {
        if (bb.tileAt(x, y) !== at.near_tile) continue;
        if (margin > 0 && nearBlocking(bb, x, y, margin)) continue;
        if (regions && !(regions.length > 0 && distanceToRegions(regions, x, y) <= 3)) continue;
        out.push({ x, y });
      }
    }
    return out;
  }

  if ('on_tile' in at) {
    for (let y = 0; y < bb.height; y++) {
      for (let x = 0; x < bb.width; x++) if (bb.tileAt(x, y) === at.on_tile) out.push({ x, y });
    }
    return out;
  }

  if ('random_free' in at) {
    for (let y = 0; y < bb.height; y++) for (let x = 0; x < bb.width; x++) out.push({ x, y });
    const rng = bb.subRng('random_free_shuffle');
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  if ('in_region' in at || 'center_of_region' in at) {
    const id = 'in_region' in at ? at.in_region : at.center_of_region;
    const r = bb.regionBounds(id);
    if (!r) { console.warn(`[mapgen] post_op region '${id}' not found.`); return null; }
    if ('in_region' in at && at.edge) {
      const cx = r.x + (r.w >> 1), cy = r.y + (r.h >> 1);
      const edgeCells: Array<{ x: number; y: number }> = [];
      if (at.edge === 'north') for (let x = r.x; x < r.x + r.w; x++) edgeCells.push({ x, y: r.y });
      else if (at.edge === 'south') for (let x = r.x; x < r.x + r.w; x++) edgeCells.push({ x, y: r.y + r.h - 1 });
      else if (at.edge === 'west') for (let y = r.y; y < r.y + r.h; y++) edgeCells.push({ x: r.x, y });
      else for (let y = r.y; y < r.y + r.h; y++) edgeCells.push({ x: r.x + r.w - 1, y });
      return edgeCells.sort((a, b) =>
        Math.max(Math.abs(a.x - cx), Math.abs(a.y - cy)) - Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy)),
      );
    }
    const cells = regionCellsCenterOut(r);
    return ('in_region' in at && at.order === 'edge_in') ? cells.reverse() : cells;
  }

  if ('near_region' in at) {
    const r = bb.regionBounds(at.near_region);
    if (!r) { console.warn(`[mapgen] post_op near_region: '${at.near_region}' not found.`); return null; }
    return ringCells(r.x + (r.w >> 1), r.y + (r.h >> 1), at.distance ?? 4);
  }

  if ('free_edge' in at) {
    const inset = at.inset ?? 1;
    const edge = at.free_edge;
    const horiz = edge === 'north' || edge === 'south';
    const len = horiz ? bb.width : bb.height;
    const mid = len >> 1;
    const fixY = edge === 'north' ? inset : edge === 'south' ? bb.height - 1 - inset : -1;
    const fixX = edge === 'west' ? inset : edge === 'east' ? bb.width - 1 - inset : -1;
    for (let off = 0; off < len; off++) {
      for (const sign of (off === 0 ? [0] : [1, -1])) {
        const pos = mid + sign * off;
        if (pos < 0 || pos >= len) continue;
        out.push({ x: horiz ? pos : fixX, y: horiz ? fixY : pos });
      }
    }
    return out;
  }

  // anchor_of: a tile tagged `anchor` from a stamped prefab named `anchor_of`.
  // Stamp post-ops register anchors as `<prefab>_<tag>` features tagged <tag>.
  const exact = bb.features.get(`${at.anchor_of}_${at.anchor}`);
  if (exact?.at) return [exact.at];
  for (const f of bb.features.byTag(at.anchor)) {
    if (f.at && f.id.startsWith(at.anchor_of)) return [f.at];
  }
  console.warn(`[mapgen] post_op anchor_of: no '${at.anchor}' anchor on prefab '${at.anchor_of}'.`);
  return null;
}

/**
 * Resolves a semantic descriptor to a single placeable tile — for point-sized
 * post-ops (portal, scatter). Returns the first candidate that is placeable, or
 * (for anchor_of / explicit points) the exact target. Null when nothing fits.
 */
function resolveSemanticAt(
  at: PointRef | SemanticAt,
  bb: Blackboard,
  ctx: PostOpCtx,
): { x: number; y: number } | null {
  const candidates = semanticCandidates(at, bb);
  if (!candidates) return null;
  // anchor_of / explicit points are exact targets (e.g. a portal lands on the
  // prefab's anchor tile regardless of claims) — return as-is.
  const isExact = !isSemanticAt(at) || 'anchor_of' in at;
  if (isExact) return candidates[0] ?? null;
  return candidates.find((c) => isPlaceable(bb, ctx, c.x, c.y)) ?? null;
}

/** The grid offsets (relative to the stamp's centre) every painted prefab cell
 *  occupies, accounting for scale. Mirrors applyStamp's centring geometry. */
function prefabFootprint(prefab: PrefabData, scale: number): Array<{ dx: number; dy: number }> {
  const rows = prefab.data.replace(/\n+$/, '').split('\n');
  const ph = rows.length, pw = rows[0]?.length ?? 0;
  const halfW = Math.floor((pw * scale) / 2), halfH = Math.floor((ph * scale) / 2);
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      if (prefab.legend[rows[r]![c]!] === undefined) continue;   // passthrough cell
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          offsets.push({ dx: c * scale + sx - halfW, dy: r * scale + sy - halfH });
        }
      }
    }
  }
  return offsets;
}

/**
 * Footprint-aware placement for a post-op stamp. Walks the descriptor's ordered
 * candidate centres and returns the first where EVERY footprint cell lands on
 * open ground (in bounds, not blocking, not building/reserved-claimed, not
 * claimed by an earlier post-op). Null → no fit anywhere in the implied area.
 *
 * When `overwrite` is true the blocking-tile check is skipped — only out-of-bounds
 * and prior post-op claims are rejected. Use for structures that carve through
 * terrain (e.g. a cave entrance overwriting forest trees).
 */
function findStampFit(
  at: PointRef | SemanticAt,
  prefab: PrefabData,
  scale: number,
  bb: Blackboard,
  ctx: PostOpCtx,
  overwrite: boolean | 'biome' = false,
  margin = 0,
  spacing = 0,
): { x: number; y: number } | null {
  const candidates = semanticCandidates(at, bb);
  if (!candidates) return null;
  const offsets = prefabFootprint(prefab, scale);
  const check =
    overwrite === true
      ? (x: number, y: number) => bb.inBounds(x, y)
      : overwrite === 'biome'
      ? (x: number, y: number) =>
          bb.inBounds(x, y) &&
          !ctx.claimed.has(bb.idx(x, y)) &&
          !bb.blocking.has(bb.tileAt(x, y)!)
      : (x: number, y: number) => isPlaceable(bb, ctx, x, y);
  for (const c of candidates) {
    if (!offsets.every((o) => check(c.x + o.dx, c.y + o.dy))) continue;
    // Breathing room: no footprint cell may sit within `margin` of blocking
    // terrain (cliffs, water, and — since earlier stamps painted walls —
    // other buildings).
    if (margin > 0 && offsets.some((o) => nearBlocking(bb, c.x + o.dx, c.y + o.dy, margin))) continue;
    // Spacing: keep clear of the centres of stamps already placed this run
    // (separates wall-less structures that `margin` wouldn't catch).
    if (spacing > 0 && ctx.stampCentres.some((p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) < spacing)) continue;
    return c;
  }
  return null;
}

/**
 * Executes a zone's `post_ops` against the already-generated Blackboard. Each
 * op's semantic `at` descriptor is resolved to a concrete tile first; a failed
 * resolution skips that op (logged) rather than crashing load. `portal` ops are
 * collected and returned for World to wire to destination zones. When a stamp
 * names a registry prefab, its prefab id is used as the anchor prefix so a
 * following `portal` can target it via `anchor_of`.
 */
function applyPostOps(zoneDef: ZoneDef, bb: Blackboard): ZoneGrid['postOpPortals'] {
  const post = zoneDef.post_ops;
  if (!post?.length) return [];
  const ctx: PostOpCtx = { claimed: new Set<number>(), stampCentres: [] };
  const portals: ZoneGrid['postOpPortals'] = [];

  for (const op of post) {
    if (op.type === 'portal') {
      const pt = resolveSemanticAt(op.at, bb, ctx);
      if (!pt) { console.warn(`[mapgen] post_op portal → '${op.target_zone}' skipped: unresolved 'at'.`); continue; }
      bb.paint(pt.x, pt.y, op.tile ?? 'portal');
      ctx.claimed.add(bb.idx(pt.x, pt.y));
      portals.push({ at: pt, toZone: op.target_zone, transition: op.transition });
      continue;
    }

    // Footprint-aware stamp: search the descriptor's area for a location where
    // the whole prefab fits in open space; skip (with a warning) if none does,
    // rather than overwriting a building or fountain.
    if (op.type === 'stamp' && op.at !== undefined) {
      if (op.if_region && !bb.regionBounds(op.if_region) && !op.fallback_free) continue; // silently skip when guard region absent (unless a portal must still land)
      const prefab = resolvePrefab(op.prefab, bb);
      if (!prefab) continue;                         // resolvePrefab already warned
      const scale = Math.max(1, Math.round(op.scale ?? 1));
      let pt = findStampFit(op.at, prefab, scale, bb, ctx, op.overwrite ?? false, op.margin ?? 0, op.spacing ?? 0);
      // A portal-bearing stamp must not be silently lost when its preferred
      // region is too small: retry once over the whole zone (random free space).
      if (!pt && op.fallback_free && typeof op.at === 'object' && 'in_region' in op.at) {
        pt = findStampFit({ random_free: true }, prefab, scale, bb, ctx, op.overwrite ?? false, op.margin ?? 0, op.spacing ?? 0);
        if (pt) {
          console.warn(`[mapgen] post_op stamp "${op.prefab}" in zone '${zoneDef.id}' did not fit region '${(op.at as { in_region: string }).in_region}' — placed in free space instead.`);
        }
      }
      if (!pt) {
        const regionLabel = op.region ? ` region "${op.region}"` : '';
        console.warn(`[mapgen] post_op stamp skipped: prefab "${op.prefab}"${regionLabel} in zone '${zoneDef.id}' does not fit any free space in the requested area.`);
        continue;
      }
      ctx.stampCentres.push(pt);
      const resolved = { ...op, at: pt } as Extract<GenOp, { type: 'stamp' }>;
      // Default the anchor prefix to the named prefab id so a following portal
      // can target its anchors via anchor_of.
      if (typeof resolved.prefab === 'string' && !resolved.anchor_prefix) {
        resolved.anchor_prefix = resolved.prefab;
      }
      applyOp(resolved, bb);
      for (const o of prefabFootprint(prefab, scale)) ctx.claimed.add(bb.idx(pt.x + o.dx, pt.y + o.dy));
      continue;
    }

    // Other ops carrying a semantic `at` (scatter, fill, …): resolve to a single
    // placeable cell before delegating.
    if ('at' in op && op.at !== undefined && isSemanticAt(op.at as PointRef | SemanticAt)) {
      const pt = resolveSemanticAt(op.at as SemanticAt, bb, ctx);
      if (!pt) { console.warn(`[mapgen] post_op '${op.type}' skipped: unresolved 'at'.`); continue; }
      applyOp({ ...op, at: pt } as GenOp, bb);
      ctx.claimed.add(bb.idx(pt.x, pt.y));
      continue;
    }

    applyOp(op, bb);
  }
  return portals;
}

export function generateZoneGrid(
  zoneDef: ZoneDef,
  blockingTiles: ReadonlySet<string> = BLOCKING,
  prefabs: Record<string, Prefab> = {},
): ZoneGrid {
  const width = zoneDef.width || DEFAULT_GRID_W;
  const height = zoneDef.height || DEFAULT_GRID_H;
  const defaultTile = zoneDef.default_tile || DEFAULT_FALLBACK_TILE;
  const bb = new Blackboard({ width, height, defaultTile, seed: zoneDef.seed ?? zoneDef.id, blocking: blockingTiles, inset: zoneDef.inset ?? 0, prefabs });

  const ops = zoneDef.ops || [];

  // Warn when a dungeon/interior zone uses a walkable default_tile alongside
  // walled regions — the classic dungeon-carving bug where background is traversable.
  // Outdoor zones (those with edge connections) are exempt: background grass/dirt is expected.
  // So is a `transparent` background: that zone is a wilderness footprint whose
  // background falls through to the field, not an interior (see mapgen/bake.ts).
  if (!blockingTiles.has(defaultTile) && defaultTile !== 'transparent') {
    const hasEdgeConnections = Object.values((zoneDef as { connections?: Record<string, unknown> }).connections || {}).some(Boolean);
    if (!hasEdgeConnections) {
      const hasWalledRegion = ops.some(op => op.type === 'region' && (op as { walls?: unknown }).walls);
      if (hasWalledRegion) {
        console.warn(
          `[mapgen] zone '${zoneDef.id}': default_tile '${defaultTile}' is walkable ` +
          `but the zone has walled regions. Background tiles will be traversable. ` +
          `Use default_tile: wall or void for dungeon/indoor zones.`,
        );
      }
    }
  }

  for (const op of ops) applyOp(op, bb);

  // Implementor post-ops run after the biome pipeline against the live grid.
  // They may use SemanticAt descriptors and place `portal` ops (collected here).
  const postOpPortals = applyPostOps(zoneDef, bb);

  // Paint explicit portal markers so they sit on top of any underlying terrain.
  const explicitPortalEdges = new Set<Direction>();
  for (const p of zoneDef.portals || []) {
    if (!p?.at) continue;
    const px = p.at.x | 0;
    const py = p.at.y | 0;
    const t = p.tile === undefined ? 'portal' : p.tile;
    if (t === null) continue;
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    bb.paint(px, py, t);
    if (px === 0)         explicitPortalEdges.add('west');
    if (px === width - 1) explicitPortalEdges.add('east');
    if (py === 0)         explicitPortalEdges.add('north');
    if (py === height - 1) explicitPortalEdges.add('south');
  }

  // Auto-paint a portal tile for each connection that has no explicit portal on
  // that edge. This keeps the rendered grid accurate even when the LLM omits
  // portals (as it should for connection-based transitions). Destination
  // coordinates are resolved by World._synthesizeConnectionPortals after load.
  const autoConnectionPortals: ZoneGrid['autoConnectionPortals'] = [];
  const connections = zoneDef.connections ?? {};
  for (const [dirStr, toZoneId] of Object.entries(connections)) {
    if (!toZoneId) continue;
    // Non-cardinal keys (surface/cellar/…) are interior connections handled by
    // World's return-portal synthesis, not edge transitions — skip them here.
    if (!CARDINAL.has(dirStr as Direction)) continue;
    const dir = dirStr as Direction;
    if (explicitPortalEdges.has(dir)) continue;
    const tile = findWalkableEdgeTile(bb.grid, width, height, dir, blockingTiles);
    if (!tile) continue;
    bb.paint(tile.x, tile.y, 'portal');
    autoConnectionPortals.push({ at: tile, dir, toZone: toZoneId });
  }

  const bounds = bb.regionMap();
  const focal = resolveFocalPoint(zoneDef, bounds, width, height);

  return { grid: bb.grid, bounds, width, height, focal, blackboard: bb, autoConnectionPortals, postOpPortals };
}

const clampToZone = (
  p: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } => ({
  x: Math.max(0, Math.min(width - 1, Math.round(p.x))),
  y: Math.max(0, Math.min(height - 1, Math.round(p.y))),
});

/**
 * Resolves a Landmark declaration to concrete tile coordinates.
 * `{ x, y }` is returned as-is; `{ region }` resolves to the region's center.
 * Returns null when the region doesn't exist in bounds.
 */
export function resolveLandmark(
  landmark: Landmark | undefined,
  bounds: Record<string, RegionBounds>,
): { x: number; y: number } | null {
  if (!landmark) return null;
  if ('region' in landmark) {
    const r = bounds[landmark.region];
    if (!r) return null;
    return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  }
  return { x: landmark.x, y: landmark.y };
}

/**
 * Resolves a zone's focal point — the narrative anchor — to a tile coordinate.
 *
 * Resolution order:
 *   1. An explicit `focal_point` ({ region } | { x, y } | { landmark_offset }).
 *   2. The `landmark`, shifted by the archetype's default focal offset.
 *   3. The zone center.
 */
export function resolveFocalPoint(
  zoneDef: ZoneDef,
  bounds: Record<string, RegionBounds>,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const fp = zoneDef.focal_point;
  const landmark = resolveLandmark(zoneDef.landmark, bounds);

  if (fp) {
    if ('region' in fp) {
      const r = bounds[fp.region];
      if (r) return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
    } else if ('x' in fp) {
      return clampToZone({ x: fp.x, y: fp.y }, width, height);
    } else if ('landmark_offset' in fp && landmark) {
      return clampToZone(
        { x: landmark.x + fp.landmark_offset.dx, y: landmark.y + fp.landmark_offset.dy },
        width, height,
      );
    }
  }

  const anchor = landmark ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const arch = zoneDef.archetype ? ARCHETYPES[zoneDef.archetype] : undefined;
  const dx = arch ? Math.round(arch.focalOffset.fx * width) : 0;
  const dy = arch ? Math.round(arch.focalOffset.fy * height) : 0;
  return clampToZone({ x: anchor.x + dx, y: anchor.y + dy }, width, height);
}

/**
 * Scans the given edge for the walkable tile nearest the midpoint.
 * Used to auto-place connection portal tiles and to synthesize portal entries.
 */
export function findWalkableEdgeTile(
  grid: Grid,
  width: number,
  height: number,
  dir: Direction,
  blockingTiles: ReadonlySet<string> = BLOCKING,
): { x: number; y: number } | null {
  const isHoriz = dir === 'north' || dir === 'south';
  const len  = isHoriz ? width : height;
  const mid  = Math.floor(len / 2);
  const fixY = dir === 'north' ? 0 : dir === 'south' ? height - 1 : -1;
  const fixX = dir === 'west'  ? 0 : dir === 'east'  ? width  - 1 : -1;

  for (let offset = 0; offset < len; offset++) {
    for (const sign of (offset === 0 ? [0] : [1, -1])) {
      const pos = mid + sign * offset;
      if (pos < 0 || pos >= len) continue;
      const x = isHoriz ? pos : fixX;
      const y = isHoriz ? fixY : pos;
      const tile = grid[y]?.[x];
      if (tile !== undefined && !blockingTiles.has(tile)) return { x, y };
    }
  }
  return null;
}

function applyOp(op: GenOp, bb: Blackboard): void {
  switch (op.type) {
    case 'fill': {
      const b = op.bounds
        ? resolveBoundsRef(op.bounds, bb)
        : op.placement === 'internal'
          ? { x: bb.inset, y: bb.inset, w: Math.max(0, bb.width - bb.inset * 2), h: Math.max(0, bb.height - bb.inset * 2) }
          : { x: 0, y: 0, w: bb.width, h: bb.height };
      const onlyOver = resolveOnlyOver(op.only_over);
      if (onlyOver) {
        filteredPaint(bb.grid, b, onlyOver, () => paintRect(bb.grid, b.x, b.y, b.w, b.h, op.tile));
      } else {
        paintRect(bb.grid, b.x, b.y, b.w, b.h, op.tile);
      }
      // Optionally expose the filled area as a named region so later ops/post_ops
      // can target it (e.g. a beach strip → `near_region: 'beach_N'`).
      if (op.region) bb.addRegion(op.region, b);
      return;
    }
    case 'region': {
      const r = resolveShape(op.shape, op.at, bb);
      if (op.floor) {
        const onlyOver = resolveOnlyOver(op.only_over);
        if (onlyOver) {
          filteredPaint(bb.grid, r.bounds, onlyOver, () => r.paint(bb.grid, op.floor!));
        } else {
          r.paint(bb.grid, op.floor);
        }
      }
      if (op.walls) {
        // Walls only meaningful for rectangular regions; circles/polygons skip.
        if (op.shape.kind === 'rect') {
          paintWalls(bb.grid, r.bounds.x, r.bounds.y, r.bounds.w, r.bounds.h, op.walls.tile, op.walls.door?.side, op.walls.door?.tile);
        } else {
          console.warn(
            `[mapgen] region '${op.id}': walls is only supported for rect shapes. ` +
            `Shape '${op.shape.kind}' — walls field ignored. ` +
            `Use separate shape ops to paint wall tiles manually for non-rect regions.`,
          );
        }
      }
      bb.addRegion(op.id, r.bounds);
      return;
    }
    case 'shape': {
      const r = resolveShape(op.shape, op.at, bb);
      const onlyOver = resolveOnlyOver(op.only_over);
      if (onlyOver) {
        filteredPaint(bb.grid, r.bounds, onlyOver, () => r.paint(bb.grid, op.tile));
      } else {
        r.paint(bb.grid, op.tile);
      }
      return;
    }
    case 'road': {
      const a = resolvePoint(op.from, bb);
      const b = resolvePoint(op.to,   bb);
      paintLine(bb.grid, a.x, a.y, b.x, b.y, op.tile, op.width ?? 1);
      return;
    }
    case 'path': {
      const pts: [number, number][] = op.points.map(p => {
        const resolved = (op.placement === 'perimeter' && 'edge' in p)
          ? { ...p, inset: bb.inset }
          : p;
        const r = resolvePoint(resolved, bb);
        return [r.x, r.y];
      });
      const seed = op.seed != null ? resolveSeed(op.seed) : 0;
      paintPath(bb.grid, pts, op.tile, op.width ?? 1, op.jitter ?? 0, seed);
      return;
    }
    case 'arc': {
      const a = resolvePoint(op.from, bb);
      const b = resolvePoint(op.to,   bb);
      paintArc(bb.grid, a.x, a.y, b.x, b.y, op.bulge, op.tile, op.width ?? 1);
      return;
    }
    case 'scatter': {
      const b = resolveBoundsRef(op.bounds, bb);
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? undefined
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      paintScatter(bb.grid, b.x, b.y, b.w, b.h, op.tile, op.count, seed, over);
      return;
    }
    case 'noise_patch': {
      const b = op.bounds
        ? resolveBoundsRef(op.bounds, bb)
        : op.placement === 'internal'
          ? { x: bb.inset, y: bb.inset, w: Math.max(0, bb.width - bb.inset * 2), h: Math.max(0, bb.height - bb.inset * 2) }
          : { x: 0, y: 0, w: bb.width, h: bb.height };
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? null
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      for (let y = b.y; y < b.y + b.h; y++) {
        if (y < 0 || y >= bb.height) continue;
        const row = bb.grid[y]!;
        for (let x = b.x; x < b.x + b.w; x++) {
          if (x < 0 || x >= bb.width) continue;
          if (over && !over.has(row[x]!)) continue;
          if (valueNoise(x, y, op.scale, seed) >= op.threshold) row[x] = op.tile;
        }
      }
      return;
    }
    case 'sketch': {
      const ox = op.at?.x ?? 0;
      const oy = op.at?.y ?? 0;
      const scale = Math.max(1, Math.round(op.scale ?? 1));
      const lines = op.data.split('\n');
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row]!;
        for (let col = 0; col < line.length; col++) {
          const tile = op.legend[line[col]!];
          if (!tile) continue;
          paintRect(bb.grid, ox + col * scale, oy + row * scale, scale, scale, tile);
        }
      }
      return;
    }
    case 'voronoi': {
      applyVoronoi(op, bb);
      return;
    }
    case 'cave': {
      applyCave(op, bb);
      return;
    }
    case 'bsp': {
      applyBsp(op, bb);
      return;
    }
    case 'scatter_sites': {
      applyScatterSites(op, bb);
      return;
    }
    case 'stamp': {
      applyStamp(op, bb);
      return;
    }
    case 'place': {
      applyPlace(op, bb);
      return;
    }
    case 'network': {
      applyNetwork(op, bb);
      return;
    }
    case 'route': {
      applyRoute(op, bb);
      return;
    }
    case 'ensure_reach': {
      applyEnsureReach(op, bb);
      return;
    }
    case 'portal': {
      // Portals are resolved in the post_ops pass (applyPostOps), which needs the
      // target_zone wiring. A portal in the main `ops` array has no effect.
      console.warn('[mapgen] portal op is only supported inside post_ops — ignored.');
      return;
    }
  }
}

/** BFS over walkable tiles (finite cost) from seed points; returns reachable cell indices.
 *  A seed on a non-walkable cell snaps to a walkable 4-neighbour. */
function floodWalkable(bb: Blackboard, seeds: Array<{ x: number; y: number }>): Set<number> {
  const W = bb.width, N = W * bb.height;
  const walk = (k: number) => Number.isFinite(bb.cost[k]!);
  const reach = new Set<number>();
  const q: number[] = [];
  for (const s of seeds) {
    if (!bb.inBounds(s.x, s.y)) continue;
    let k = s.y * W + s.x;
    if (!walk(k)) {
      let snapped = -1;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const x = s.x + dx, y = s.y + dy;
        if (bb.inBounds(x, y) && walk(y * W + x)) { snapped = y * W + x; break; }
      }
      if (snapped < 0) continue;
      k = snapped;
    }
    if (!reach.has(k)) { reach.add(k); q.push(k); }
  }
  const DIRS = [-W, W, -1, 1];
  let i = 0;
  while (i < q.length) {
    const c = q[i++]!;
    const cx = c % W;
    for (const d of DIRS) {
      if (d === -1 && cx === 0) continue;
      if (d === 1 && cx === W - 1) continue;
      const nk = c + d;
      if (nk < 0 || nk >= N) continue;
      if (!reach.has(nk) && walk(nk)) { reach.add(nk); q.push(nk); }
    }
  }
  return reach;
}

/** Connected components of walkable tiles, each a list of cell indices. */
function labelWalkable(bb: Blackboard): number[][] {
  const W = bb.width, N = W * bb.height;
  const walk = (k: number) => Number.isFinite(bb.cost[k]!);
  const seen = new Uint8Array(N);
  const out: number[][] = [];
  const DIRS = [-W, W, -1, 1];
  for (let s = 0; s < N; s++) {
    if (!walk(s) || seen[s]) continue;
    const cells: number[] = [];
    const q = [s]; seen[s] = 1;
    let i = 0;
    while (i < q.length) {
      const c = q[i++]!;
      cells.push(c);
      const cx = c % W;
      for (const d of DIRS) {
        if (d === -1 && cx === 0) continue;
        if (d === 1 && cx === W - 1) continue;
        const nk = c + d;
        if (nk < 0 || nk >= N) continue;
        if (!seen[nk] && walk(nk)) { seen[nk] = 1; q.push(nk); }
      }
    }
    out.push(cells);
  }
  return out;
}

function nearestReachable(reach: Set<number>, bb: Blackboard, p: { x: number; y: number }): { x: number; y: number } | null {
  const W = bb.width;
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const k of reach) {
    const x = k % W, y = (k / W) | 0;
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}

/** True when p, or a 4-neighbour of p, is a reachable walkable cell. */
function pointReached(reach: Set<number>, bb: Blackboard, p: { x: number; y: number }): boolean {
  const W = bb.width;
  for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const x = p.x + dx, y = p.y + dy;
    if (bb.inBounds(x, y) && reach.has(y * W + x)) return true;
  }
  return false;
}

/**
 * Reachability repair pass. Floods walkable tiles from the entry seeds, then —
 * for each stranded target — carves a corridor from the nearest reachable cell
 * (clearing `through` obstacles). `ensure_tags` targets named features (doors);
 * `ensure_all` targets every disconnected walkable pocket. Without a `carve`
 * tile it only reports. This is the connectivity guarantee, available to any
 * recipe rather than baked inside `cave`.
 */
function applyEnsureReach(op: Extract<GenOp, { type: 'ensure_reach' }>, bb: Blackboard): void {
  bb.syncCostFromGrid();
  const through = toSet(op.through);
  const throughCost = op.through_cost ?? 6;
  const width = op.width ?? 1;
  const carveTile = op.carve;

  const seeds: Array<{ x: number; y: number }> = [];
  const froms = op.from == null ? [] : (Array.isArray(op.from) ? op.from : [op.from]);
  for (const r of froms) seeds.push(resolvePoint(r, bb));
  if (op.from_tag) for (const f of bb.features.byTag(op.from_tag)) { const p = pointOf(f); if (p) seeds.push(p); }
  if (seeds.length === 0) {
    seeds.push({ x: bb.width >> 1, y: bb.height >> 1 });
    console.warn('[mapgen] ensure_reach: no from/from_tag — seeding from zone center.');
  }

  const anchorCells = new Set<number>();
  for (const f of bb.features.byKind('anchor')) if (f.at) anchorCells.add(f.at.y * bb.width + f.at.x);

  let reachable = floodWalkable(bb, seeds);
  let fixed = 0, stranded = 0;

  const connect = (p: { x: number; y: number }, label: string): void => {
    if (!carveTile) { console.warn(`[mapgen] ensure_reach: '${label}' (${p.x},${p.y}) unreachable.`); stranded++; return; }
    const near = nearestReachable(reachable, bb, p);
    if (!near) { console.warn(`[mapgen] ensure_reach: no reachable cell to reach '${label}'.`); stranded++; return; }
    const path = aStar(bb, near, p, through, throughCost);
    if (!path) { console.warn(`[mapgen] ensure_reach: could not carve to '${label}' (${p.x},${p.y}).`); stranded++; return; }
    carvePath(bb, path, carveTile, width, false, anchorCells);
    reachable = floodWalkable(bb, seeds);
    fixed++;
  };

  for (const tag of op.ensure_tags ?? []) {
    for (const f of bb.features.byTag(tag)) {
      const p = pointOf(f);
      if (p && !pointReached(reachable, bb, p)) connect(p, f.id);
    }
  }

  if (op.ensure_all) {
    for (const comp of labelWalkable(bb)) {
      if (comp.some((k) => reachable.has(k))) continue;
      const rep = comp[0]!;
      connect({ x: rep % bb.width, y: (rep / bb.width) | 0 }, `pocket(${comp.length} cells)`);
    }
  }

  if (fixed || stranded) {
    console.warn(`[mapgen] ensure_reach: ${fixed} corridor(s) carved, ${stranded} still stranded.`);
  }
}

/** Point of a feature: explicit point, else region/rect center. */
function pointOf(f: { at?: { x: number; y: number }; rect?: RegionBounds } | undefined): { x: number; y: number } | null {
  if (!f) return null;
  if (f.at) return f.at;
  if (f.rect) return { x: f.rect.x + (f.rect.w >> 1), y: f.rect.y + (f.rect.h >> 1) };
  return null;
}

/**
 * Edge selection. Gathers nodes (features by tag and/or explicit ids), builds a
 * road graph over them, and emits `edge` features for `route` to carve. `mst`
 * (Prim's, Euclidean) spans all nodes minimally; `extra_edges` adds the shortest
 * non-tree links back as loops; `star` links every node to a hub.
 */
function applyNetwork(op: Extract<GenOp, { type: 'network' }>, bb: Blackboard): void {
  const nodes: Array<{ id: string; x: number; y: number }> = [];
  const seen = new Set<string>();
  const addNode = (id: string) => {
    if (seen.has(id)) return;
    const p = pointOf(bb.features.get(id));
    if (p) { seen.add(id); nodes.push({ id, x: p.x, y: p.y }); }
  };
  if (op.nodes_tag) for (const f of bb.features.byTag(op.nodes_tag)) addNode(f.id);
  for (const id of op.nodes ?? []) addNode(id);

  if (nodes.length < 2) {
    console.warn(`[mapgen] network: only ${nodes.length} node(s) found — nothing to connect.`);
    return;
  }

  const edgeTag = op.edge_tag ?? 'road';
  const prefix = op.edge_prefix ?? 'edge';
  const method = op.method ?? 'mst';
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  let pairs: Array<[number, number]>;
  if (method === 'star') {
    let hub = op.hub ? nodes.findIndex((n) => n.id === op.hub) : 0;
    if (hub < 0) hub = 0;
    pairs = [];
    for (let i = 0; i < nodes.length; i++) if (i !== hub) pairs.push([hub, i]);
  } else {
    pairs = primMST(nodes, d2);
    const extra = op.extra_edges ?? 0;
    if (extra > 0) pairs.push(...extraEdges(nodes, pairs, d2, extra));
  }

  let i = 0;
  for (const [a, b] of pairs) {
    bb.addEdge(`${prefix}_${++i}`, [nodes[a]!.id, nodes[b]!.id], { tags: [edgeTag] });
  }
}

/** Prim's minimum spanning tree over node points; returns index-pair edges. */
function primMST(
  nodes: Array<{ x: number; y: number }>,
  d2: (a: { x: number; y: number }, b: { x: number; y: number }) => number,
): Array<[number, number]> {
  const n = nodes.length;
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  best[0] = 0;
  const edges: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    let u = -1, ud = Infinity;
    for (let v = 0; v < n; v++) if (!inTree[v] && best[v]! < ud) { ud = best[v]!; u = v; }
    if (u < 0) break;
    inTree[u] = true;
    if (parent[u] !== -1) edges.push([parent[u]!, u]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = d2(nodes[u]!, nodes[v]!);
      if (d < best[v]!) { best[v] = d; parent[v] = u; }
    }
  }
  return edges;
}

/** The shortest non-tree edges, count = round(frac · (n−1)), for loop redundancy. */
function extraEdges(
  nodes: Array<{ x: number; y: number }>,
  tree: Array<[number, number]>,
  d2: (a: { x: number; y: number }, b: { x: number; y: number }) => number,
  frac: number,
): Array<[number, number]> {
  const inTree = new Set(tree.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const cand: Array<{ a: number; b: number; d: number }> = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (inTree.has(`${a}-${b}`)) continue;
      cand.push({ a, b, d: d2(nodes[a]!, nodes[b]!) });
    }
  }
  cand.sort((x, y) => x.d - y.d);
  const k = Math.min(cand.length, Math.round(frac * Math.max(0, nodes.length - 1)));
  return cand.slice(0, k).map((c) => [c.a, c.b] as [number, number]);
}

/** Rotate a char matrix 90° clockwise `k` times (k mod 4). */
function rotateMatrix(m: string[][], k: number): string[][] {
  let g = m;
  for (let n = ((k % 4) + 4) % 4; n > 0; n--) {
    const rows = g.length, cols = g[0]?.length ?? 0;
    const out: string[][] = Array.from({ length: cols }, () => new Array<string>(rows).fill(' '));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[c]![rows - 1 - r] = g[r]![c]!;
    }
    g = out;
  }
  return g;
}

/**
 * Prefab/vault placement. Centers an ASCII footprint on each target (a single
 * point, or every feature with `at_tag`), painting its tiles and claiming the
 * footprint as BUILDING so routes detour around it. Cells flagged in
 * `prefab.anchors` are left un-claimed and registered as anchor features (e.g.
 * a door), giving later route ops a walkable connection point. Optional seeded
 * rotation varies otherwise-identical prefabs.
 */
function applyStamp(op: Extract<GenOp, { type: 'stamp' }>, bb: Blackboard): void {
  const scale = Math.max(1, Math.round(op.scale ?? 1));
  const claimFlag = CLAIM_BY_NAME[op.claim ?? 'building'];

  const targets: Array<{ pt: { x: number; y: number }; id: string; tags?: string[] }> = [];
  if (op.at_tag) {
    for (const f of bb.features.byTag(op.at_tag)) {
      if (f.at) targets.push({ pt: f.at, id: f.id, tags: f.tags });
    }
  } else if (op.at) {
    // Post-ops pre-resolve any SemanticAt to {x,y}, so op.at is a PointRef here.
    const at = (op.placement === 'perimeter' && 'edge' in op.at)
      ? { ...(op.at as PointRef), inset: bb.inset }
      : (op.at as PointRef);
    targets.push({ pt: resolvePoint(at, bb), id: op.anchor_prefix ?? 'stamp' });
  } else {
    console.warn('[mapgen] stamp: neither at nor at_tag set — nothing to place.');
    return;
  }

  const onlyFree = op.only_free ?? false;
  const rng = op.rotate === 'random' ? bb.subRng(op.seed ?? 'stamp') : null;
  for (const { pt, id, tags } of targets) {
    // Select prefab: use role_prefab if the site has a matching role tag.
    const activeRef = (() => {
      if (op.role_prefabs && tags) {
        for (const [role, rp] of Object.entries(op.role_prefabs)) {
          if (tags.includes(role)) return rp;
        }
      }
      return op.prefab;
    })();
    const activePrefab = resolvePrefab(activeRef, bb);
    if (!activePrefab) continue;

    const base = activePrefab.data.replace(/\n+$/, '').split('\n').map((l) => [...l]);
    const legend = activePrefab.legend;
    const anchors = activePrefab.anchors ?? {};

    const turns = op.rotate === 'random'
      ? Math.floor(rng!() * 4)
      : (typeof op.rotate === 'number' ? op.rotate / 90 : 0);
    const grid = rotateMatrix(base, turns);
    const ph = grid.length, pw = grid[0]?.length ?? 0;
    const ox = pt.x - Math.floor((pw * scale) / 2);
    const oy = pt.y - Math.floor((ph * scale) / 2);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < ph; r++) {
      for (let c = 0; c < pw; c++) {
        const ch = grid[r]![c]!;
        const tile = legend[ch];
        if (tile === undefined) continue;       // unmapped char = passthrough
        const anchorTag = anchors[ch];
        const bx = ox + c * scale, by = oy + r * scale;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = bx + sx, py = by + sy;
            if (!bb.inBounds(px, py)) continue;
            if (onlyFree && !bb.isFree(px, py, CLAIM.BUILDING)) continue;
            bb.paint(px, py, tile);
            if (!anchorTag) bb.claim(px, py, claimFlag);  // door cells stay routable
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
          }
        }
        if (anchorTag) {
          bb.addAnchor(`${id}_${anchorTag}`, { x: bx, y: by }, { tags: [anchorTag] });
        }
      }
    }

    // When stamping by tag, incorporate the site's role tag (if any) into the
    // region name so the workbench canvas shows "plot_1_tavern" rather than
    // a generic "plot_1_interior".
    const roleTag = (op.role_prefabs && tags)
      ? Object.keys(op.role_prefabs).find(r => tags.includes(r))
      : undefined;
    const regionId = op.region
      ? (op.at_tag ? `${id}_${roleTag ?? op.region}` : op.region)
      : null;
    if (regionId && maxX >= minX) {
      bb.addRegion(regionId, { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, { tags: ['interior'] });
    }
  }
}

/**
 * Atomic find-and-stamp. Samples candidate positions within the placement
 * region, checks the full prefab bounding box against keepout, and stamps
 * on first fit. Footprint-aware — won't clip existing buildings or walls.
 */
function applyPlace(op: Extract<GenOp, { type: 'place' }>, bb: Blackboard): void {
  const region = op.placement === 'internal' && bb.inset > 0
    ? { x: bb.inset, y: bb.inset, w: Math.max(0, bb.width - bb.inset * 2), h: Math.max(0, bb.height - bb.inset * 2) }
    : { x: 0, y: 0, w: bb.width, h: bb.height };

  const rng       = bb.subRng(op.seed);
  const over      = toSet(op.over);
  const margin    = op.margin ?? 1;
  const claimFlag = CLAIM_BY_NAME[op.claim ?? 'building'];

  const prefab = resolvePrefab(op.prefab, bb);
  if (!prefab) return;
  const base = prefab.data.replace(/\n+$/, '').split('\n').map(l => [...l]);
  const turns = op.rotate ? Math.floor(rng() * 4) : 0;
  const grid  = rotateMatrix(base, turns);
  const ph = grid.length, pw = grid[0]?.length ?? 0;
  const legend  = prefab.legend;
  const anchors = prefab.anchors ?? {};

  // Build the list of mapped cells relative to the top-left corner.
  const cells: Array<{ r: number; c: number; tile: string; anchorTag?: string }> = [];
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      const ch = grid[r]![c]!;
      const tile = legend[ch];
      if (tile === undefined) continue;
      cells.push({ r, c, tile, anchorTag: anchors[ch] });
    }
  }

  const maxTries = Math.max(200, region.w * region.h);
  // Commit the prefab with its top-left at (ox, oy): paint cells, claim, anchors,
  // register the region.
  const stampAt = (ox: number, oy: number): void => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { r, c, tile, anchorTag } of cells) {
      const px = ox + c, py = oy + r;
      if (!bb.inBounds(px, py)) continue;
      bb.paint(px, py, tile);
      if (!anchorTag) bb.claim(px, py, claimFlag);
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (anchorTag) {
        const prefix = op.anchor_prefix ?? 'place';
        bb.addAnchor(`${prefix}_${anchorTag}`, { x: px, y: py }, { tags: [anchorTag] });
      }
    }
    if (op.region && maxX >= minX) {
      bb.addRegion(op.region, { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, { tags: ['interior'] });
    }
  };

  // Pinned placement (feature `at` override): center the prefab on the tile and
  // place it there unconditionally — the author chose the spot.
  if (op.at) {
    stampAt(Math.round(op.at.x) - (pw >> 1), Math.round(op.at.y) - (ph >> 1));
    return;
  }

  for (let t = 0; t < maxTries; t++) {
    // Sample a top-left corner so the prefab fits within the region + margin.
    const ox = region.x + margin + Math.floor(rng() * Math.max(1, region.w - pw - margin * 2));
    const oy = region.y + margin + Math.floor(rng() * Math.max(1, region.h - ph - margin * 2));

    // Check every mapped cell: must be in bounds, not claimed, and over the right tile.
    let fits = true;
    for (const { r, c, anchorTag } of cells) {
      const px = ox + c, py = oy + r;
      if (!bb.inBounds(px, py)) { fits = false; break; }
      if (!anchorTag && !bb.isFree(px, py, CLAIM.BUILDING | CLAIM.RESERVED)) { fits = false; break; }
      if (over && !over.has(bb.tileAt(px, py)!)) { fits = false; break; }
    }
    if (!fits) continue;

    stampAt(ox, oy);
    return;
  }

  console.warn(`[mapgen] place '${op.region ?? op.seed}': no free location found after ${maxTries} tries.`);
}

function toSet(v: string | string[] | undefined): Set<string> | null {
  if (v == null) return null;
  return Array.isArray(v) ? new Set(v) : new Set([v]);
}

interface BspNode { rect: RegionBounds; left?: BspNode; right?: BspNode; room?: RegionBounds }

/**
 * Binary space partition. Recursively splits the bounds, carves one room per
 * leaf, and connects sibling rooms with L-shaped corridors — yielding rectangular
 * rooms joined into one reachable graph (the built-interior complement to `cave`).
 */
function applyBsp(op: Extract<GenOp, { type: 'bsp' }>, bb: Blackboard): void {
  const region = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: bb.width, h: bb.height };
  const rng = bb.subRng(op.seed);
  const minRoom = op.min_room ?? 4;
  const maxRoom = op.max_room ?? 10;
  const margin = op.margin ?? 1;
  const maxDepth = op.max_depth ?? 5;
  const corridorW = op.corridor_width ?? 1;
  const prefix = op.region_prefix ?? 'room';
  const MIN_LEAF = minRoom + 2 * margin;

  if (op.wall !== undefined) paintRect(bb.grid, region.x, region.y, region.w, region.h, op.wall);

  const trySplit = (r: RegionBounds): [RegionBounds, RegionBounds] | null => {
    const canH = r.h >= MIN_LEAF * 2;
    const canV = r.w >= MIN_LEAF * 2;
    if (!canH && !canV) return null;
    let horizontal: boolean;
    if (canH && canV) horizontal = r.w > r.h * 1.25 ? false : r.h > r.w * 1.25 ? true : rng() < 0.5;
    else horizontal = canH;
    const dim = horizontal ? r.h : r.w;
    const cut = MIN_LEAF + Math.floor(rng() * (dim - 2 * MIN_LEAF + 1));
    return horizontal
      ? [{ x: r.x, y: r.y, w: r.w, h: cut }, { x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }]
      : [{ x: r.x, y: r.y, w: cut, h: r.h }, { x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }];
  };

  const roomDim = (leafDim: number): number => {
    const avail = leafDim - 2 * margin;
    if (avail < minRoom) return Math.max(1, leafDim - 2);
    return minRoom + Math.floor(rng() * (Math.min(maxRoom, avail) - minRoom + 1));
  };
  const place = (start: number, leafDim: number, room: number): number => {
    const lo = start + margin;
    const hi = start + leafDim - margin - room;
    if (hi <= lo) return start + Math.max(0, Math.floor((leafDim - room) / 2));
    return lo + Math.floor(rng() * (hi - lo + 1));
  };
  const makeRoom = (leaf: RegionBounds): RegionBounds => {
    const w = roomDim(leaf.w), h = roomDim(leaf.h);
    return { x: place(leaf.x, leaf.w, w), y: place(leaf.y, leaf.h, h), w, h };
  };

  const build = (r: RegionBounds, depth: number): BspNode => {
    const node: BspNode = { rect: r };
    const s = depth < maxDepth ? trySplit(r) : null;
    if (!s) { node.room = makeRoom(r); return node; }
    node.left = build(s[0], depth + 1);
    node.right = build(s[1], depth + 1);
    return node;
  };

  const tree = build(region, 0);

  // Paint rooms + register regions; track the largest for `<prefix>_main`.
  let i = 0;
  let largest: RegionBounds | null = null;
  const paintRooms = (node: BspNode): void => {
    if (node.room) {
      paintRect(bb.grid, node.room.x, node.room.y, node.room.w, node.room.h, op.floor);
      bb.addRegion(`${prefix}_${++i}`, node.room, { tags: op.tags ?? [] });
      if (!largest || node.room.w * node.room.h > largest.w * largest.h) largest = node.room;
      return;
    }
    if (node.left) paintRooms(node.left);
    if (node.right) paintRooms(node.right);
  };
  paintRooms(tree);
  if (largest) bb.addRegion(`${prefix}_main`, largest, { tags: ['main'] });

  // Connect: each internal node joins its children's representative rooms.
  const center = (r: RegionBounds) => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });
  const connect = (node: BspNode): { x: number; y: number } => {
    if (node.room) return center(node.room);
    const a = connect(node.left!);
    const b = connect(node.right!);
    carveCorridor(bb, a, b, op.floor, corridorW);
    return a;
  };
  connect(tree);
}

/** L-shaped corridor (horizontal then vertical) — orthogonal steps keep it 4-connected. */
function carveCorridor(
  bb: Blackboard, a: { x: number; y: number }, b: { x: number; y: number }, tile: string, width: number,
): void {
  const half = Math.max(0, Math.floor((width - 1) / 2));
  const stamp = (cx: number, cy: number): void => {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        if (bb.inBounds(cx + ox, cy + oy)) bb.grid[cy + oy]![cx + ox] = tile;
      }
    }
  };
  let x = a.x, y = a.y;
  stamp(x, y);
  while (x !== b.x) { x += x < b.x ? 1 : -1; stamp(x, y); }
  while (y !== b.y) { y += y < b.y ? 1 : -1; stamp(x, y); }
}

/**
 * Blue-noise site placement (Poisson-disk by rejection). Scatters `count`
 * points at least `spacing` apart on free, optionally tile-restricted cells,
 * registers each as a `site` feature, and reserves a keepout disc so later
 * placements (and other sites) keep their distance.
 */
function drawWeightedRole(roles: Array<{ role: string; weight: number }>, rng: () => number): string {
  const total = roles.reduce((s, r) => s + r.weight, 0);
  let pick = rng() * total;
  for (const { role, weight } of roles) {
    pick -= weight;
    if (pick <= 0) return role;
  }
  return roles[roles.length - 1]!.role;
}

function applyScatterSites(op: Extract<GenOp, { type: 'scatter_sites' }>, bb: Blackboard): void {
  const region = op.bounds
    ? resolveBoundsRef(op.bounds, bb)
    : op.placement === 'internal' && bb.inset > 0
      ? { x: bb.inset, y: bb.inset, w: Math.max(0, bb.width - bb.inset * 2), h: Math.max(0, bb.height - bb.inset * 2) }
      : { x: 0, y: 0, w: bb.width, h: bb.height };
  const rng = bb.subRng(op.seed);
  const over = toSet(op.over);
  const spacing = Math.max(1, op.spacing);
  const claimR = op.claim_radius ?? Math.ceil(spacing / 2);
  const claimFlag = CLAIM_BY_NAME[op.claim ?? 'site'];
  const margin = op.margin ?? 2;
  const prefix = op.id_prefix ?? 'site';

  // Sequential role PRNG seeded from the Blackboard (varies with zone seed).
  // Must be set up before the placement loop so draws are ordered and max
  // counts can be tracked across sites.
  const roleRng = op.roles?.length ? bb.subRng(String(op.seed) + '_roles') : null;
  const roleCounts: Record<string, number> = {};

  // Optional concentration toward a point: pull each uniformly-sampled candidate
  // toward (cx, cy) by a factor rng()**magnitude (magnitude 0 → no pull, uniform).
  const conc = op.concentrate;
  const cx = region.x + (conc?.fx ?? 0.5) * region.w;
  const cy = region.y + (conc?.fy ?? 0.5) * region.h;
  const mag = conc?.magnitude ?? 0;

  const placed: Array<{ x: number; y: number }> = [];
  const maxTries = Math.max(40, op.count * 40);
  // Pinned first site (feature `at` override): place it exactly, then let the
  // remaining sites scatter normally around it.
  if (op.at) {
    const px = Math.max(region.x + margin, Math.min(region.x + region.w - margin - 1, Math.round(op.at.x)));
    const py = Math.max(region.y + margin, Math.min(region.y + region.h - margin - 1, Math.round(op.at.y)));
    placed.push({ x: px, y: py });
    const id = `${prefix}_1`;
    const siteTags = [...(op.tags ?? [])];
    if (roleRng && op.roles) { const role = drawWeightedRole(op.roles, roleRng); roleCounts[role] = 1; siteTags.push(role); }
    bb.addSite(id, { x: px, y: py }, { tags: siteTags });
    bb.claimDisc(px, py, claimR, claimFlag);
    if (op.clear) paintCircle(bb.grid, px + 0.5, py + 0.5, op.clear.radius ?? Math.max(1, claimR - 1), op.clear.tile);
  }
  for (let t = 0; t < maxTries && placed.length < op.count; t++) {
    let x = region.x + Math.floor(rng() * region.w);
    let y = region.y + Math.floor(rng() * region.h);
    if (mag > 0) {
      const f = Math.pow(rng(), mag);
      x = Math.round(cx + (x - cx) * f);
      y = Math.round(cy + (y - cy) * f);
    }
    if (x < region.x + margin || y < region.y + margin || x >= region.x + region.w - margin || y >= region.y + region.h - margin) continue;
    if (over && !over.has(bb.tileAt(x, y)!)) continue;
    if (!bb.isFree(x, y)) continue;                          // respect prior claims
    if (placed.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < spacing * spacing)) continue;
    placed.push({ x, y });
    const id = `${prefix}_${placed.length}`;
    const siteTags = [...(op.tags ?? [])];
    if (roleRng && op.roles) {
      // Respect per-role max counts; fall back to full pool if all maxes hit.
      const available = op.roles.filter(r => r.max === undefined || (roleCounts[r.role] ?? 0) < r.max);
      const pool = available.length ? available : op.roles;
      const role = drawWeightedRole(pool, roleRng);
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      siteTags.push(role);
    }
    bb.addSite(id, { x, y }, { tags: siteTags });
    bb.claimDisc(x, y, claimR, claimFlag);
    if (op.clear) {
      const r = op.clear.radius ?? Math.max(1, claimR - 1);
      paintCircle(bb.grid, x + 0.5, y + 0.5, r, op.clear.tile);
    }
  }
  if (placed.length < op.count) {
    console.warn(
      `[mapgen] scatter_sites '${prefix}': placed ${placed.length}/${op.count} ` +
      `(spacing ${spacing} too tight for the free area).`,
    );
  }
}

/**
 * Cost-aware routing. A* over the (resynced) cost layer from each source to the
 * target, carving `tile` along the path. Endpoints are forced enterable so a
 * route can reach a door beside walls; intermediate impassable cells are
 * avoided, so roads bend around forests and water. Building-claimed cells are
 * never carved through. `from_tag` fans out from every tagged feature (a star
 * network); routes carved earlier become cheap, so later ones merge onto them.
 */
function applyRoute(op: Extract<GenOp, { type: 'route' }>, bb: Blackboard): void {
  bb.syncCostFromGrid();
  const claimRoad = op.claim_road ?? true;
  const width = op.width ?? 1;
  const through = toSet(op.through);
  const throughCost = op.through_cost ?? 6;

  // Build the (start, goal) pairs to carve, from whichever mode is set.
  const pairs: Array<{ start: { x: number; y: number }; goal: { x: number; y: number } }> = [];
  if (op.edges) {
    for (const e of bb.features.byTag(op.edges)) {
      if (e.kind !== 'edge' || !e.ends) continue;
      try {
        pairs.push({ start: resolvePoint({ feature: e.ends[0] }, bb), goal: resolvePoint({ feature: e.ends[1] }, bb) });
      } catch { /* skip edges whose endpoints went missing */ }
    }
  } else if (op.from_tag || op.from) {
    if (!op.to) { console.warn('[mapgen] route: from/from_tag requires `to`.'); return; }
    let goal: { x: number; y: number };
    try { goal = resolvePoint(op.to, bb); }
    catch (e) { console.warn(`[mapgen] route: 'to' unresolvable — ${(e as Error).message}`); return; }
    if (op.from_tag) {
      for (const f of bb.features.byTag(op.from_tag)) {
        const p = pointOf(f);
        if (p) pairs.push({ start: p, goal });
      }
    } else {
      try { pairs.push({ start: resolvePoint(op.from!, bb), goal }); }
      catch (e) { console.warn(`[mapgen] route: 'from' unresolvable — ${(e as Error).message} — skipping.`); return; }
    }
  } else {
    console.warn('[mapgen] route: set one of edges, from_tag, or from.');
    return;
  }

  // Anchor cells (doors) are connection points, not pavement — a road leads up
  // to them but never paves over them, whether endpoint or passed through.
  const anchorCells = new Set<number>();
  for (const f of bb.features.byKind('anchor')) {
    if (f.at) anchorCells.add(f.at.y * bb.width + f.at.x);
  }

  for (const { start, goal } of pairs) {
    const path = aStar(bb, start, goal, through, throughCost);
    if (!path) {
      console.warn(`[mapgen] route: no path from (${start.x},${start.y}) to (${goal.x},${goal.y}).`);
      continue;
    }
    carvePath(bb, path, op.tile, width, claimRoad, anchorCells);
  }
}

/** Stamp a road along `path` at the given width, skipping building and anchor cells. */
function carvePath(
  bb: Blackboard, path: Array<{ x: number; y: number }>, tile: string, width: number,
  claimRoad: boolean, anchorCells: Set<number>,
): void {
  const half = Math.max(0, Math.floor((width - 1) / 2));
  for (const { x, y } of path) {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const px = x + ox, py = y + oy;
        if (!bb.inBounds(px, py)) continue;
        if (!bb.isFree(px, py, CLAIM.BUILDING)) continue;  // don't punch through buildings
        if (anchorCells.has(py * bb.width + px)) continue;  // leave doors as doors
        bb.paint(px, py, tile);
        if (claimRoad) bb.claim(px, py, CLAIM.ROAD);
      }
    }
  }
}

/**
 * A* over the cost layer (4-connected). Entering a cell costs bb.cost[cell];
 * the goal is always enterable so routes can terminate at a door. Returns the
 * cell path start→goal, or null if unreachable.
 */
function aStar(
  bb: Blackboard, start: { x: number; y: number }, goal: { x: number; y: number },
  through: Set<string> | null = null, throughCost = 6,
): Array<{ x: number; y: number }> | null {
  const W = bb.width, H = bb.height, N = W * H;
  if (!bb.inBounds(start.x, start.y) || !bb.inBounds(goal.x, goal.y)) return null;
  const sk = start.y * W + start.x;
  const gk = goal.y * W + goal.x;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const heur = (k: number) => Math.abs((k % W) - goal.x) + Math.abs(((k / W) | 0) - goal.y);

  g[sk] = 0;
  heap.push(heur(sk), sk);
  const DIRS = [-W, W, -1, 1];
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === gk) break;
    const cx = cur % W;
    const gc = g[cur]!;
    for (const d of DIRS) {
      if (d === -1 && cx === 0) continue;
      if (d === 1 && cx === W - 1) continue;
      const nk = cur + d;
      if (nk < 0 || nk >= N) continue;
      let enter: number;
      if (nk === gk) {
        enter = 1;                                       // goal forced reachable
      } else if ((bb.keepout[nk]! & CLAIM.BUILDING) !== 0) {
        continue;                                        // never cross buildings
      } else {
        const c = bb.cost[nk]!;
        if (Number.isFinite(c)) {
          enter = c;
        } else if (through && through.has(bb.grid[(nk / W) | 0]![nk % W]!)) {
          enter = throughCost;                           // clearable obstacle (e.g. tree)
        } else {
          continue;                                      // true barrier (wall/water/void)
        }
      }
      const ng = gc + enter;
      if (ng < g[nk]!) { g[nk] = ng; came[nk] = cur; heap.push(ng + heur(nk), nk); }
    }
  }
  if (gk !== sk && came[gk] === -1) return null;

  const path: Array<{ x: number; y: number }> = [];
  let c = gk;
  while (c !== -1) {
    path.push({ x: c % W, y: (c / W) | 0 });
    if (c === sk) break;
    c = came[c]!;
  }
  return path.reverse();
}

/** Minimal binary min-heap over (priority, value) pairs. Deterministic. */
class MinHeap {
  private pri: number[] = [];
  private val: number[] = [];
  get size(): number { return this.val.length; }
  push(priority: number, value: number): void {
    this.pri.push(priority); this.val.push(value);
    let i = this.val.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.pri[p]! <= this.pri[i]!) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const n = this.val.length;
    const topV = this.val[0]!;
    const lastV = this.val.pop()!; const lastP = this.pri.pop()!;
    if (n > 1) {
      this.val[0] = lastV; this.pri[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < this.val.length && this.pri[l]! < this.pri[s]!) s = l;
        if (r < this.val.length && this.pri[r]! < this.pri[s]!) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return topV;
  }
  private swap(a: number, b: number): void {
    [this.pri[a], this.pri[b]] = [this.pri[b]!, this.pri[a]!];
    [this.val[a], this.val[b]] = [this.val[b]!, this.val[a]!];
  }
}

/**
 * Cellular-automata cavern op. Generates an organic, guaranteed-connected open
 * field within `bounds`, paints open cells as `floor` (and solid cells as `wall`
 * when set), and registers the open extent as a named region plus a 1×1
 * `<region>_anchor` region at an always-open cell for spawn_point/focal use.
 */
function applyCave(op: Extract<GenOp, { type: 'cave' }>, bb: Blackboard): void {
  const b = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: bb.width, h: bb.height };
  const open = generateCave(b.w, b.h, {
    seed: op.seed,
    fill: op.fill,
    iterations: op.iterations,
    minPocket: op.min_pocket,
    connect: op.connect,
    tunnelWidth: op.tunnel_width,
  });

  for (let y = 0; y < b.h; y++) {
    const orow = open[y];
    if (!orow) continue;
    for (let x = 0; x < b.w; x++) {
      if (orow[x]) bb.paint(b.x + x, b.y + y, op.floor);
      else if (op.wall !== undefined) bb.paint(b.x + x, b.y + y, op.wall);
    }
  }

  if (op.region) {
    const { aabb, anchor } = openExtent(open);
    if (aabb) {
      bb.addRegion(op.region, { x: b.x + aabb.x, y: b.y + aabb.y, w: aabb.w, h: aabb.h }, { tags: ['cave'] });
    }
    if (anchor) {
      bb.addRegion(`${op.region}_anchor`, { x: b.x + anchor.x, y: b.y + anchor.y, w: 1, h: 1 }, { tags: ['anchor'] });
    }
  }
}

/**
 * Voronoi region decomposition. Assigns every tile in `bounds` to the nearest
 * cell seed (multiplicatively weighted, so higher-weight cells claim more
 * territory), paints that cell's floor, and registers each cell as a named
 * region. Optionally paints a one-tile seam where two cells meet. Fully
 * deterministic — territory is a pure function of the seed coordinates.
 */
function applyVoronoi(op: Extract<GenOp, { type: 'voronoi' }>, bb: Blackboard): void {
  if (!op.cells || op.cells.length === 0) return;
  const width = bb.width, height = bb.height;
  const b = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: width, h: height };
  const over = op.over == null
    ? null
    : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));

  const seeds = op.cells.map((c) => {
    const pt = resolvePoint(c.at, bb);
    return { id: c.id, floor: c.floor, weight: c.weight && c.weight > 0 ? c.weight : 1, x: pt.x, y: pt.y };
  });

  // Per-tile nearest-cell assignment. Store the seed index for the optional
  // border pass; track each cell's AABB for region registration.
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  const x1 = Math.min(width, b.x + b.w), y1 = Math.min(height, b.y + b.h);
  const assign: Int16Array = new Int16Array(width * height).fill(-1);
  const aabb = seeds.map(() => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }));

  for (let y = y0; y < y1; y++) {
    const row = bb.grid[y]!;
    for (let x = x0; x < x1; x++) {
      if (over && !over.has(row[x]!)) continue;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i]!;
        const dx = x - s.x, dy = y - s.y;
        // Multiplicatively weighted: divide squared distance by weight² so a
        // cell with weight 2 reaches ~2× as far as a unit cell.
        const d = (dx * dx + dy * dy) / (s.weight * s.weight);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;
      assign[y * width + x] = best;
      row[x] = seeds[best]!.floor;
      const bbx = aabb[best]!;
      if (x < bbx.minX) bbx.minX = x; if (x > bbx.maxX) bbx.maxX = x;
      if (y < bbx.minY) bbx.minY = y; if (y > bbx.maxY) bbx.maxY = y;
    }
  }

  // Optional seam: a tile whose assigned cell differs from its east/south
  // neighbour becomes the border tile. One-sided check avoids double-thick seams.
  if (op.border) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const me = assign[y * width + x];
        if (me < 0) continue;
        const right = x + 1 < x1 ? assign[y * width + x + 1] : me;
        const down = y + 1 < y1 ? assign[(y + 1) * width + x] : me;
        if ((right >= 0 && right !== me) || (down >= 0 && down !== me)) {
          bb.grid[y]![x] = op.border.tile;
        }
      }
    }
  }

  // Register each cell as a named region (AABB of its assigned tiles). Cells
  // that claimed no tiles fall back to a 1×1 box at their seed.
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    const bbx = aabb[i]!;
    const rect = bbx.maxX >= bbx.minX
      ? { x: bbx.minX, y: bbx.minY, w: bbx.maxX - bbx.minX + 1, h: bbx.maxY - bbx.minY + 1 }
      : { x: clampToZone(s, width, height).x, y: clampToZone(s, width, height).y, w: 1, h: 1 };
    bb.addRegion(s.id, rect, { tags: ['voronoi'] });
  }
}

export function isBlocked(
  grid: Grid,
  x: number,
  y: number,
  blockingTiles: ReadonlySet<string> = BLOCKING,
): boolean {
  if (y < 0 || y >= grid.length) return true;
  if (x < 0 || x >= grid[0]!.length) return true;
  return blockingTiles.has(grid[y]![x]!);
}

export type { Grid, RegionBounds };
export { Blackboard };
