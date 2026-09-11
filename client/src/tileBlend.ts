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

const masks = new Map<number, HTMLCanvasElement>();

function getMask(mask: number): HTMLCanvasElement {
  let c = masks.get(mask);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = MASK_PX;
  const g = c.getContext('2d')!;
  const img = g.createImageData(MASK_PX, MASK_PX);
  for (let py = 0; py < MASK_PX; py++) {
    for (let px = 0; px < MASK_PX; px++) {
      const a = cornerMaskAlpha(mask, (px + 0.5) / MASK_PX, (py + 0.5) / MASK_PX);
      img.data[(py * MASK_PX + px) * 4 + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  masks.set(mask, c);
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
    g.drawImage(getMask(mask), 0, 0);
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
