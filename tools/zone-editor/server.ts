import express from 'express';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import { loadWorld, resolveBiomeOps, loadBiomeParamOverrides, seedBiomeParams } from '../../server/world/loader.ts';
import { FEATURE_REGISTRY, isAnchorable } from '../../server/game/mapgen/features/index.ts';
import {
  BIOME_REGISTRY, resolvePipelineWithMeta, applyOpParams, mixZoneSeed, mergeFeatures,
} from '../../server/game/mapgen/biomes/index.ts';
import { normalizeZoneFeatures } from '../../server/game/mapgen/zoneFeatures.ts';
import { resolveSeed } from '../../server/game/mapgen/rng.ts';
import { bakeAtlasFootprints, bakeSiteFootprint } from '../../server/game/mapgen/bake.ts';
import { buildAtlas } from '../../shared/worldgen/atlas.ts';
import { biomeAt, dangerAt, deriveSeeds, getLevelBand, wildTileAt } from '../../shared/worldgen/field.ts';
import { epochSeed } from '../../shared/worldgen/epoch.ts';
import { DEFAULT_WORLD_SEED } from '../../shared/worldgen/config.ts';
import { BRAND_KEYS, CLASSES, MOB_ROLES } from '../../shared/constants.ts';
import { AFFINITY_TAGS } from '../../server/game/items/generator.ts';
import { WILD_BIOMES } from '../../shared/worldgen/field.ts';
import { simulateTemplate } from '../lib/combat-sim.ts';
import type { ZoneDef, Tileset, WorldDefs, Prefab, ZoneFeatureEntry, MobTemplate, DungeonDef } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const PORT = 3001;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(__dirname));

// ── File helpers ────────────────────────────────────────────────────────────
function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
function readZoneFile<T>(path: string): T {
  return extname(path) === '.yaml' ? readYaml<T>(path) : readJson<T>(path);
}
function writeZoneFile(path: string, data: unknown): void {
  const text = extname(path) === '.yaml'
    ? yaml.dump(data, { lineWidth: 120, noRefs: true })
    : JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, text, 'utf8');
}
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── World discovery ───────────────────────────────────────────────────────────
// A "world" is any directory under ROOT containing a `zones/` subdir. We detect
// the standard worlds plus any forge run worlds, keyed by their path relative to
// ROOT so the client can address them without exposing arbitrary filesystem paths.
function discoverWorlds(): { key: string; label: string; dir: string }[] {
  const candidates: string[] = [];
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    try { if (statSync(full).isDirectory() && existsSync(join(full, 'zones'))) candidates.push(full); }
    catch {}
  }
  const runsDir = join(ROOT, 'forge', 'runs');
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      const w = join(runsDir, name, 'world');
      try { if (statSync(w).isDirectory() && existsSync(join(w, 'zones'))) candidates.push(w); }
      catch {}
    }
  }
  return candidates
    .map(dir => ({ key: relative(ROOT, dir), label: relative(ROOT, dir), dir }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Resolve a client-supplied world key to a real, whitelisted directory.
function worldDirFor(key: string | undefined): string {
  const worlds = discoverWorlds();
  const fallback = worlds.find(w => w.key === 'world-grown') ?? worlds[0];
  if (!key) {
    if (!fallback) throw new Error('No worlds found (no directory with a zones/ subdir)');
    return fallback.dir;
  }
  const match = worlds.find(w => w.key === key);
  if (!match) throw new Error(`Unknown world: ${key}`);
  return match.dir;
}

// ── Per-world cache (mobs, prefabs, tilesets, blocking set, param overrides) ───
// loadWorld() is the canonical loader; we reuse it so the editor renders exactly
// what the game would. Cached per world dir; cleared on write.
type WorldCtx = {
  defs: WorldDefs;
  paramOverrides: ReturnType<typeof loadBiomeParamOverrides>;
};
const worldCache = new Map<string, WorldCtx>();
function worldCtx(dir: string): WorldCtx {
  let ctx = worldCache.get(dir);
  if (!ctx) {
    ctx = { defs: loadWorld(dir), paramOverrides: loadBiomeParamOverrides(dir) };
    worldCache.set(dir, ctx);
  }
  return ctx;
}

// A site (world/dungeons/*.json) is not one document but three: placement
// metadata, an interior zone template, and — since docs/plan-poi-authoring.md —
// an exterior footprint baked onto the open world. The interior and the
// footprint are both ZoneDefs, so rather than a fourth editor mode they are
// surfaced as ordinary zone documents and every existing tool (paint, region,
// stamp, spawn) works on them unchanged. The suffix is what tells them apart.
const FOOTPRINT_SUFFIX = '__footprint';

/** A new exterior starts transparent: everything the author does not paint falls
 *  through to the real wilderness, which is the shape a footprint wants. */
const BLANK_FOOTPRINT = { tileset: 'overworld', width: 48, height: 48, default_tile: 'transparent', ops: [] };

type ZoneDoc = {
  path: string;
  /** 'zone' = a file in zones/. The other two live inside a dungeon file. */
  kind: 'zone' | 'interior' | 'footprint';
  /** Dungeon id, for the two site kinds. */
  siteId?: string;
  label: string;
};

// Index of zone id → document within a world. Rebuilt each call (cheap; lets new
// files appear without a restart).
function zoneIndex(dir: string): Map<string, ZoneDoc> {
  const idx = new Map<string, ZoneDoc>();
  const zonesDir = join(dir, 'zones');
  for (const f of walk(zonesDir)) {
    const ext = extname(f);
    if (ext !== '.yaml' && ext !== '.json') continue;
    try {
      const z = readZoneFile<ZoneDef>(f);
      if (z?.id) idx.set(z.id, { path: f, kind: 'zone', label: z.name || z.display_name || z.id });
    } catch {}
  }
  const dungeonsDir = join(dir, 'dungeons');
  if (existsSync(dungeonsDir)) {
    for (const f of walk(dungeonsDir)) {
      if (extname(f) !== '.json') continue;
      try {
        const d = readJson<DungeonDef>(f);
        const id = d?.id;
        if (!id) continue;
        idx.set(id, { path: f, kind: 'interior', siteId: id, label: `${d.name || id} — interior` });
        idx.set(id + FOOTPRINT_SUFFIX, {
          path: f, kind: 'footprint', siteId: id,
          label: `${d.name || id} — exterior${d.footprint ? '' : ' (none yet)'}`,
        });
      } catch {}
    }
  }
  return idx;
}

/** The ZoneDef a document holds, with the id/seed the runtime would supply.
 *  A site template must not carry either (the loader rejects it), so they are
 *  synthesized for rendering and stripped again on save. */
function readZoneDoc(doc: ZoneDoc, epoch: number): ZoneDef {
  if (doc.kind === 'zone') return readZoneFile<ZoneDef>(doc.path);
  const d = readJson<DungeonDef>(doc.path);
  // A site with no exterior yet opens as a blank footprint canvas rather than
  // 404 — creating one is just authoring into it and saving.
  const template = doc.kind === 'footprint' ? (d.footprint ?? BLANK_FOOTPRINT) : d.zone;
  const id = doc.kind === 'footprint' ? d.id + FOOTPRINT_SUFFIX : d.id;
  const seed = doc.kind === 'footprint' ? `${d.id}:footprint:${epoch}` : `${d.id}:${epoch}`;
  return { ...template, id, seed } as ZoneDef;
}

function writeZoneDoc(doc: ZoneDoc, def: ZoneDef): void {
  if (doc.kind === 'zone') { writeZoneFile(doc.path, def); return; }
  const d = readJson<DungeonDef>(doc.path);
  const { id: _id, seed: _seed, ...template } = def;
  if (doc.kind === 'footprint') d.footprint = template;
  else d.zone = template;
  writeZoneFile(doc.path, d);
}

// ── Rendering: resolve biome ops + features, then generate the grid ────────────
// Mirrors the game loader: resolveBiomeOps(rawDef) → generateZoneGrid(resolved).
function renderZone(rawDef: ZoneDef, dir: string) {
  const { defs, paramOverrides } = worldCtx(dir);
  const prefabs: Record<string, Prefab> = defs.prefabs;

  // Capture mapgen/loader console.warn output so the UI can surface it.
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let resolved: ZoneDef, grid: string[][], bounds: Record<string, unknown>, width: number, height: number, focal: unknown;
  try {
    resolved = resolveBiomeOps(rawDef, paramOverrides, prefabs);
    ({ grid, bounds, width, height, focal } = generateZoneGrid(resolved, defs.blockingTiles, prefabs) as never);
  } finally {
    console.warn = origWarn;
  }

  // Validate spawns against loaded mobs and resolved regions.
  for (const sp of rawDef.spawns ?? []) {
    if (!defs.mobs[sp.entity]) warnings.push(`spawn → unknown entity "${sp.entity}" (no mob template in this world)`);
    if (sp.region && !sp.if_region && !(sp.region in (bounds as object))) warnings.push(`spawn "${sp.entity}" → region "${sp.region}" does not exist in the rendered zone`);
  }

  let tileColors: Record<string, string> = {};
  let spriteColors: Record<string, string> = {};
  const tsName = resolved.tileset;
  const ts: Tileset | undefined = tsName ? defs.tilesets[tsName] : undefined;
  let blockingTiles: string[] = [];
  if (ts) {
    tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
    spriteColors = Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color]));
    blockingTiles = Object.entries(ts.tiles).filter(([, v]) => v.blocking).map(([k]) => k);
  }
  return { grid, bounds, width, height, focal, tileColors, spriteColors, blockingTiles, resolvedTileset: tsName ?? null, warnings };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/worlds', (_req, res) => {
  res.json(discoverWorlds().map(w => ({ key: w.key, label: w.label })));
});

app.get('/api/zones', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const zones = [...zoneIndex(dir)].map(([id, doc]) => ({ id, name: doc.label, kind: doc.kind, siteId: doc.siteId }));
    res.json(zones.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Load a single zone: raw def (for editing) + rendered grid (for preview).
app.get('/api/zones/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const doc = zoneIndex(dir).get(req.params.id!);
    if (!doc) return res.status(404).json({ error: `Zone not found: ${req.params.id}` });
    const def = readZoneDoc(doc, Number(req.query.epoch ?? 0));
    const render = renderZone(def, dir);
    res.json({
      def, format: extname(doc.path).slice(1), path: relative(ROOT, doc.path),
      kind: doc.kind, siteId: doc.siteId ?? null, ...render,
    });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Render an arbitrary def WITHOUT writing it (live preview as the user edits).
app.post('/api/render', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const def = req.body as ZoneDef;
    if (!def || typeof def !== 'object') return res.status(400).json({ error: 'def required' });
    res.json(renderZone(def, dir));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Save the full def back to its file (preserving the file's format).
app.put('/api/zones/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const doc = zoneIndex(dir).get(req.params.id!);
    if (!doc) return res.status(404).json({ error: `Zone not found: ${req.params.id}` });
    const def = req.body as ZoneDef;
    if (!def || typeof def !== 'object') return res.status(400).json({ error: 'def required' });
    writeZoneDoc(doc, def);
    worldCache.delete(dir); // def may change prefab/feature resolution; reload next render
    res.json({ ok: true, path: relative(ROOT, doc.path) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/entities', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const { mobs } = worldCtx(dir).defs;
    const list = Object.values(mobs).map(m => ({
      id: m.id, name: m.name, sprite: m.sprite, role: m.role,
      fixture: (m as { fixture?: boolean }).fixture,
      light_radius: m.light_radius,
    }));
    res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Available content for the "add feature" picker: registry operators + prefabs.
app.get('/api/features', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const operators = Object.entries(FEATURE_REGISTRY).map(([id, op]) => ({
      id,
      note: op.note,
      anchorable: isAnchorable(id),
      params: (op.params ?? []).map(p => ({
        field: p.field, label: p.label, min: p.min, max: p.max, step: p.step, default: p.default,
      })),
    }));
    const prefabs = Object.keys(worldCtx(dir).defs.prefabs).sort();
    res.json({ operators, prefabs });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Deconstruct a biome zone: bake the biome's basePipeline into concrete `ops`
// (seeded once with the biome's default params), list the biome's + zone's
// features explicitly, carry defaultPostOps/defaultSpawns/tileset/dims, and drop
// `biome`. The result renders without the biome and is fully hand-editable.
// Does not write — the client loads it as an unsaved edit for review.
app.post('/api/eject', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const def = req.body as ZoneDef;
    if (!def?.biome) return res.status(400).json({ error: 'zone has no biome to eject' });
    const biomeDef = BIOME_REGISTRY[def.biome];
    if (!biomeDef) return res.status(400).json({ error: `unknown biome: ${def.biome}` });
    const { defs, paramOverrides } = worldCtx(dir);
    const prefabs = defs.prefabs;
    const rawSeed = def.seed ?? `${def.id}:default`;
    const seed = resolveSeed(rawSeed);

    // Bake the terrain skeleton: resolve basePipeline with the SAME seeded params
    // the biome would derive (so plot counts etc. match), then seed-mix once.
    // Feature ops stay named in the features array below.
    const { mergedOpParams } = seedBiomeParams(biomeDef, paramOverrides, def, rawSeed);
    const base = applyOpParams(resolvePipelineWithMeta(biomeDef.basePipeline, seed), mergedOpParams);
    const ops = mixZoneSeed(base, seed);

    // Explicit feature list: biome defaults merged with the zone's own feature
    // overrides (registry ops), plus any prefab feature entries, as named entries.
    const normalized = normalizeZoneFeatures(def.features, prefabs);
    const refs = mergeFeatures(biomeDef.features, normalized.overrides);
    const featureEntries: ZoneFeatureEntry[] = [
      ...refs.map(r => (r.params ? { id: r.id, params: r.params } : r.id)),
      ...normalized.prefabEntries.map(p => {
        const e: { id: string; in_region?: string; portal_to?: string; transition?: typeof p.transition } = { id: p.id };
        if (p.in_region) e.in_region = p.in_region;
        if (p.portal_to) e.portal_to = p.portal_to;
        if (p.transition) e.transition = p.transition;
        return Object.keys(e).length === 1 ? e.id : e;
      }),
    ];

    const post_ops = [...(def.post_ops ?? []), ...(biomeDef.defaultPostOps ?? [])];
    const spawns = [...(def.spawns ?? []), ...(biomeDef.defaultSpawns ?? [])];

    const ejected: ZoneDef = { ...def };
    delete ejected.biome;
    delete ejected.opParams;
    delete ejected.zoneParams;
    ejected.tileset = def.tileset ?? biomeDef.tileset;
    ejected.width = def.width ?? biomeDef.width;
    ejected.height = def.height ?? biomeDef.height;
    ejected.default_tile = def.default_tile ?? biomeDef.defaultTile;
    ejected.ops = ops;
    if (featureEntries.length) ejected.features = featureEntries; else delete ejected.features;
    if (post_ops.length) ejected.post_ops = post_ops; else delete ejected.post_ops;
    if (spawns.length) ejected.spawns = spawns; else delete ejected.spawns;

    res.json({ def: ejected });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Create a new blank zone file.
app.post('/api/zones', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const { id, biome, width, height, tileset, default_tile, format } = req.body ?? {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
    if (zoneIndex(dir).has(id)) return res.status(400).json({ error: `zone "${id}" already exists` });
    const ext = format === 'yaml' ? 'yaml' : 'json';
    const path = join(dir, 'zones', `${id}.${ext}`);
    const def: ZoneDef = { id };
    if (biome) def.biome = biome;
    if (width) def.width = Number(width);
    if (height) def.height = Number(height);
    if (tileset) def.tileset = tileset;
    if (default_tile) def.default_tile = default_tile;
    if (!biome && !def.default_tile) def.default_tile = 'grass';
    writeZoneFile(path, def);
    worldCache.delete(dir);
    res.json({ ok: true, id, path: relative(ROOT, path) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Biome metadata for the param editors: declared zoneParams (id/label/min/max/
// step/default) for a biome. Operator feature params come from /api/features.
// ── Site exteriors: bake a footprint and preview it in the field ──────────────
// The authoring half of docs/plan-poi-authoring.md. A footprint previewed
// against a black void tells you nothing about the seam that matters most, so
// these routes composite the bake over the ACTUAL wilderness at the position
// this epoch's seed gives it — through bakeSiteFootprint, the same function the
// running server bakes with, because a preview that lies is worse than none.

const BASE_SEED = process.env.WORLD_SEED || DEFAULT_WORLD_SEED;
/** Tiles of real wilderness drawn around the footprint, so the seam is visible. */
const FIELD_MARGIN = 16;

/** Roster for `dir`, with `override` swapped in for `siteId` — so a preview
 *  reflects unsaved edits, and placement still accounts for every other site. */
function rosterWith(dir: string, siteId: string | null, override: ZoneDef | null): DungeonDef[] {
  const roster = Object.values(worldCtx(dir).defs.dungeons).map(d => ({ ...d }));
  if (siteId && override) {
    const target = roster.find(d => d.id === siteId);
    const { id: _id, seed: _seed, ...template } = override;
    if (target) target.footprint = template;
    else roster.push({ id: siteId, name: siteId, placement: { min_level: 1, max_level: 10 }, zone: { biome: 'cave' } as never, footprint: template });
  }
  return roster;
}

function placedAtlas(dir: string, epoch: number, siteId: string | null, override: ZoneDef | null) {
  const roster = rosterWith(dir, siteId, override);
  const atlas = buildAtlas(epochSeed(BASE_SEED, epoch), 'zone_0_0', roster, epoch);
  const { defs } = worldCtx(dir);
  bakeAtlasFootprints(atlas, roster, defs.blockingTiles, defs.prefabs);
  return { atlas, seeds: deriveSeeds(atlas.numericSeed) };
}

/** Regions a footprint's own content depends on — the ones that must survive
 *  every epoch, since the arrangement re-rolls (plan Consequence 1). */
function referencedRegions(def: ZoneDef): string[] {
  const out = new Set<string>();
  for (const sp of def.spawns ?? []) if (sp.region && !sp.if_region) out.add(sp.region);
  for (const op of (def.post_ops ?? []) as { at?: { center_of_region?: string } }[]) {
    const r = op.at?.center_of_region;
    if (r) out.add(r);
  }
  return [...out];
}

// Bake an (unsaved) footprint and composite it over the real field at the
// position this epoch gives it.
app.post('/api/field-preview', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const epoch = Number(req.query.epoch ?? 0);
    const { def, siteId } = req.body as { def: ZoneDef; siteId: string | null };
    if (!def || typeof def !== 'object') return res.status(400).json({ error: 'def required' });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    let out;
    try {
      const { defs, paramOverrides } = worldCtx(dir);
      const resolved = resolveBiomeOps(def, paramOverrides, defs.prefabs);
      const { atlas, seeds } = placedAtlas(dir, epoch, siteId, resolved);
      const site = atlas.sites.find(st => st.id === siteId) ?? null;
      if (!site) throw new Error(`site "${siteId}" was not placed this epoch — check its level band`);

      const baked = bakeSiteFootprint(resolved, `${siteId}:footprint:${epoch}`, site.worldX, site.worldY, defs.blockingTiles, defs.prefabs);
      const ox = baked.stamp.ox - FIELD_MARGIN;
      const oy = baked.stamp.oy - FIELD_MARGIN;
      const width = baked.width + FIELD_MARGIN * 2;
      const height = baked.height + FIELD_MARGIN * 2;
      const grid: string[][] = [];
      for (let y = 0; y < height; y++) {
        const row: string[] = [];
        for (let x = 0; x < width; x++) row.push(wildTileAt(ox + x, oy + y, seeds, atlas));
        grid.push(row);
      }

      // Regions are footprint-local; shift them into preview-grid coords so the
      // editor's existing region overlay lines up without knowing about margins.
      const bounds: Record<string, unknown> = {};
      for (const [id, b] of Object.entries(baked.bounds)) {
        bounds[id] = { ...b, x: b.x + FIELD_MARGIN, y: b.y + FIELD_MARGIN };
      }

      const ts: Tileset | undefined = defs.tilesets.overworld;
      // The same def is generated twice above (once inside the atlas bake, once
      // for the preview), so identical warnings would double up.
      warnings.splice(0, warnings.length, ...new Set(warnings));
      const missing = referencedRegions(def).filter(r => !(r in baked.bounds));
      for (const r of missing) warnings.push(`region "${r}" did not generate at epoch ${epoch} — a spawn or portal depending on it is silently absent`);

      out = {
        grid, width, height, ox, oy,
        margin: FIELD_MARGIN,
        bounds, focal: null,
        site: {
          ...site,
          biome: biomeAt(site.worldX, site.worldY, seeds),
          bytes: JSON.stringify(baked.stamp).length,
        },
        blocking: baked.blocking,
        tileColors: ts ? Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color])) : {},
        spriteColors: ts ? Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color])) : {},
        blockingTiles: ts ? Object.entries(ts.tiles).filter(([, v]) => v.blocking).map(([k]) => k) : [],
        resolvedTileset: 'overworld',
        warnings,
      };
    } finally { console.warn = origWarn; }
    res.json(out);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Sweep a run of epochs. The arrangement re-rolls, so a bake is only shippable
// once you have seen it across several — this catches both "it landed in the
// ocean" and "the region my boss spawn depends on didn't generate this time",
// which is otherwise a bug you find in production at midnight.
app.post('/api/site-epochs', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const from = Number(req.query.from ?? 0);
    const count = Math.min(200, Math.max(1, Number(req.query.count ?? 24)));
    const { def, siteId } = req.body as { def: ZoneDef; siteId: string | null };
    if (!def || !siteId) return res.status(400).json({ error: 'def and siteId required' });

    const origWarn = console.warn;
    console.warn = () => {};
    let rows;
    try {
      const { defs, paramOverrides } = worldCtx(dir);
      const resolved = resolveBiomeOps(def, paramOverrides, defs.prefabs);
      const needed = referencedRegions(def);
      rows = [];
      for (let i = 0; i < count; i++) {
        const epoch = from + i;
        const { atlas, seeds } = placedAtlas(dir, epoch, siteId, resolved);
        const site = atlas.sites.find(st => st.id === siteId);
        if (!site) { rows.push({ epoch, placed: false }); continue; }
        const baked = bakeSiteFootprint(resolved, `${siteId}:footprint:${epoch}`, site.worldX, site.worldY, defs.blockingTiles, defs.prefabs);
        rows.push({
          epoch, placed: true, x: site.worldX, y: site.worldY,
          biome: biomeAt(site.worldX, site.worldY, seeds),
          band: getLevelBand(dangerAt(site.worldX, site.worldY, seeds, atlas)),
          missing: needed.filter(r => !(r in baked.bounds)),
        });
      }
    } finally { console.warn = origWarn; }
    res.json(rows);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/biome-meta/:biome', (req, res) => {
  const b = BIOME_REGISTRY[req.params.biome!];
  if (!b) return res.status(404).json({ error: `unknown biome: ${req.params.biome}` });
  res.json({ zoneParams: b.zoneParams ?? [] });
});

// ── Prefab builder ─────────────────────────────────────────────────────────────

// Merged tile → color across all of the world's tilesets (a prefab isn't bound
// to one tileset, so the palette spans them all). Sprite colors too, for anchors.
app.get('/api/tiles', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const tiles: Record<string, string> = {};
    for (const ts of Object.values(worldCtx(dir).defs.tilesets)) {
      for (const [name, entry] of Object.entries(ts.tiles)) tiles[name] = entry.color;
    }
    res.json({ tiles });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.put('/api/tiles/:tileset', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const tsName = req.params.tileset;
    const { name, color, blocking } = req.body ?? {};
    if (!name || !color) return void res.status(400).json({ error: 'name and color required' });
    const tsPath = join(dir, 'tilesets', `${tsName}.json`);
    if (!existsSync(tsPath)) return void res.status(404).json({ error: `Tileset "${tsName}" not found` });
    const ts = readJson<Tileset>(tsPath);
    if (ts.tiles[name]) return void res.status(409).json({ error: `Tile "${name}" already exists` });
    ts.tiles[name] = blocking ? { color, blocking: true } : { color };
    writeFileSync(tsPath, JSON.stringify(ts, null, 2));
    worldCache.delete(dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

function prefabIndex(dir: string): Map<string, string> {
  const idx = new Map<string, string>();
  const pdir = join(dir, 'prefabs');
  if (!existsSync(pdir)) return idx;
  for (const f of walk(pdir)) {
    if (extname(f) !== '.json') continue;
    try { const p = readJson<Prefab>(f); idx.set(p.id || basenameNoExt(f), f); } catch {}
  }
  return idx;
}
function basenameNoExt(p: string): string { const b = p.split('/').pop() ?? p; return b.replace(/\.[^.]+$/, ''); }

app.get('/api/prefabs', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const list: { id: string; description?: string }[] = [];
    for (const [id, f] of prefabIndex(dir)) {
      let description: string | undefined;
      try { description = readJson<Prefab>(f).description; } catch {}
      list.push({ id, description });
    }
    res.json(list.sort((a, b) => a.id.localeCompare(b.id)));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/prefabs/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const f = prefabIndex(dir).get(req.params.id!);
    if (!f) return res.status(404).json({ error: `Prefab not found: ${req.params.id}` });
    res.json({ prefab: readJson<Prefab>(f), path: relative(ROOT, f) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Upsert a prefab to world/prefabs/<id>.json. Clears the world cache so the
// zone editor's stamp tool / feature picker pick it up without a restart.
app.put('/api/prefabs/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const id = req.params.id!;
    const prefab = req.body as Prefab;
    if (!prefab || typeof prefab.data !== 'string' || typeof prefab.legend !== 'object') {
      return res.status(400).json({ error: 'prefab must have data (string) and legend (object)' });
    }
    const pdir = join(dir, 'prefabs');
    if (!existsSync(pdir)) mkdirSync(pdir, { recursive: true });
    const existing = prefabIndex(dir).get(id);
    const path = existing ?? join(pdir, `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...prefab, id }, null, 2) + '\n', 'utf8');
    worldCache.delete(dir);
    res.json({ ok: true, id, path: relative(ROOT, path) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// ── Spawn packs ─────────────────────────────────────────────────────────────────
// Editor-only library: a pack names a reusable group ({id, members:[{entity,count}]}).
// Stored in <world>/spawn-packs.json. Dropping a pack expands to concrete `area`
// spawns in the zone, so the game never reads this file.
app.get('/api/packs', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const path = join(dir, 'spawn-packs.json');
    res.json(existsSync(path) ? (readJson<{ packs?: unknown[] }>(path).packs ?? []) : []);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.put('/api/packs', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const packs = Array.isArray(req.body) ? req.body : req.body?.packs;
    if (!Array.isArray(packs)) return res.status(400).json({ error: 'expected an array of packs' });
    writeFileSync(join(dir, 'spawn-packs.json'), JSON.stringify({ packs }, null, 2) + '\n', 'utf8');
    res.json({ ok: true, count: packs.length });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// ── Mob-template editor ─────────────────────────────────────────────────────────

const MOB_BEHAVIORS = ['idle', 'wander', 'patrol', 'passive', 'aggressive', 'territorial', 'kiting', 'skittish'];

// Enum metadata + the world's sprite palette for the mob editor's pickers.
// Every vocabulary here is read from the source of truth rather than restated,
// so a new brand or affinity term shows up in the form without a tooling edit.
app.get('/api/mob-meta', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const { defs } = worldCtx(dir);
    const sprites: Record<string, string> = {};
    for (const ts of Object.values(defs.tilesets)) {
      for (const [name, v] of Object.entries(ts.sprites)) sprites[name] = v.color;
    }
    // The ability kit picker. Mob abilities are the ones a mob can be given;
    // cooldown and range come off the def so the form can show what a kit
    // actually costs without the author opening a second tool.
    const abilities = Object.values(defs.abilities)
      .filter(a => a.actor !== 'player')
      .map(a => ({
        id: a.id,
        name: a.name ?? a.id,
        cooldown_ticks: a.cast?.cooldown_ticks ?? 0,
        range: a.targeting?.range ?? null,
        shape: a.targeting?.shape ?? null,
        kinds: [...new Set((a.effects ?? []).map(e => e.kind))],
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    res.json({
      roles: Object.keys(MOB_ROLES),
      behaviors: MOB_BEHAVIORS,
      sprites,
      abilities,
      biomes: WILD_BIOMES,
      brands: BRAND_KEYS,
      affinities: Object.keys(AFFINITY_TAGS).sort(),
      mobIds: Object.keys(defs.mobs).sort(),
      classes: Object.keys(CLASSES),
    });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Derived combat profile for an (unsaved) template: effective HP, per-swing
// damage, and hits-to-kill both ways against a player of each class. Runs the
// real combat core through tools/lib/combat-sim.ts — the same harness
// `npx tsx tools/combat-sim.ts` prints its balance table from, so a mob tuned
// here and a mob checked there report the same numbers.
app.post('/api/mob-sim', (req, res) => {
  try {
    const { mob, playerLevel } = req.body as { mob: MobTemplate; playerLevel?: number };
    if (!mob?.role) return res.status(400).json({ error: 'mob with a role required' });
    res.json(simulateTemplate(mob, playerLevel));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

function mobIndex(dir: string): Map<string, string> {
  const idx = new Map<string, string>();
  const mdir = join(dir, 'entities', 'mobs');
  if (!existsSync(mdir)) return idx;
  for (const f of walk(mdir)) {
    if (extname(f) !== '.yaml') continue;
    try { const m = readYaml<MobTemplate>(f); if (m?.id) idx.set(m.id, f); } catch {}
  }
  return idx;
}

app.get('/api/mobs', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const list: { id: string; name: string; sprite: string; role: string; level: number }[] = [];
    for (const f of mobIndex(dir).values()) {
      try { const m = readYaml<MobTemplate>(f); list.push({ id: m.id, name: m.name, sprite: m.sprite, role: m.role, level: m.level }); } catch {}
    }
    res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/mobs/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const f = mobIndex(dir).get(req.params.id!);
    if (!f) return res.status(404).json({ error: `Mob not found: ${req.params.id}` });
    res.json({ mob: readYaml<MobTemplate>(f), path: relative(ROOT, f) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// Upsert a mob template to entities/mobs/<id>.yaml. Clears the cache so the
// spawn brush / entity list pick it up without a restart.
app.put('/api/mobs/:id', (req, res) => {
  try {
    const dir = worldDirFor(req.query.world as string | undefined);
    const id = req.params.id!;
    const mob = req.body as MobTemplate;
    if (!mob || !mob.name || !mob.sprite || !mob.role) {
      return res.status(400).json({ error: 'mob needs at least name, sprite, role' });
    }
    if (!(mob.role in MOB_ROLES)) return res.status(400).json({ error: `invalid role "${mob.role}"` });
    const mdir = join(dir, 'entities', 'mobs');
    if (!existsSync(mdir)) mkdirSync(mdir, { recursive: true });
    const path = mobIndex(dir).get(id) ?? join(mdir, `${id}.yaml`);
    writeZoneFile(path, { ...mob, id }); // .yaml ext → YAML dump
    worldCache.delete(dir);
    res.json({ ok: true, id, path: relative(ROOT, path) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.listen(PORT, () => {
  console.log(`\n  Zone Editor  →  http://localhost:${PORT}\n`);
});
