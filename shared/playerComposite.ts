import type { ClassId } from './types.ts';
import type { GearVisual, Ramp } from './itemVisuals.ts';

// The player paper-doll compositor: body template + equipment overlays -> one
// 64x64 RGBA buffer. Pure and dependency-free so it runs identically in the
// browser (client/src/playerSprite.ts wraps it with PNG loading and caching)
// and in Node (tools/sprite-lab renders the same composite to a PNG).
// See docs/plan-player-sprites.md.
//
// Bodies are hand-authored 32x32 templates stored as the LEFT half only
// (32 rows x 16 cols) and mirrored — symmetry for free, half the authoring.
// Garment cells (L/g/G) are painted with a 3-shade ramp derived from the
// player's chosen color, so every (class, color) pair composites distinctly.
//
// Gear overlays are NOT templates. They are grayscale PNGs authored at the
// full 64x64 output resolution (see client/public/gear/README.md): full width,
// because anything held in one hand is asymmetric and can't use the mirror
// trick, and full resolution, so a weapon can carry finer detail than the
// 2px-celled body it hangs off.

/** The half-width authoring grid the built-in class templates are written on.
 *  Only they use it — everything downstream is full 64x64 sprite pixels. */
export const GRID = 32;
const CELL = 2;
export const SPRITE_SIZE = GRID * CELL;

export interface PoseAnchor { label: string; from: number; to: number }

/** The pose contract every overlay is drawn against, in SPRITE PIXEL rows.
 *  Defaults describing the built-in templates; a custom body ships its own set
 *  (the sprite-lab writes them next to the body it describes), because a body
 *  drawn to different proportions moves every landmark on it. */
export const POSE_ANCHORS: readonly PoseAnchor[] = [
  { label: 'head', from: 6, to: 27 },
  { label: 'shoulders', from: 28, to: 29 },
  { label: 'hands', from: 38, to: 41 },
  { label: 'belt', from: 40, to: 45 },
  { label: 'feet', from: 58, to: 59 },
];

// Template legend (left half; each row mirrors to 32 cols):
//   .  transparent          o  outline           d  face shadow
//   s  skin                 S  skin shade        w  eye white   e  eye dark
//   h  hair/beard accent    b  leather           B  leather shade
//   m  metal                M  metal shade
//   L  garment light        g  garment mid       G  garment dark
export const TEMPLATES: Record<ClassId, string[]> = {
  fighter: [
    '................',
    '................',
    '................',
    '............oooo',
    '..........oohhhh',
    '..........ohhhhh',
    '..........ohgggg',
    '..........ohssss',
    '..........osssss',
    '..........osswes',
    '..........osssss',
    '..........oSssss',
    '...........oSSSS',
    '............ooss',
    '.......ommmmggss',
    '......ommmmggggg',
    '......omMMoGgggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......ossoGggggL',
    '......ossoBbbbmm',
    '.......ooobbbbbb',
    '.........oGGGGo.',
    '.........oGGGGo.',
    '.........oGgGGo.',
    '.........oBBBBo.',
    '.........oBbbBo.',
    '........obbbbbo.',
    '........oooooo..',
    '................',
    '................',
  ],
  rogue: [
    '................',
    '................',
    '................',
    '............oooo',
    '...........ogggg',
    '..........ogGggg',
    '..........oggggg',
    '..........ogdddd',
    '..........ogdddd',
    '..........ogdwwd',
    '..........ogdddd',
    '..........ogGddd',
    '...........oGGGG',
    '............ooGG',
    '........oggggggg',
    '.......oGGoggggL',
    '.......oGGoGgggL',
    '.......oGGoGgggL',
    '.......oGGoGgggL',
    '.......ossoggggL',
    '.......ossoBbbbb',
    '........oobbbbbb',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oBBBo.',
    '..........obbBo.',
    '.........obbbbo.',
    '.........ooooo..',
    '................',
    '................',
  ],
  wizard: [
    '...............o',
    '..............og',
    '.............ogg',
    '.............ogg',
    '............oggg',
    '............oggg',
    '........ooGggggg',
    '..........osssss',
    '..........osswes',
    '..........osssss',
    '..........ohhsss',
    '..........ohhhss',
    '...........ohhhh',
    '............ohhh',
    '.......ogggggggg',
    '......oGGogggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGogggggL',
    '......ossogggggL',
    '.......ooobbbbbb',
    '........oGgggggL',
    '........oGgggggL',
    '........oGgggggL',
    '........oGGggggL',
    '........oGGggggL',
    '........oGGGgggg',
    '........oGGGGGGG',
    '........oooooooo',
    '................',
    '................',
  ],
};

const BASE_COLORS: Record<string, string> = {
  o: '#1a1410',
  d: '#241d18',
  w: '#f0ead8',
  e: '#20180f',
  s: '#d9a06b',
  S: '#b07c4e',
  h: '#6b3f1d',
  b: '#7a5632',
  B: '#57391f',
  m: '#b9bfc7',
  M: '#7e858e',
};

// Per-class overrides for skin tone and hair/beard accent.
const CLASS_COLORS: Record<ClassId, Record<string, string>> = {
  fighter: {},
  rogue: { w: '#e8d9a0' },
  wizard: { s: '#e6c39a', S: '#c49b6f', h: '#ddd8ce' },
};

/** The body's arm span at the hand rows, in sprite pixels — where a weapon's
 *  grip has to land. Derived from the body art rather than declared, so
 *  redrawing a body moves the marker with it instead of silently lying.
 *
 *  Arms read as outline-flanked runs at the outer edge of the hand rows
 *  (`......oGGoGggggL`), so the span runs from the first lit column inward to
 *  the end of the SECOND outline run — runs, not cells, because a body drawn at
 *  full resolution has outlines two or more pixels thick. Returns null when a
 *  body has no hands anchor or no such run, which is a reason to draw no
 *  marker, not to throw.
 */
export function handColumns(
  body: BodyArt,
  anchors: readonly PoseAnchor[] = POSE_ANCHORS,
): { left: [number, number]; right: [number, number] } | null {
  const hands = anchors.find((a) => a.label === 'hands');
  const row = hands ? body.rows[hands.from] : undefined;
  if (!row) return null;

  const from = [...row].findIndex((ch) => ch !== '.');
  if (from < 0) return null;
  let runs = 0;
  let prevOutline = false;
  for (let x = from; x < row.length; x++) {
    if (row[x] === '.') return null;
    const outline = row[x] === 'o';
    if (outline && !prevOutline) runs++;
    // The arm ends where its inner outline run does.
    if (!outline && prevOutline && runs === 2) {
      const to = x - 1;
      const w = row.length;
      return { left: [from, to], right: [w - 1 - to, w - 1 - from] };
    }
    prevOutline = outline;
  }
  return null;
}

/** A body at full sprite resolution: SPRITE_SIZE rows of SPRITE_SIZE legend
 *  characters, '.' for transparent. This is the editable form — the built-in
 *  half-width class templates are one way to produce it, a file drawn in the
 *  sprite-lab is another, and the compositor only ever sees this. */
export interface BodyArt { rows: string[] }

/** Legend characters in palette order, with what each one means. The editor
 *  builds its swatch row from this, so a role added here shows up there. */
export const BODY_ROLES: readonly { ch: string; label: string }[] = [
  { ch: 'o', label: 'outline' },
  { ch: 'd', label: 'face shadow' },
  { ch: 's', label: 'skin' },
  { ch: 'S', label: 'skin shade' },
  { ch: 'w', label: 'eye white' },
  { ch: 'e', label: 'eye dark' },
  { ch: 'h', label: 'hair' },
  { ch: 'b', label: 'leather' },
  { ch: 'B', label: 'leather shade' },
  { ch: 'm', label: 'metal' },
  { ch: 'M', label: 'metal shade' },
  { ch: 'L', label: 'garment light' },
  { ch: 'g', label: 'garment mid' },
  { ch: 'G', label: 'garment dark' },
];

/** Expand a built-in class template to full resolution: mirror each half-row,
 *  then double both axes, which is exactly what the old 2px-cell compositor
 *  drew. Seeds a new editable body from the art that already exists. */
export function templateBody(klass: ClassId): BodyArt {
  const half = TEMPLATES[klass in TEMPLATES ? klass : 'fighter'];
  const rows: string[] = [];
  for (const line of half) {
    const full = [...expandRow(line)].map((ch) => ch + ch).join('');
    rows.push(full, full);
  }
  return { rows };
}

export type RGB = readonly [number, number, number];

const DEFAULT_COLOR = '#6ec6f0'; // server default, used when a player has none

function parseHex(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return parseHex(DEFAULT_COLOR);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mix(rgb: RGB, toward: RGB, t: number): RGB {
  return [
    Math.round(rgb[0] + (toward[0] - rgb[0]) * t),
    Math.round(rgb[1] + (toward[1] - rgb[1]) * t),
    Math.round(rgb[2] + (toward[2] - rgb[2]) * t),
  ];
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Full body palette for a class + player color, keyed by legend char. */
export function buildPalette(klass: ClassId, color: string): Record<string, RGB> {
  const rgb = parseHex(color);
  const out: Record<string, RGB> = {};
  for (const [ch, hex] of Object.entries({ ...BASE_COLORS, ...CLASS_COLORS[klass] })) out[ch] = parseHex(hex);
  out['L'] = mix(rgb, WHITE, 0.35);
  out['g'] = rgb;
  out['G'] = mix(rgb, BLACK, 0.4);
  return out;
}

/** Expand a left-half template row to the full mirrored 32-char row. */
export function expandRow(half: string): string {
  return half + [...half].reverse().join('');
}

/** Overlay art is authored in five key grays; each maps to the material ramp
 *  stop at its index. Nearest-step by luminance rather than exact equality, so
 *  a stray off-by-a-few gray from the paint program still lands on its stop. */
export const RAMP_STOPS = 5;

/** The five key grays themselves — what overlay art is painted in, and what the
 *  editor writes back out. Index is the ramp stop. */
export const KEY_GRAYS: readonly number[] = [0, 64, 128, 191, 255];

export function rampStep(r: number, g: number, b: number): number {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return Math.max(0, Math.min(RAMP_STOPS - 1, Math.round(lum * (RAMP_STOPS - 1))));
}

/** A decoded overlay, ready to composite. `pixels` is RGBA at SPRITE_SIZE
 *  squared — the caller decodes the PNG (canvas in the browser, pngjs in Node)
 *  so this module stays free of both. */
export interface CompositeLayer {
  pixels: Uint8ClampedArray;
  visual: GearVisual;
}

export interface CompositeSpec {
  klass: ClassId;
  color?: string;
  /** A custom body. Omit to use the built-in template for the class. */
  body?: BodyArt;
}

function rampToRGB(ramp: Ramp): RGB[] {
  return ramp.map(parseHex);
}

/** Blend `src` over the RGBA buffer at index i (4 bytes), src alpha 0..255. */
function blend(out: Uint8ClampedArray, i: number, src: RGB, a: number): void {
  if (a >= 255) {
    out[i] = src[0]; out[i + 1] = src[1]; out[i + 2] = src[2]; out[i + 3] = 255;
    return;
  }
  const t = a / 255;
  const inv = 1 - t;
  out[i] = Math.round(src[0] * t + out[i]! * inv);
  out[i + 1] = Math.round(src[1] * t + out[i + 1]! * inv);
  out[i + 2] = Math.round(src[2] * t + out[i + 2]! * inv);
  out[i + 3] = Math.max(out[i + 3]!, a);
}

/**
 * Recolor one overlay on its own, with no body under it — the item as an
 * object rather than as worn gear. This is what an inventory, merchant or loot
 * icon draws, so a bag icon and the sprite in the character's hand are
 * guaranteed to be the same art through the same ramp.
 *
 * Deliberately skips the rarity glow: in a slot, rarity is already carried by
 * the border and the name color, and a halo there just muddies the silhouette.
 */
export function renderOverlay(pixels: Uint8ClampedArray, visual: GearVisual): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(SPRITE_SIZE * SPRITE_SIZE * 4);
  const shades = rampToRGB(visual.ramp);
  const tint = visual.tint ? parseHex(visual.tint) : null;
  for (let p = 0; p < SPRITE_SIZE * SPRITE_SIZE; p++) {
    const i = p * 4;
    const a = pixels[i + 3] ?? 0;
    if (a === 0) continue;
    const step = rampStep(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    let c = shades[step]!;
    if (tint) c = mix(c, tint, step >= RAMP_STOPS - 2 ? 0.55 : step === RAMP_STOPS - 3 ? 0.25 : 0);
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = a;
  }
  return out;
}

/** Tight bounds of the non-transparent pixels, or null when nothing is lit.
 *  Icons trim to this so a tall sword and a squat helm both fill their slot. */
export function opaqueBounds(rgba: Uint8ClampedArray, size = SPRITE_SIZE):
  { x: number; y: number; w: number; h: number } | null {
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((rgba[(y * size + x) * 4 + 3] ?? 0) === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Composite a body and its equipment overlays into one 64x64 RGBA buffer.
 *
 * Layers draw in the order given (gearVisuals already returns bottom-to-top).
 * Per layer: every lit pixel is recolored through the material ramp, an
 * elemental brand is blended into the highlight stops only — a fire sword
 * should look like steel catching fire, not like a red sword — and a rarity
 * glow is laid into the still-transparent pixels ringing the silhouette.
 */
export function renderComposite(spec: CompositeSpec, layers: readonly CompositeLayer[] = []): Uint8ClampedArray<ArrayBuffer> {
  const klass: ClassId = spec.klass in TEMPLATES ? spec.klass : 'fighter';
  const out = new Uint8ClampedArray(SPRITE_SIZE * SPRITE_SIZE * 4);

  const palette = buildPalette(klass, spec.color || DEFAULT_COLOR);
  const body = spec.body ?? templateBody(klass);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const row = body.rows[y];
    if (!row) continue;
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      const c = palette[ch] ?? palette['g']!;
      const i = (y * SPRITE_SIZE + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }

  for (const layer of layers) {
    const shades = rampToRGB(layer.visual.ramp);
    const tint = layer.visual.tint ? parseHex(layer.visual.tint) : null;
    const lit = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);
    for (let p = 0; p < SPRITE_SIZE * SPRITE_SIZE; p++) {
      if ((layer.pixels[p * 4 + 3] ?? 0) !== 0) lit[p] = 1;
    }

    // Glow first, then the item over it. The aura belongs BEHIND the thing it
    // rings but IN FRONT of the character — a legendary sword held across the
    // chest should halo onto the body, not vanish wherever the two overlap.
    // Drawing it before the layer is what puts it in that middle position.
    if (layer.visual.glow) {
      const glow = parseHex(layer.visual.glow);
      for (let y = 0; y < SPRITE_SIZE; y++) {
        for (let x = 0; x < SPRITE_SIZE; x++) {
          const p = y * SPRITE_SIZE + x;
          if (lit[p]) continue;
          const ringed = (x > 0 && lit[p - 1]) || (x < SPRITE_SIZE - 1 && lit[p + 1])
            || (y > 0 && lit[p - SPRITE_SIZE]) || (y < SPRITE_SIZE - 1 && lit[p + SPRITE_SIZE]);
          if (ringed) blend(out, p * 4, glow, 200);
        }
      }
    }

    for (let p = 0; p < SPRITE_SIZE * SPRITE_SIZE; p++) {
      const i = p * 4;
      const a = layer.pixels[i + 3] ?? 0;
      if (a === 0) continue;
      const step = rampStep(layer.pixels[i]!, layer.pixels[i + 1]!, layer.pixels[i + 2]!);
      let c = shades[step]!;
      // Highlights carry the brand; shadows stay the material's own color, so
      // the metal still reads as steel/runed underneath the element.
      if (tint) c = mix(c, tint, step >= RAMP_STOPS - 2 ? 0.55 : step === RAMP_STOPS - 3 ? 0.25 : 0);
      blend(out, i, c, a);
    }
  }

  return out;
}
