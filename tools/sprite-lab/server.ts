// Sprite Lab — the authoring harness for the player paper-doll's gear overlays
// (docs/plan-player-sprites.md, Phase 2).
//
// The point over drawing blind: overlay art is worthless until it lines up with
// the body's pose contract, and a wrong hand anchor means redrawing every
// weapon. So this renders the REAL compositor — shared/playerComposite.ts, the
// same code the client calls — against every class, material, rarity and brand
// combination, straight off the PNGs on disk. Save in Aseprite, hit reload,
// see it in the game's own pixels.
//
//   npm run sprite-lab   ->   http://localhost:3005
import express from 'express';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { BRAND_COLORS, MATERIAL_VISUALS, gearVisuals, rarityColor } from '../../shared/itemVisuals.ts';
import { GRID, POSE_ANCHORS, SPRITE_SIZE, TEMPLATES, handColumns, renderComposite } from '../../shared/playerComposite.ts';
import type { ClassId, Equipment, InventoryStack } from '../../shared/types.ts';
import {
  GEAR_DIR, LayerSizeError, TRANSPARENT, loadGearLayer, pixelsToSteps,
  playerSpritePng, rgbaToPng, saveGearLayer, stepsToPixels,
} from '../lib/playerSpritePng.ts';
import { CENTRE_PIVOT, handPivot, rotateSteps } from '../lib/spriteTransform.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const PORT = 3005;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));
// Serve the overlays themselves so the lab can show each layer's raw grayscale
// next to the composite. no-store: re-saving art must not need a hard refresh.
app.use('/gear', express.static(GEAR_DIR, { etag: false, lastModified: false, cacheControl: false }));

interface MaterialRow { id: string; name: string; class: string; armor_tag?: string }
interface ArchetypeRow { id: string; name: string; slot: string; material_classes: string[] }

function readYaml<T>(rel: string, key: string): T[] {
  return (yaml.load(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, T[]>)[key] ?? [];
}

/** Which overlays actually have art. Re-read per request — dropping a new PNG
 *  into client/public/gear/ should show up on reload, not on restart. */
function drawnLayers(): string[] {
  if (!existsSync(GEAR_DIR)) return [];
  return readdirSync(GEAR_DIR).filter((f) => f.endsWith('.png')).map((f) => basename(f, '.png')).sort();
}

app.get('/api/meta', (_req, res) => {
  const materials = readYaml<MaterialRow>('world/entities/items/materials.yaml', 'materials');
  const archetypes = readYaml<ArchetypeRow>('world/entities/items/archetypes.yaml', 'archetypes');
  res.json({
    classes: Object.keys(TEMPLATES),
    materials: materials.map((m) => ({ ...m, ramp: MATERIAL_VISUALS[m.id]?.ramp ?? null })),
    archetypes,
    rarities: ['common', 'uncommon', 'rare', 'legendary'].map((r) => ({ id: r, color: rarityColor(r) })),
    brands: Object.entries(BRAND_COLORS).map(([id, color]) => ({ id, color })),
    poseAnchors: POSE_ANCHORS,
    // Per class, since each body's arms sit at slightly different columns.
    handColumns: Object.fromEntries(
      Object.keys(TEMPLATES).map((k) => [k, handColumns(k as ClassId)]),
    ),
    grid: GRID,
    spriteSize: SPRITE_SIZE,
    drawn: drawnLayers(),
  });
});

/** Build the Equipment shape gearVisuals expects from flat query params, so the
 *  preview goes through the same resolver the client does. */
function equipmentFromQuery(q: Record<string, unknown>): Equipment {
  const eq: Record<string, InventoryStack | null> = {};
  const put = (slot: string, base: unknown, rarity: unknown, brand: unknown) => {
    if (typeof base !== 'string' || !base) return;
    eq[slot] = {
      base, name: base, sprite: base,
      item: { id: base, type: 'item', components: { equipment: {
        base, affixes: [],
        rolled: (brand ? { weapon_brand: String(brand) } : {}) as never,
        rarity: (rarity as never) ?? undefined,
      } } },
    } as InventoryStack;
  };
  put('mainhand', q.mainhand, q.rarity, q.brand);
  put('chest', q.chest, q.armorRarity, null);
  put('helmet', q.helmet, q.armorRarity, null);
  return eq as Equipment;
}

const LAYER_RE = /^[a-z][a-z0-9_]*$/;

function sendSprite(
  res: express.Response,
  q: Record<string, unknown>,
  drafts?: Record<string, Uint8ClampedArray>,
): void {
  const scale = Math.max(1, Math.min(16, Number(q.scale) || 6));
  try {
    const { png, missing } = playerSpritePng(
      { klass: (q.klass as ClassId) || 'fighter', color: (q.color as string) || '#6ec6f0' },
      gearVisuals(equipmentFromQuery(q)),
      { scale, drafts },
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    // Header rather than a body field: the browser wants this as an <img>.
    res.setHeader('X-Missing-Layers', missing.join(',') || 'none');
    res.end(png);
  } catch (err) {
    const status = err instanceof LayerSizeError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
}

app.get('/api/sprite.png', (req, res) => sendSprite(res, req.query as Record<string, unknown>));

/** Same render, but with the editor's unsaved art standing in for one layer —
 *  so a stroke shows up on the character before anything touches disk. */
app.post('/api/sprite.png', (req, res) => {
  const { params = {}, draft } = req.body as {
    params?: Record<string, unknown>;
    draft?: { layer?: string; steps?: number[] };
  };
  const drafts = draft?.layer && Array.isArray(draft.steps)
    ? { [draft.layer]: stepsToPixels(draft.steps) }
    : undefined;
  sendSprite(res, params, drafts);
});

/** The authored art for one overlay, as steps — what the editor loads into its
 *  canvas. An overlay nobody has drawn comes back blank rather than 404: a new
 *  layer and an empty one are the same thing to the editor. */
app.get('/api/layer/:name', (req, res) => {
  const name = req.params.name;
  if (!LAYER_RE.test(name)) return res.status(400).json({ error: `invalid layer name: ${name}` });
  try {
    const pixels = loadGearLayer(name);
    const steps = pixels ? pixelsToSteps(pixels) : new Int8Array(SPRITE_SIZE * SPRITE_SIZE).fill(TRANSPARENT);
    res.json({ name, size: SPRITE_SIZE, exists: !!pixels, steps: [...steps] });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Preview a rotation. Deliberately not applied to disk or to the editor's
 * committed art — the tool holds the result as a draft until Apply, because at
 * anything off a quarter turn a rotation is a lossy operation you want to see
 * before you accept.
 */
app.post('/api/rotate', (req, res) => {
  const { steps, angle, pivot = 'hand', klass = 'fighter' } = req.body as {
    steps?: number[]; angle?: number; pivot?: 'hand' | 'centre'; klass?: ClassId;
  };
  if (!Array.isArray(steps) || steps.length !== SPRITE_SIZE * SPRITE_SIZE) {
    return res.status(400).json({ error: `steps must be ${SPRITE_SIZE * SPRITE_SIZE} entries` });
  }
  if (!Number.isFinite(angle)) return res.status(400).json({ error: 'angle must be a number' });
  const at = pivot === 'centre' ? CENTRE_PIVOT : handPivot(klass);
  res.json({ steps: [...rotateSteps(steps, angle as number, at)], pivot: at });
});

app.put('/api/layer/:name', (req, res) => {
  const name = req.params.name;
  if (!LAYER_RE.test(name)) return res.status(400).json({ error: `invalid layer name: ${name}` });
  const steps = (req.body as { steps?: number[] }).steps;
  if (!Array.isArray(steps) || steps.length !== SPRITE_SIZE * SPRITE_SIZE) {
    return res.status(400).json({ error: `steps must be ${SPRITE_SIZE * SPRITE_SIZE} entries` });
  }
  try {
    saveGearLayer(name, steps);
    res.json({ ok: true, path: `client/public/gear/${name}.png` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * The reference layer to draw against: the bare body, dimmed, with the pose
 * contract's anchor rows striped across it. Generated rather than committed so
 * it can never go stale against the templates it describes — import it into
 * Aseprite as a background layer, draw the overlay on top, export just the
 * overlay.
 */
app.get('/api/pose-guide.png', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const scale = Math.max(1, Math.min(16, Number(q.scale) || 6));
  const rgba = renderComposite({ klass: (q.klass as ClassId) || 'fighter', color: '#7f7f7f' });
  const CELL = SPRITE_SIZE / GRID;

  for (let p = 0; p < SPRITE_SIZE * SPRITE_SIZE; p++) rgba[p * 4 + 3] = Math.round(rgba[p * 4 + 3]! * 0.45);

  // One magenta stripe per anchor band, full width, so a weapon's grip row and
  // an armor piece's shoulder line can be eyeballed against it.
  for (const anchor of POSE_ANCHORS) {
    for (let row = anchor.from; row <= anchor.to; row++) {
      for (let dy = 0; dy < CELL; dy++) {
        const y = row * CELL + dy;
        for (let x = 0; x < SPRITE_SIZE; x += 2) {
          const i = (y * SPRITE_SIZE + x) * 4;
          rgba[i] = 255; rgba[i + 1] = 0; rgba[i + 2] = 200; rgba[i + 3] = 150;
        }
      }
    }
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.end(rgbaToPng(rgba, scale));
});

app.listen(PORT, () => {
  console.log(`[sprite-lab] http://localhost:${PORT}  (overlays in ${GEAR_DIR})`);
});
