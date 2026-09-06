// CLI: render the same ground several ways side by side, to compare seam
// treatments on identical terrain.
//
//   npx tsx tools/tile-blend-compare.ts [--seed=silicon-soup] [--at=0,0]
//   npx tsx tools/tile-blend-compare.ts --zone=zone_0_0 --at=40,40
//     [--tiles=24] [--scale=2] [--modes=dither,corner,lpc] [--out=path.png]
//
// Modes: `dither` is the shipped seam dither, `corner` is corner blending with
// the procedural mask, `lpc` is corner blending with imported LPC edge art
// (tools/lpc-import.ts). The in-game Shift+B toggle can't do this — you can't
// hold two frames side by side — and the village is login-gated besides.
//
// Everything visual comes from the same modules the client renders with —
// wildTileAt / generateZoneGrid for the terrain, pickSeamTile / pickTileLayers
// for the seam, cornerMaskAlpha for the mask — so a difference in the PNG is a
// real difference in the game.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  MASK_FULL, cornerMaskAlpha, makeTileLayerBuffer, pickSeamTile, pickTileLayers, pickTileVariant,
} from '../shared/tileset.ts';
import { deriveSeeds, wildTileAt } from '../shared/worldgen/field.ts';
import { BLOCKING_TILES } from '../shared/constants.ts';
import { generateZoneGrid } from '../server/game/mapgen/index.ts';
import { loadWorld } from '../server/world/loader.ts';
import type { Tileset } from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const TILE_DIR  = join(ROOT, 'client', 'public', 'tiles');
const OUT_DIR   = join(ROOT, 'world', 'renders');

const args = process.argv.slice(2);
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

const zoneId  = arg('zone');
const modes   = (arg('modes') ?? 'dither,corner,lpc').split(',');
const seed    = arg('seed') ?? 'silicon-soup';
const [atX, atY] = (arg('at') ?? '0,0').split(',').map(Number) as [number, number];
const span    = Number(arg('tiles') ?? 24);
const scale   = Number(arg('scale') ?? 2);
const outPath = arg('out') ?? join(OUT_DIR, 'tile-blend-compare.png');

const ts: Tileset = JSON.parse(readFileSync(join(ROOT, 'world', 'tilesets', 'overworld.json'), 'utf8'));

// Source art is 64px; drawing it at 32 * scale matches what the client shows.
const SRC = 64;
const OUT_TILE = 32 * scale;

const tileArt = new Map<string, PNG | null>();
function art(spriteId: string): PNG | null {
  if (tileArt.has(spriteId)) return tileArt.get(spriteId)!;
  const p = join(TILE_DIR, `${spriteId}.png`);
  const png = existsSync(p) ? PNG.sync.read(readFileSync(p)) : null;
  tileArt.set(spriteId, png);
  return png;
}

// Imported LPC atlases, keyed by tile id. A material with no atlas falls back
// to its baked art plus the procedural mask, so a partial import still renders.
const lpcArt = new Map<string, PNG | null>();
function lpc(tile: string): PNG | null {
  if (lpcArt.has(tile)) return lpcArt.get(tile)!;
  const p = join(TILE_DIR, 'lpc', `${tile}.png`);
  const png = existsSync(p) ? PNG.sync.read(readFileSync(p)) : null;
  lpcArt.set(tile, png);
  return png;
}

function spriteFor(tile: string, x: number, y: number): string | null {
  const entry = ts.tiles[tile];
  const variants = entry?.variants ?? 0;
  if (variants <= 0) return null;
  return `${tile}_${pickTileVariant(tile, x, y, variants, entry?.variantWeights)}`;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Composite one material over the destination tile cell, weighted by the
 *  corner mask. Nearest-neighbour sampled from the source art, the same as the
 *  client's `imageSmoothingEnabled = false` path. */
function blit(
  out: PNG, ox: number, oy: number, tile: string, x: number, y: number, mask: number,
  useLpc = false,
): void {
  // LPC art carries its own alpha edge, so the mask picks a *cell* of the
  // atlas rather than weighting pixels — that difference is the whole point of
  // the comparison.
  const atlas = useLpc ? lpc(tile) : null;
  const src = atlas ? null : spriteFor(tile, x, y);
  const png = atlas ?? (src ? art(src) : null);
  const cell = atlas ? 32 : SRC;
  const cx = atlas ? (mask & 3) * 32 : 0;
  const cy = atlas ? (mask >> 2) * 32 : 0;
  const flat = png ? null : hexRgb(ts.tiles[tile]?.color ?? '#ff00ff');
  for (let py = 0; py < OUT_TILE; py++) {
    for (let px = 0; px < OUT_TILE; px++) {
      const u = (px + 0.5) / OUT_TILE, v = (py + 0.5) / OUT_TILE;
      let a = atlas || mask === MASK_FULL ? 1 : cornerMaskAlpha(mask, u, v);
      if (a <= 0) continue;
      let r: number, g: number, b: number;
      if (png) {
        const si = (((cy + Math.floor(v * cell)) * png.width) + (cx + Math.floor(u * cell))) << 2;
        r = png.data[si]!; g = png.data[si + 1]!; b = png.data[si + 2]!;
        if (atlas) a = png.data[si + 3]! / 255;
        if (a <= 0) continue;
      } else {
        [r, g, b] = flat!;
      }
      const di = ((oy + py) * out.width + (ox + px)) << 2;
      out.data[di]     = Math.round(out.data[di]! * (1 - a) + r * a);
      out.data[di + 1] = Math.round(out.data[di + 1]! * (1 - a) + g * a);
      out.data[di + 2] = Math.round(out.data[di + 2]! * (1 - a) + b * a);
      out.data[di + 3] = 255;
    }
  }
}

let tileAt: (x: number, y: number) => string;
let label: string;
if (zoneId) {
  const world = await loadWorld(join(ROOT, 'world'));
  const zone = world.zones[zoneId];
  if (!zone) throw new Error(`no zone "${zoneId}"`);
  const { grid } = generateZoneGrid(zone, BLOCKING_TILES, world.prefabs);
  tileAt = (x, y) => grid[y]?.[x] ?? 'void';
  label = `zone=${zoneId}`;
} else {
  const seeds = deriveSeeds(seed);
  tileAt = (x, y) => wildTileAt(x, y, seeds);
  label = `seed=${seed}`;
}

const GAP = 8 * scale;
const panel = span * OUT_TILE;
const out = new PNG({ width: panel * modes.length + GAP * (modes.length - 1), height: panel });
out.data.fill(0x18);

const layerBuf = makeTileLayerBuffer();
for (let ty = 0; ty < span; ty++) {
  for (let tx = 0; tx < span; tx++) {
    const x = atX + tx, y = atY + ty;
    const neighborAt = (dx: number, dy: number) => tileAt(x + dx, y + dy);
    const raw = tileAt(x, y);

    modes.forEach((mode, panelIdx) => {
      const ox = panelIdx * (panel + GAP) + tx * OUT_TILE;
      const oy = ty * OUT_TILE;
      if (mode === 'dither') {
        blit(out, ox, oy, pickSeamTile(raw, x, y, ts, neighborAt), x, y, MASK_FULL);
        return;
      }
      const useLpc = mode === 'lpc';
      const n = pickTileLayers(raw, ts, neighborAt, layerBuf);
      // A later full-coverage layer hides everything under it — but only with
      // the procedural mask. LPC's mask-15 cell can be less than fully opaque,
      // so with authored art every layer is drawn.
      let first = 0;
      if (!useLpc) for (let i = n - 1; i > 0; i--) if (layerBuf[i]!.mask === MASK_FULL) { first = i; break; }
      for (let i = first; i < n; i++) {
        blit(out, ox, oy, layerBuf[i]!.tile, x, y, layerBuf[i]!.mask, useLpc);
      }
    });
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, PNG.sync.write(out));

const counts = new Map<string, number>();
for (let ty = 0; ty < span; ty++) {
  for (let tx = 0; tx < span; tx++) {
    const t = tileAt(atX + tx, atY + ty);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
}
console.log(`${label} at=${atX},${atY} ${span}x${span}  panels: ${modes.join(' | ')}`);
console.log('materials:', [...counts].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}×${c}`).join(' '));
console.log('→', outPath);
