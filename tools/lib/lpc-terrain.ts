// Reader for a Tiled terrain tileset (LPC_Terrain: Terrain.tsx + terrain.png).
//
// Tiled's `terraintypes` + per-tile `terrain="tl,tr,bl,br"` is a corner Wang
// set — the same model as pickTileLayers in shared/tileset.ts, which is why the
// sheet drops into the renderer with no change to how a tile is resolved. Each
// terrain ships 13 of the 16 corner combinations as art over transparency, so a
// material is one alpha sheet that composites over whatever is beneath it.
//
// The three it doesn't ship are the empty mask and the two diagonal-only
// combinations; those are assembled from the single-corner tiles on import.

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export const TILE_PX = 32;

/** Corner bits, matching shared/tileset.ts: NW=1, NE=2, SE=4, SW=8. */
export const MASK_DIAG_NW_SE = 1 | 4;
export const MASK_DIAG_NE_SW = 2 | 8;

export interface LpcTerrain {
  name: string;
  /** corner mask → tile index in the sheet (row-major, 32 columns). */
  byMask: Map<number, number>;
}

export interface LpcSheet {
  png: PNG;
  cols: number;
  terrains: LpcTerrain[];
}

export function readLpcSheet(tsxPath: string, pngPath: string): LpcSheet {
  const xml = readFileSync(tsxPath, 'utf8');
  const png = PNG.sync.read(readFileSync(pngPath));
  const cols = Math.floor(png.width / TILE_PX);

  const terrains: LpcTerrain[] = [...xml.matchAll(/<terrain\s+name="([^"]+)"/g)]
    .map(m => ({ name: m[1]!, byMask: new Map<number, number>() }));

  for (const m of xml.matchAll(/<tile\s+id="(\d+)"\s+terrain="([^"]*)"\s*\/>/g)) {
    const id = Number(m[1]);
    // Tiled writes the corners as top-left, top-right, bottom-left,
    // bottom-right; an empty slot means "not this terrain".
    const [tl, tr, bl, br] = m[2]!.split(',');
    const present = [tl, tr, bl, br].filter(c => c !== '');
    // Only single-terrain tiles are usable as a layer: a tile mixing two
    // terrains has the other one baked into it, which defeats compositing.
    if (present.length === 0 || new Set(present).size !== 1) continue;
    const terrain = terrains[Number(present[0])];
    if (!terrain) continue;
    const mask = (tl !== '' ? 1 : 0) | (tr !== '' ? 2 : 0) | (br !== '' ? 4 : 0) | (bl !== '' ? 8 : 0);
    // First one wins: a few terrains list the same corner shape twice (recolour
    // rows), and taking the earliest keeps a terrain's tiles contiguous.
    if (!terrain.byMask.has(mask)) terrain.byMask.set(mask, id);
  }
  return { png, cols, terrains };
}

/** Copy one sheet tile into `dst` at (dx, dy), preserving alpha. Straight
 *  nearest-neighbour: source and destination are both 32px, so this is a
 *  1:1 blit, not a resample. */
export function blitTile(sheet: LpcSheet, tileIndex: number, dst: PNG, dx: number, dy: number): void {
  const sx = (tileIndex % sheet.cols) * TILE_PX;
  const sy = Math.floor(tileIndex / sheet.cols) * TILE_PX;
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const si = (((sy + y) * sheet.png.width) + (sx + x)) << 2;
      const a = sheet.png.data[si + 3]!;
      if (a === 0) continue;
      const di = (((dy + y) * dst.width) + (dx + x)) << 2;
      // Source-over, so a diagonal mask assembled from two single-corner tiles
      // composites instead of the second one punching a hole in the first.
      const sa = a / 255, da = dst.data[di + 3]! / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[di + c] = Math.round(
          (sheet.png.data[si + c]! * sa + dst.data[di + c]! * da * (1 - sa)) / (oa || 1),
        );
      }
      dst.data[di + 3] = Math.round(oa * 255);
    }
  }
}
