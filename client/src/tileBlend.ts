// Corner-blend rendering: turns the coverage masks pickTileLayers computes
// (shared/tileset.ts) into actual pixels.
//
// The point of the experiment is that this costs *no new art*. Rather than
// baking a transition sheet per material — let alone per material pair — the
// 16 corner masks are generated procedurally here and applied to the material
// art already in client/public/tiles/. Adding a material to the blend is a
// blendOrder in the tileset and nothing else.
//
// The mask shape itself is cornerMaskAlpha in shared/tileset.ts, so the
// headless comparison renderer (tools/tile-blend-compare.ts) cuts pixel-for-
// pixel identical edges to the ones the game draws.

import { MASK_FULL, cornerMaskAlpha } from '../../shared/tileset.ts';

// Matches the baked tile art (64px), not the 32px it renders at: masking at
// source resolution and letting the main canvas downscale keeps blended tiles
// looking identical to unblended ones.
const MASK_PX = 64;

const masks = new Map<string, HTMLCanvasElement>();

// `px` is the resolution to cut at: the baked art's 64, or an LPC cell's 32.
// Cutting at source resolution and letting the main canvas downscale keeps a
// blended tile looking identical to an unblended one.
function getMask(mask: number, px = MASK_PX): HTMLCanvasElement {
  const key = `${mask}|${px}`;
  let c = masks.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const img = g.createImageData(px, px);
  for (let my = 0; my < px; my++) {
    for (let mx = 0; mx < px; mx++) {
      const a = cornerMaskAlpha(mask, (mx + 0.5) / px, (my + 0.5) / px);
      img.data[(my * px + mx) * 4 + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  masks.set(key, c);
  return c;
}

// Masked material tiles, keyed "<tileSpriteId>|<mask>". Compositing per tile
// per frame would mean an offscreen draw for every visible tile; the set of
// (material variant × mask) pairs is small and fixed, so they are built once.
const masked = new Map<string, HTMLCanvasElement>();

/** The material art for `spriteId` clipped to `mask`, ready to draw. `img` is
 *  the loaded source tile — the caller owns the image cache, and must not call
 *  this before the image has loaded or the cut would be of a blank frame. */
export function getMaskedTile(
  spriteId: string, mask: number, img: HTMLImageElement,
): HTMLCanvasElement {
  const key = `${spriteId}|${mask}`;
  let c = masked.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = MASK_PX;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, MASK_PX, MASK_PX);
  if (mask !== MASK_FULL) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(getMask(mask, MASK_PX), 0, 0);
  }
  masked.set(key, c);
  return c;
}

// ── Imported LPC edge art ──────────────────────────────────────────────────
// The authored counterpart to the procedural masks above. tools/lpc-import.ts
// bakes each material into a 4x4 atlas indexed by the same corner mask, so the
// renderer swaps one lookup for the other and changes nothing else — which is
// the whole reason the layer stack was built around masks rather than around a
// particular way of producing them.

const LPC_CELL = 32;
const lpcAtlases = new Map<string, HTMLImageElement | null>();

/** The LPC atlas for a material, or null if it has none (not every tile is
 *  mapped — the renderer falls back to the procedural mask for those). */
export function getLpcAtlas(tileId: string): HTMLImageElement | null {
  if (lpcAtlases.has(tileId)) return lpcAtlases.get(tileId)!;
  lpcAtlases.set(tileId, null); // mark as loading
  const img = new Image();
  img.onload = () => lpcAtlases.set(tileId, img);
  img.onerror = () => {}; // unmapped material — stays null, caller falls back
  img.src = `/tiles/lpc/${tileId}.png`;
  return null;
}

/** Source rect of `mask` within an LPC atlas: cell (mask >> 2, mask & 3). */
export function lpcCell(mask: number): [number, number, number, number] {
  return [(mask & 3) * LPC_CELL, (mask >> 2) * LPC_CELL, LPC_CELL, LPC_CELL];
}

/** Source rect of one of a material's full-coverage interiors: `tone` (row)
 *  is a shade of the material, `detail` (column) is where its scattered bits
 *  fall. Only meaningful for MASK_FULL — every other mask carries edge art and
 *  exists once. */
export function lpcFillCell(
  tone: number, detail: number,
): [number, number, number, number] {
  return [detail * LPC_CELL, (4 + tone) * LPC_CELL, LPC_CELL, LPC_CELL];
}

/** How many tones and details the atlas carries, read off its two dimensions:
 *  the corner set is the first four rows and every row past it is a tone, each
 *  as wide as the material has details. Deriving it from the PNG means no
 *  manifest to keep in sync with tools/lpc-import.ts. */
export function lpcFillCounts(atlas: HTMLImageElement): [number, number] {
  return [atlas.height / LPC_CELL - 4, atlas.width / LPC_CELL];
}

/** One tone of a material's interior, cut to the corners that tone won. A tone
 *  change would otherwise be an axis-aligned staircase — the same blockiness
 *  corner blending removed from material seams, just moved to a seam inside a
 *  single material — so it is resolved through the same masks, off the corner
 *  tones pickCornerTone agrees on between neighbours. */
const maskedFills = new Map<string, HTMLCanvasElement>();

export function getMaskedFill(
  atlas: HTMLImageElement, tileId: string, tone: number, detail: number, mask: number,
): HTMLCanvasElement {
  const key = `${tileId}|${tone}|${detail}|${mask}`;
  let c = maskedFills.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = LPC_CELL;
  const g = c.getContext('2d')!;
  const [sx, sy, sw, sh] = lpcFillCell(tone, detail);
  g.drawImage(atlas, sx, sy, sw, sh, 0, 0, LPC_CELL, LPC_CELL);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(getMask(mask, LPC_CELL), 0, 0);
  maskedFills.set(key, c);
  return c;
}
