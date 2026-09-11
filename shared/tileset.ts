// Shared tileset helpers. Both the client renderer (hex strings → canvas) and
// the pipeline PNG renderer (RGB tuples → raw pixels) need to read tile and
// sprite colors out of a Tileset. Keep that flatten-the-map logic here.
//
// Fallback colors are caller-specified — the client may want a less alarming
// default for missing sprites in-game, while the pipeline renderer wants
// magenta everywhere so missing assets shout at you in the PNG.

import type { Tileset } from './types.ts';
import { hashString, valueNoise } from './worldgen/noise.ts';

export function buildTileColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.tiles).map(([k, v]) => [k, v.color]),
  );
}

// Fixed salt — tile variant choice is a cosmetic rendering detail, not part of
// the world seed, so it doesn't need to vary per-world. Same (tileId, x, y)
// always picks the same variant, so it's stable across re-renders/reconnects
// without persisting anything.
const TILE_VARIANT_SALT = 0x7a11e;

// Feature size (tiles) of a variant "patch". Picking a variant per-tile from
// an independent per-position hash is white noise — every tile edge is a
// coin flip, so it reads as static/salt-and-pepper instead of organic ground.
// Sampling a smooth, low-frequency noise field instead (same valueNoise used
// for elevation/temperature) gives neighboring tiles correlated values, so a
// variant shows up as a multi-tile patch, the way real terrain actually
// varies. Bigger = calmer/larger patches; smaller = more frequent switching.
const TILE_VARIANT_PATCH_SCALE = 8;

// tileId → derived variant seed. Tile ids are a small fixed vocabulary.
const variantSeeds = new Map<string, number>();

/** Deterministic per-position variant index for a tile with a sprite-variant
 *  library (see TileEntry.variants). Both client and any future tooling that
 *  needs to agree on "which variant is this tile" (e.g. a world-gen preview)
 *  can call this and get the same answer.
 *
 *  `weights` (see TileEntry.variantWeights) skews which variant a given patch
 *  of noise lands on — e.g. make the busiest/most-distinctive variant rarer
 *  than the calm default — without reintroducing per-tile noise, since it's
 *  just a non-uniform split of the same smooth noise range. Omitted or
 *  mismatched length falls back to a uniform split. */
export function pickTileVariant(
  tileId: string, x: number, y: number, variantCount: number, weights?: number[],
): number {
  if (variantCount <= 1) return 0;
  // Memoized: this is called for every visible tile every frame, and hashing
  // the id string per call showed up as the hot path in the render loop.
  let seed = variantSeeds.get(tileId);
  if (seed === undefined) {
    seed = (TILE_VARIANT_SALT ^ hashString(tileId)) >>> 0;
    variantSeeds.set(tileId, seed);
  }
  const n = valueNoise(x, y, TILE_VARIANT_PATCH_SCALE, seed); // smooth [0, 1)

  if (!weights || weights.length !== variantCount) {
    return Math.min(variantCount - 1, Math.floor(n * variantCount));
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const target = n * total;
  let acc = 0;
  for (let i = 0; i < variantCount; i++) {
    acc += weights[i]!;
    if (target < acc) return i;
  }
  return variantCount - 1; // floating-point edge case at target ≈ total
}

// ── Seam dithering ─────────────────────────────────────────────────────────
// pickTileVariant solves variation *within* a material. This solves the seam
// *between* two materials: without it every biome boundary is an axis-aligned
// staircase of 32px squares, because wildTileAt is pointwise and knows nothing
// about its neighbours.
//
// The trick is to spend no new art on it. A tile sitting next to a different
// ground material sometimes renders as that neighbour's material instead, so
// the two interlock in fingers rather than meeting on a straight line. It is
// purely cosmetic — the tile id the rest of the game sees (walkability,
// pathing, server truth) is untouched, which is exactly why only tiles opted
// in with TileEntry.blend may take part: swapping a blocking or decorative
// tile would draw a lie about where the player can walk.

const SEAM_DITHER_SALT = 0x5ea3d;

// Patch size (tiles) of the dither. Deliberately much smaller than
// TILE_VARIANT_PATCH_SCALE — variants want calm multi-tile patches, a seam
// wants short interlocking fingers — but still smooth rather than white
// noise, so swapped tiles clump into peninsulas instead of static.
const SEAM_DITHER_SCALE = 2.5;

// Swap probability for a tile completely surrounded by the other material.
// Below 1 so even the deepest tile of a seam keeps a little of its own
// material showing through.
const SEAM_DITHER_STRENGTH = 0.9;

// Neighbour offsets and their pull. An edge-sharing neighbour blends twice as
// hard as a corner-sharing one, so a tile touching the other material only at
// a diagonal barely ever swaps.
const SEAM_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 2], [1, 0, 2], [0, 1, 2], [-1, 0, 2],
  [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1],
];
const SEAM_WEIGHT_TOTAL = 12;

const seamSeeds = new Map<string, number>();

// Scratch tally, reused across calls — this runs for every visible tile every
// frame and a fresh Map per tile showed up immediately in the render profile.
// Safe because rendering is single-threaded and the tally never escapes.
const seamIds: string[] = new Array(8);
const seamWeights: number[] = new Array(8);

/** The material to *draw* at (x, y), which is `tileId` except in the dither
 *  band along a seam with another blendable material. `neighborAt(dx, dy)`
 *  returns the tile id at the given offset (any id is fine for off-map — a
 *  tile without `blend` simply never participates).
 *
 *  Deterministic in (x, y) alone, like pickTileVariant, so it is stable across
 *  re-renders, reconnects and camera movement without persisting anything. */
export function pickSeamTile(
  tileId: string, x: number, y: number, ts: Tileset,
  neighborAt: (dx: number, dy: number) => string,
): string {
  if (!ts.tiles[tileId]?.blend) return tileId;

  let distinct = 0;
  for (const [dx, dy, w] of SEAM_NEIGHBORS) {
    const n = neighborAt(dx, dy);
    if (n === tileId || !ts.tiles[n]?.blend) continue;
    let i = 0;
    while (i < distinct && seamIds[i] !== n) i++;
    if (i === distinct) { seamIds[i] = n; seamWeights[i] = 0; distinct++; }
    seamWeights[i] += w;
  }
  if (distinct === 0) return tileId;

  // Heaviest neighbouring material wins. Ties break on the first one seen,
  // which SEAM_NEIGHBORS pins to a fixed order, so the result stays
  // deterministic rather than depending on iteration luck.
  let best = 0;
  for (let i = 1; i < distinct; i++) if (seamWeights[i]! > seamWeights[best]!) best = i;
  const other = seamIds[best]!;

  // Seeded by the *destination* material, not the pair: each material gets its
  // own field, so grass encroaches on sand where grass's field is high and
  // sand encroaches on grass where sand's is. A shared field would slide the
  // whole boundary one way instead of interlocking it.
  let seed = seamSeeds.get(other);
  if (seed === undefined) {
    seed = (SEAM_DITHER_SALT ^ hashString(other)) >>> 0;
    seamSeeds.set(other, seed);
  }
  const p = (seamWeights[best]! / SEAM_WEIGHT_TOTAL) * SEAM_DITHER_STRENGTH;
  return valueNoise(x, y, SEAM_DITHER_SCALE, seed) < p ? other : tileId;
}

export function buildSpriteColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.sprites).map(([k, v]) => [k, v.color]),
  );
}

/** Parse "#rrggbb" (or "rrggbb") to an RGB tuple. Returns magenta on bad input. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── Corner (Wang) blending ─────────────────────────────────────────────────
// The experimental alternative to the seam dither above. Same goal — two
// materials should interlock rather than meet on a grid line — but solved with
// coverage masks instead of by swapping whole tiles, so the boundary is a
// curve through the tile rather than a dithered band of 32px squares.
//
// The model is *precedence*, not pairs: every participating material gets a
// TileEntry.blendOrder, the tile's own material is drawn edge to edge, and each
// higher-order material present in the neighbourhood is drawn over it clipped
// to the corners it wins. That is what keeps the art cost linear — one mask set
// per material instead of one transition per material *pair* — so adding a
// material never requires touching the ones already there.
//
// A corner's material is the highest-order of the four cells touching it, so
// two adjacent tiles always agree about the corner they share. That shared
// value is what makes the masks line up across the tile boundary with no seam.
//
// Known tradeoff, inherent to corner tiling: a lone tile of a low-order
// material surrounded by a higher one wins no corners and is covered
// completely. Mapgen produces patches rather than single tiles for the ground
// materials, which is why blendOrder is opt-in per tile rather than on by
// default — a material that appears as isolated tiles should not set it.

/** One material to draw at a tile, clipped to `mask`. */
export interface TileLayer {
  tile: string;
  /** 4-bit corner coverage, bit 0 = NW, 1 = NE, 2 = SE, 3 = SW. 15 = full tile. */
  mask: number;
}

export const MASK_FULL = 15;
/** Upper bound on layers written by pickTileLayers: the tile's own material
 *  plus one per corner. Sizes the caller's scratch buffer. */
export const MAX_TILE_LAYERS = 5;

// Corner order matches the mask bits: NW, NE, SE, SW. Each entry lists the
// three neighbour offsets sharing that corner with the tile itself.
const CORNER_NEIGHBORS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-1, -1], [0, -1], [-1, 0]], // NW
  [[1, -1], [0, -1], [1, 0]],   // NE
  [[1, 1], [0, 1], [1, 0]],     // SE
  [[-1, 1], [0, 1], [-1, 0]],   // SW
];

// Scratch corner tallies, reused across calls. Like the seam-dither buffers
// above, this runs for every visible tile every frame and per-tile allocation
// showed up immediately in the render profile. Safe because rendering is
// single-threaded and neither array escapes.
const cornerTile: string[] = new Array(4);
const cornerOrder: number[] = new Array(4);

/** Decompose a tile into the ordered list of material layers to draw, writing
 *  into `out` and returning how many entries were written. `out` must hold at
 *  least MAX_TILE_LAYERS entries and is *mutated in place* — the caller is
 *  expected to reuse one buffer across the whole frame rather than allocate.
 *  Layers come back low blendOrder → high, so drawing them in order composites
 *  correctly.
 *
 *  A tile whose material has no `blendOrder` doesn't participate: it comes back
 *  as a single full-coverage layer, i.e. exactly what the renderer drew before.
 *  Non-participating *neighbours* are ignored, so a wall or a tree never pulls
 *  the ground around it — the same rule that keeps pickSeamTile from drawing a
 *  lie about walkability.
 *
 *  Pure in the neighbourhood, with no noise field and no salt, so unlike the
 *  dither there is nothing here that has to stay stable across re-renders. */
export function pickTileLayers(
  tileId: string, ts: Tileset, neighborAt: (dx: number, dy: number) => string,
  out: TileLayer[],
): number {
  // The tile's own material is always the base layer: a corner is the max over
  // four cells *including* this one, so no corner can come back lower-order
  // than the tile itself.
  out[0]!.tile = tileId;
  out[0]!.mask = MASK_FULL;

  const selfOrder = ts.tiles[tileId]?.blendOrder;
  if (selfOrder === undefined) return 1;

  for (let c = 0; c < 4; c++) {
    let bestTile = tileId, bestOrder = selfOrder;
    for (const [dx, dy] of CORNER_NEIGHBORS[c]!) {
      const o = ts.tiles[neighborAt(dx, dy)]?.blendOrder;
      // Strict >: ties keep the tile's own material, so two materials sharing
      // a blendOrder simply don't blend rather than flickering over each other.
      if (o === undefined || o <= bestOrder) continue;
      bestTile = neighborAt(dx, dy); bestOrder = o;
    }
    cornerTile[c] = bestTile; cornerOrder[c] = bestOrder;
  }

  // Each distinct higher material, ascending, masked to every corner at or
  // above it — so a layer covers not just the corners it won but the ones the
  // layers above it won too. That deliberate overlap is what keeps the soft
  // mask edge from opening a gap between two adjacent layers. Ascending order
  // is therefore load-bearing: each layer paints over the one beneath and is
  // painted over in turn. At most four corners, so repeated linear scans beat
  // sorting.
  let n = 1, prevOrder = selfOrder;
  for (;;) {
    let nextOrder = Infinity, nextTile = '';
    for (let c = 0; c < 4; c++) {
      if (cornerOrder[c]! > prevOrder && cornerOrder[c]! < nextOrder) {
        nextOrder = cornerOrder[c]!; nextTile = cornerTile[c]!;
      }
    }
    if (nextTile === '') return n;
    let mask = 0;
    for (let c = 0; c < 4; c++) if (cornerOrder[c]! >= nextOrder) mask |= 1 << c;
    out[n]!.tile = nextTile;
    out[n]!.mask = mask;
    n++;
    prevOrder = nextOrder;
  }
}

// Width of the alpha ramp across the mask threshold, in units of the bilinear
// field. Zero would be a hard, visibly stair-stepped curve at tile resolution;
// this is roughly a two-pixel feather on 64px art — enough to read as a smooth
// edge without smearing the two materials into a gradient.
const CORNER_EDGE_SOFTNESS = 0.09;

/** Coverage of `mask` at (u, v) in the unit square, as alpha in [0, 1].
 *
 *  A bilinear field over the four corner bits, thresholded at the midpoint.
 *  That choice is what makes neighbouring tiles agree: the field is continuous
 *  across a tile boundary whenever the two tiles agree about the corners they
 *  share, which pickTileLayers guarantees, so the curve runs straight through
 *  the seam instead of stopping at it. The four interesting cases come out for
 *  free — one corner is a rounded nub, two adjacent is a half tile, two
 *  diagonal is two nubs, three is a notched full tile. */
export function cornerMaskAlpha(mask: number, u: number, v: number): number {
  const nw = mask & 1 ? 1 : 0, ne = mask & 2 ? 1 : 0;
  const se = mask & 4 ? 1 : 0, sw = mask & 8 ? 1 : 0;
  const w = nw * (1 - u) * (1 - v) + ne * u * (1 - v)
          + sw * (1 - u) * v + se * u * v;
  return Math.max(0, Math.min(1, (w - 0.5) / CORNER_EDGE_SOFTNESS + 0.5));
}

/** A reusable buffer of the right size for pickTileLayers. */
export function makeTileLayerBuffer(): TileLayer[] {
  return Array.from({ length: MAX_TILE_LAYERS }, () => ({ tile: '', mask: MASK_FULL }));
}
