import { gearVisuals, layerCandidates, visualSignature } from '../../shared/itemVisuals.ts';
import type { GearVisual } from '../../shared/itemVisuals.ts';
import { SPRITE_SIZE, renderComposite } from '../../shared/playerComposite.ts';
import type { BodyArt, CompositeLayer } from '../../shared/playerComposite.ts';
import type { ClassId, Equipment } from '../../shared/types.ts';

// Browser side of the paper-doll: load the grayscale gear overlays, hand them
// to the pure compositor in shared/playerComposite.ts, and cache the result as
// a canvas the renderer can blit. The shape math and the recoloring live in
// shared/ so tools/sprite-lab previews exactly what the game draws.
//
// Overlay PNGs are fetched lazily from /gear/<layer>.png. A layer that hasn't
// arrived yet — or doesn't exist, which is the normal state for the archetypes
// nobody has drawn — simply doesn't draw. The sprite degrades a layer at a
// time and never blocks a frame on the network.

export { SPRITE_SIZE } from '../../shared/playerComposite.ts';

type LayerState = Uint8ClampedArray | 'loading' | 'missing';

const layers = new Map<string, LayerState>();
const composites = new Map<string, HTMLCanvasElement>();

// Custom bodies, drawn in the sprite-lab and served from /body/<name>.json.
// A class uses its own file, else the shared one, else the built-in template —
// so drawing `default.json` alone puts every class on one body, and deleting it
// reverts the lot.
type BodyState = BodyArt | 'loading' | 'missing';
const bodies = new Map<string, BodyState>();
const SHARED_BODY = 'default';

function bodyArt(name: string): BodyArt | null {
  const hit = bodies.get(name);
  if (hit) return typeof hit === 'string' ? null : hit;

  bodies.set(name, 'loading');
  fetch(`/body/${name}.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('absent'))))
    .then((body: BodyArt) => {
      bodies.set(name, body);
      composites.clear();
      for (const fn of onLayerLoad) fn();
    })
    .catch(() => { bodies.set(name, 'missing'); });
  return null;
}

/** The body in force for a class, or null while nothing custom has arrived —
 *  in which case renderComposite falls back to the built-in template on its own. */
function resolveBody(klass: ClassId): BodyArt | undefined {
  return bodyArt(klass) ?? bodyArt(SHARED_BODY) ?? undefined;
}

/** Decode a 64x64 overlay PNG into raw RGBA via a scratch canvas. */
function decode(img: HTMLImageElement): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return ctx.getImageData(0, 0, SPRITE_SIZE, SPRITE_SIZE).data;
}

/** Notified when a lazily-fetched overlay arrives, so anything holding derived
 *  art (the item-icon cache) can drop it and rebuild. */
const onLayerLoad: (() => void)[] = [];
export function whenLayerLoads(fn: () => void): void { onLayerLoad.push(fn); }

/** The art for a resolved item: its preferred silhouette, else the shape it
 *  falls back to. The fallback is only *fetched* once the preferred layer has
 *  come back 404 — while it's still in flight the item simply doesn't draw, so
 *  a variant that does exist never flashes the default shape first. */
export function visualPixels(visual: GearVisual): Uint8ClampedArray | null {
  for (const name of layerCandidates(visual)) {
    const pixels = gearLayerPixels(name);
    if (pixels) return pixels;
    if (layers.get(name) !== 'missing') return null;
  }
  return null;
}

/** Shared with itemIcon.ts: one fetch and one decode per overlay, whether it's
 *  wanted for a body composite or a bag icon. */
export function gearLayerPixels(name: string): Uint8ClampedArray | null {
  const hit = layers.get(name);
  if (hit) return hit instanceof Uint8ClampedArray ? hit : null;

  layers.set(name, 'loading');
  const img = new Image();
  img.onload = () => {
    layers.set(name, decode(img));
    // A newly arrived layer changes every look that wanted it. The cache is a
    // few dozen entries at most, so dropping all of it beats tracking which.
    composites.clear();
    for (const fn of onLayerLoad) fn();
  };
  img.onerror = () => { layers.set(name, 'missing'); };
  img.src = `/gear/${name}.png`;
  return null;
}

function compose(klass: ClassId, color: string, visuals: GearVisual[]): HTMLCanvasElement {
  const ready: CompositeLayer[] = [];
  for (const visual of visuals) {
    const pixels = visualPixels(visual);
    if (pixels) ready.push({ pixels, visual });
  }
  const rgba = renderComposite({ klass, color, body: resolveBody(klass) }, ready);
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, SPRITE_SIZE, SPRITE_SIZE), 0, 0);
  return canvas;
}

/**
 * The composited sprite for a player's current look. Cached on the visual
 * signature — class, color, and the resolved gear — so the common case (no
 * gear change since last frame) is one string build and a map hit.
 */
export function getPlayerSprite(
  klass: ClassId | undefined,
  color: string | undefined,
  equipment?: Equipment,
): HTMLCanvasElement {
  const k: ClassId = klass ?? 'fighter';
  const c = color || '#6ec6f0';
  const visuals = gearVisuals(equipment);
  const key = visualSignature(k, c, visuals);
  let hit = composites.get(key);
  if (!hit) {
    hit = compose(k, c, visuals);
    composites.set(key, hit);
  }
  return hit;
}
