// CLI: import LPC terrain art into the corner-blend renderer.
//
//   npx tsx tools/lpc-import.ts --src=~/Downloads/LPC_Terrain
//
// Emits one 4x4 atlas per mapped tile id into client/public/tiles/lpc/, where
// cell (mask >> 2, mask & 3) is that material's art for corner mask `mask` —
// the same masks pickTileLayers produces, so the renderer indexes an atlas the
// same way it indexes a procedural mask.
//
// This is the authored-art half of the seam experiment: the sheet ships 13 of
// the 16 corner shapes drawn by hand over transparency, which is precisely the
// "one alpha edge sheet per material" arrangement the procedural masking in
// client/src/tileBlend.ts was standing in for. Empty and the two diagonal-only
// masks aren't shipped; the diagonals are assembled here from the two
// single-corner tiles.
//
// LPC_Terrain is CC-BY-SA 3.0 / GPL 3.0 — share-alike. Attribution.txt is
// copied next to the art because redistribution requires it; read it before
// this goes anywhere public.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { blitTile, readLpcSheet, MASK_DIAG_NE_SW, MASK_DIAG_NW_SE, TILE_PX } from './lib/lpc-terrain.ts';

// Our tile id → LPC terrain name. Chosen for the starting village, whose ground
// is grass/dirt with a little stone. Terrains whose edge art has another
// material baked into it are avoided: "Earth" is drawn with a grass fringe, so
// it only composites correctly over grass, while "Trans Dirt" has a generic
// pebbled edge that works over anything.
const MAPPING: Record<string, string> = {
  sand: 'Sand',
  dirt: 'Trans Dirt',
  grass: 'Grass',
  stone_floor: 'Brick Road',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'client', 'public', 'tiles', 'lpc');

const srcArg = process.argv.slice(2).find(a => a.startsWith('--src='))?.slice('--src='.length)
  ?? join(homedir(), 'Downloads', 'LPC_Terrain');
const src = srcArg.startsWith('~') ? join(homedir(), srcArg.slice(1)) : srcArg;

const sheet = readLpcSheet(join(src, 'Terrain.tsx'), join(src, 'terrain.png'));
mkdirSync(OUT_DIR, { recursive: true });

for (const [tileId, terrainName] of Object.entries(MAPPING)) {
  const terrain = sheet.terrains.find(t => t.name === terrainName);
  if (!terrain) throw new Error(`no LPC terrain named "${terrainName}"`);

  const atlas = new PNG({ width: TILE_PX * 4, height: TILE_PX * 4 });
  atlas.data.fill(0);
  const put = (mask: number, tileIndex: number) =>
    blitTile(sheet, tileIndex, atlas, (mask & 3) * TILE_PX, (mask >> 2) * TILE_PX);

  for (const [mask, tileIndex] of terrain.byMask) put(mask, tileIndex);

  // The two diagonal-only masks: the sheet has no art for a material touching
  // a tile at opposite corners only, so stack the two single-corner tiles.
  // They don't overlap, so compositing them is exactly the missing shape.
  for (const [diag, a, b] of [[MASK_DIAG_NW_SE, 1, 4], [MASK_DIAG_NE_SW, 2, 8]] as const) {
    if (terrain.byMask.has(diag)) continue;
    for (const corner of [a, b]) {
      const idx = terrain.byMask.get(corner);
      if (idx !== undefined) put(diag, idx);
    }
  }

  const out = join(OUT_DIR, `${tileId}.png`);
  writeFileSync(out, PNG.sync.write(atlas));
  console.log(`${tileId.padEnd(12)} ← ${terrainName.padEnd(12)} ${terrain.byMask.size} authored + 2 assembled → ${out}`);
}

const attribution = join(src, 'Attribution.txt');
if (existsSync(attribution)) {
  copyFileSync(attribution, join(OUT_DIR, 'Attribution.txt'));
  console.log(`\nCC-BY-SA 3.0 / GPL 3.0 — Attribution.txt copied to ${OUT_DIR}`);
}
