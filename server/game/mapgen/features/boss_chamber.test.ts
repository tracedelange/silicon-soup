import { describe, expect, it } from 'vitest';
import { generateZoneGrid } from '../index.ts';
import { BIOME_REGISTRY, resolveBiomeGenOps } from '../biomes/index.ts';
import type { ZoneDef } from '../../../../shared/types.ts';

const BLOCKING = new Set(['wall', 'cracked_wall', 'water']);

// A rotating dungeon interior: the layout re-rolls every epoch, which is exactly
// the condition boss_chamber exists to survive.
function dungeonAt(epoch: number): ZoneDef {
  const biome = BIOME_REGISTRY['dungeon']!;
  const seed = `test_warren:${epoch}`;
  const { ops } = resolveBiomeGenOps(biome, seed, { features: [{ id: 'boss_chamber' }] });
  return {
    id: 'test_warren', seed, width: 48, height: 40,
    default_tile: biome.defaultTile, tileset: biome.tileset, ops,
  } as ZoneDef;
}

function floodReaches(grid: string[][], from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  const h = grid.length, w = grid[0]!.length;
  const seen = new Set<number>([from.y * w + from.x]);
  const queue = [from];
  while (queue.length) {
    const p = queue.pop()!;
    if (p.x === to.x && p.y === to.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = ny * w + nx;
      if (seen.has(k) || BLOCKING.has(grid[ny]![nx]!)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return false;
}

const EPOCHS = 40;

describe('boss_chamber', () => {
  // The three guarantees, each the thing that breaks without one of the three
  // ops: exists (region cannot fail), open (reserve-phase claim), reachable
  // (decorate-phase ensure_reach).
  it('exists in every epoch', () => {
    for (let e = 0; e < EPOCHS; e++) {
      const { bounds } = generateZoneGrid(dungeonAt(e), BLOCKING);
      expect(bounds.boss_chamber, `epoch ${e}`).toBeDefined();
    }
  });

  it('is entirely open ground in every epoch', () => {
    for (let e = 0; e < EPOCHS; e++) {
      const { grid, bounds } = generateZoneGrid(dungeonAt(e), BLOCKING);
      const b = bounds.boss_chamber!;
      let blocked = 0;
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) if (BLOCKING.has(grid[y]![x]!)) blocked++;
      }
      expect(blocked, `epoch ${e}`).toBe(0);
    }
  });

  it('is reachable from the entrance room in every epoch', () => {
    for (let e = 0; e < EPOCHS; e++) {
      const { grid, bounds } = generateZoneGrid(dungeonAt(e), BLOCKING);
      const b = bounds.boss_chamber!;
      const entry = bounds.room_1!;
      const from = { x: entry.x + (entry.w >> 1), y: entry.y + (entry.h >> 1) };
      const to = { x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) };
      expect(floodReaches(grid, from, to), `epoch ${e}`).toBe(true);
    }
  });

  // The problem that motivated it: a boss sharing the arrival room means the
  // fight starts before the player has taken a step.
  it('is never the entrance room', () => {
    for (let e = 0; e < EPOCHS; e++) {
      const { bounds } = generateZoneGrid(dungeonAt(e), BLOCKING);
      const b = bounds.boss_chamber!;
      const entry = bounds.room_1!;
      const overlap = b.x < entry.x + entry.w && entry.x < b.x + b.w
        && b.y < entry.y + entry.h && entry.y < b.y + b.h;
      expect(overlap, `epoch ${e}`).toBe(false);
    }
  });

  // Without the reserve-phase claim, bsp's wall pass buries the chamber — the
  // whole reason `claim` had to be taught to bsp rather than only to scatter.
  it('survives bsp, which would otherwise wall it over', () => {
    const biome = BIOME_REGISTRY['dungeon']!;
    const { ops } = resolveBiomeGenOps(biome, 'unclaimed:1', { features: [{ id: 'boss_chamber' }] });
    const unclaimed = ops.map(op => (op.type === 'region' && op.id === 'boss_chamber' ? { ...op, claim: undefined } : op));
    const zone = { id: 'z', seed: 'unclaimed:1', width: 48, height: 40, default_tile: biome.defaultTile, ops: unclaimed } as ZoneDef;
    const { grid, bounds } = generateZoneGrid(zone, BLOCKING);
    const b = bounds.boss_chamber!;
    let blocked = 0;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) if (BLOCKING.has(grid[y]![x]!)) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });
});
