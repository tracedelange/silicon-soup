// Node-only: where custom paper-doll bodies and their pose anchors live on
// disk, and how the tool resolves which one a class actually uses.
//
// Bodies are JSON, not PNG. A body is painted in legend ROLES (skin, garment
// light, outline …) that the compositor resolves to colors at draw time — a
// garment cell becomes the player's chosen color — so there is no fixed RGB to
// round-trip through an image, and storing one would invite lossy edits.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSE_ANCHORS, SPRITE_SIZE, templateBody } from '../../shared/playerComposite.ts';
import type { BodyArt, PoseAnchor } from '../../shared/playerComposite.ts';
import type { ClassId } from '../../shared/types.ts';

/** Served to the game at /body/<name>.json, like gear is at /gear/<name>.png. */
export const BODY_DIR = join(import.meta.dirname, '../../client/public/body');

/** The name every class falls back to. Drawing this one and nothing else is how
 *  you put the whole roster on a single shared body. */
export const SHARED_BODY = 'default';

export class BodyShapeError extends Error {}

function bodyPath(name: string): string {
  return join(BODY_DIR, `${name}.json`);
}

export function bodyExists(name: string): boolean {
  return existsSync(bodyPath(name));
}

export function readBody(name: string): BodyArt | null {
  if (!bodyExists(name)) return null;
  const parsed = JSON.parse(readFileSync(bodyPath(name), 'utf8')) as BodyArt;
  validateBody(parsed);
  return parsed;
}

export function validateBody(body: BodyArt): void {
  if (!Array.isArray(body?.rows) || body.rows.length !== SPRITE_SIZE) {
    throw new BodyShapeError(`body needs ${SPRITE_SIZE} rows, got ${body?.rows?.length}`);
  }
  for (const [i, row] of body.rows.entries()) {
    if (typeof row !== 'string' || row.length !== SPRITE_SIZE) {
      throw new BodyShapeError(`row ${i} is ${typeof row === 'string' ? row.length : typeof row} wide, needs ${SPRITE_SIZE}`);
    }
  }
}

export function writeBody(name: string, body: BodyArt): void {
  validateBody(body);
  mkdirSync(BODY_DIR, { recursive: true });
  // One row per line: a body diff should read as a picture, not a wall.
  writeFileSync(bodyPath(name), `{\n  "rows": [\n${body.rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`);
}

/**
 * The body a class actually draws with: its own file, else the shared one, else
 * the built-in template. Same shape as the gear fallback — a file appearing is
 * what makes it real, and deleting it reverts to what shipped.
 */
export function resolveBody(klass: ClassId): BodyArt {
  return readBody(klass) ?? readBody(SHARED_BODY) ?? templateBody(klass);
}

/** Which of those three the class is on, for the tool to report. */
export function bodySource(klass: ClassId): 'class' | 'shared' | 'built-in' {
  if (bodyExists(klass)) return 'class';
  if (bodyExists(SHARED_BODY)) return 'shared';
  return 'built-in';
}

const ANCHORS_FILE = join(BODY_DIR, 'anchors.json');

/** Anchors travel with the bodies they describe: a body drawn to different
 *  proportions puts its shoulders and hands somewhere else, so the defaults
 *  stop being true the moment someone draws one. */
export function readAnchors(): PoseAnchor[] {
  if (!existsSync(ANCHORS_FILE)) return [...POSE_ANCHORS];
  const parsed = JSON.parse(readFileSync(ANCHORS_FILE, 'utf8')) as PoseAnchor[];
  validateAnchors(parsed);
  return parsed;
}

export function validateAnchors(anchors: PoseAnchor[]): void {
  if (!Array.isArray(anchors) || anchors.length === 0) throw new BodyShapeError('anchors must be a non-empty array');
  for (const a of anchors) {
    if (!a?.label) throw new BodyShapeError('every anchor needs a label');
    if (!Number.isInteger(a.from) || !Number.isInteger(a.to)) throw new BodyShapeError(`${a.label}: from/to must be whole rows`);
    if (a.from < 0 || a.to >= SPRITE_SIZE) throw new BodyShapeError(`${a.label}: rows must be 0-${SPRITE_SIZE - 1}`);
    if (a.to < a.from) throw new BodyShapeError(`${a.label}: "to" is above "from"`);
  }
}

export function writeAnchors(anchors: PoseAnchor[]): void {
  validateAnchors(anchors);
  mkdirSync(BODY_DIR, { recursive: true });
  writeFileSync(ANCHORS_FILE, `${JSON.stringify(anchors, null, 2)}\n`);
}
