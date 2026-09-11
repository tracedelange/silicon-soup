import { itemVisual } from '../../shared/itemVisuals.ts';
import type { VisualSource } from '../../shared/itemVisuals.ts';
import { SPRITE_SIZE, opaqueBounds, renderOverlay } from '../../shared/playerComposite.ts';
import { visualPixels, whenLayerLoads } from './playerSprite.ts';

// Inventory / merchant / loot icons, built from the same grayscale overlay the
// paper-doll wears — recolored through the item's material ramp and tinted by
// its brand. An icon therefore costs no art of its own: draw `maul.png` for the
// character and every maul in every bag gets a picture for free.
//
// Trimmed to the art's bounding box so a tall sword and a squat helm both fill
// their slot instead of floating in whatever whitespace the 64x64 canvas had.

const icons = new Map<string, HTMLCanvasElement | null>();
whenLayerLoads(() => icons.clear());

function build(stack: VisualSource): HTMLCanvasElement | null {
  const visual = itemVisual(stack);
  if (!visual) return null;
  const pixels = visualPixels(visual);
  if (!pixels) return null;

  const rgba = renderOverlay(pixels, visual);
  const box = opaqueBounds(rgba);
  if (!box) return null;

  const full = document.createElement('canvas');
  full.width = full.height = SPRITE_SIZE;
  full.getContext('2d')!.putImageData(new ImageData(rgba, SPRITE_SIZE, SPRITE_SIZE), 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = box.w;
  canvas.height = box.h;
  const c2d = canvas.getContext('2d')!;
  c2d.imageSmoothingEnabled = false;
  c2d.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return canvas;
}

/**
 * The icon for one item, or null when nothing has been drawn for it — the
 * normal state for potions, quest tokens and any archetype still without art.
 * Callers keep their text label as the fallback.
 */
export function getItemIcon(stack: VisualSource | null | undefined): HTMLCanvasElement | null {
  if (!stack?.base) return null;
  const visual = itemVisual(stack);
  if (!visual) return null;
  const key = `${visual.layer}|${visual.ramp[2]}|${visual.tint ?? ''}`;
  if (!icons.has(key)) icons.set(key, build(stack));
  return icons.get(key) ?? null;
}

/**
 * An `<img>`-shaped element for a slot, scaled to fit `size` with the pixel
 * grid intact and its aspect preserved. Returns null when there's no art, so a
 * caller can fall back to text in one line.
 */
export function itemIconEl(stack: VisualSource | null | undefined, size: number): HTMLCanvasElement | null {
  const icon = getItemIcon(stack);
  if (!icon) return null;
  const el = document.createElement('canvas');
  // Integer upscale where it fits, so pixels stay square; shrink continuously
  // for art too big for the slot rather than dropping detail to a whole factor.
  const fit = size / Math.max(icon.width, icon.height);
  const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
  el.width = Math.max(1, Math.round(icon.width * scale));
  el.height = Math.max(1, Math.round(icon.height * scale));
  el.className = 'item-icon';
  const c2d = el.getContext('2d')!;
  c2d.imageSmoothingEnabled = false;
  c2d.drawImage(icon, 0, 0, el.width, el.height);
  return el;
}
