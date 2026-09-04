# Plan: Player Sprite System

Replace the flat colored square with a layered, procedurally-recolored character
sprite that reflects class, player color, equipped gear, and active status
effects.

## Current state (July 2026)

- Player renders as a flat 32px colored square: `getSpriteImage('player')` finds
  no file and `drawEntity` (`client/src/game.ts:2728-2748`) falls back to
  `fillRect`. Mobs already draw 64×64 PNGs from `/sprites/<id>.png` via the same
  path.
- **The client already receives everything needed — zero server changes
  required.** Each player snapshot ships `klass`, `color`, the full `equipment`
  record (base id, affixes, rarity, `weapon_brand`), and active `modifiers`
  including CC kinds and dot/hot ticks (`server/game/world.ts:518-565`).
- Two proven asset pipelines exist:
  - `sprites/sprite_baker.py` — ComfyUI-baked 64×64 sprites (mobs/items/tiles)
  - `shared/abilityIcon.ts` — seed-driven procedural pixel grids (precedent for
    fully procedural pixel art in-repo)
- Item visual signals per equipped piece: base id (encodes archetype + material
  tier), rarity, affix ids, elemental `weapon_brand`. No per-item seed or color
  field — visuals derive from these resolved fields.

## Architecture: paper-doll compositing with procedural recolor

A layered composite rendered once to an offscreen 64×64 canvas and cached,
keyed by the player's "visual signature." Layers bottom-to-top:

1. **Base body** (baked, per class ×3) — grayscale/keyed-palette template
2. **Armor overlays** (baked, small set) — chest silhouette by weight class, helmet
3. **Weapon overlay** (baked, per archetype ~6-8) — grayscale, tinted by material
4. **Rarity/brand accents** (procedural) — outline glow, elemental tint
5. **Status FX** (procedural, animated, drawn live each frame — NOT cached)

Hybrid strategy: a small hand-count of baked shape templates (~15-20 images
total), with combinatorial variety from procedural recoloring — 3 classes ×
player color × 5 material ramps × 8 weapon shapes × 4 rarity glows × 7 brand
tints already yields thousands of distinct looks.

## Phase 1 — Base body sprite + palette swap (~1 session)

- ~~Bake via sprite_baker~~ → **implemented as hand-authored 32×32 pixel
  templates in code** (`client/src/playerSprite.ts`): left half only (32×16),
  mirrored at render for guaranteed symmetry. Chosen over SDXL bakes for exact
  pose-contract control; baked art can replace templates later without touching
  the draw path. Pose contract for overlays: head rows 3-13, shoulders row 14,
  hands rows 19-20 at arm columns, belt rows 20-22, feet row 29.
- Garment cells (`L`/`g`/`G` legend chars) palette-swap to a 3-shade ramp
  derived from the player's chosen `color`; composites cached per `klass|color`.
- Wire into `drawEntity`'s player path; keep the color-square fallback for
  missing assets.
- Cheap win: read the existing-but-unused `facing` field and flip horizontally
  via `ctx.scale(-1,1)`.

**Done when:** two players with different classes/colors render as distinct
pixel-art characters, not squares.

## Phase 2 — Equipment layers (~1-2 sessions)

**Status (Sept 2026): the machinery is built and one weapon overlay ships.**
The compositor moved out of the client into `shared/playerComposite.ts` (pure,
runs in the browser and in Node), gear resolution into `shared/itemVisuals.ts`,
and the whole chain is previewable via `npm run sprite-lab` (:3005). What
remains is *art* — 6 more weapon overlays, 2 chests, 2 helms — not code. Each is
a 64×64 grayscale PNG dropped into `client/public/gear/`; the filename is the
registration, and a missing file simply doesn't draw. See that folder's
README.md for the authoring contract.

- **Weapons:** one grayscale overlay per archetype (`dagger`, `sword`,
  `greatsword`, `staff`, … from `world/entities/items/archetypes.yaml`),
  positioned at the canonical hand anchor. Tint by a material→color-ramp table
  (crude=dull brown, iron=gray, steel=bright silver, tempered=blue-steel,
  runed=violet). Material is parseable from the base id.
- **Armor:** 2 chest overlays (light/heavy silhouette from material
  `armor_tag`) + 1-2 helmet overlays, same tinting. Skip gloves/boots/leggings/
  rings/amulets — too small at on-screen scale.
- **Rarity:** procedural 1px outline glow matching existing inventory rarity
  colors. Common gets nothing.
- **Brand:** if `rolled.weapon_brand` is set, tint the weapon layer edge with
  the brand element color (reuse `BRAND_KEYS` palette).
- Cache key: `klass|color|mainhandBase|rarity|brand|chestTag|helmet…` —
  recompute each snapshot, cheap string compare invalidation.

**Done when:** equipping a runed greatsword visibly changes the character;
swapping to a legendary fire-branded dagger shows a different silhouette,
glow, and tint. (True today for `sword` — the one archetype with art.)

**Decisions made while building it, worth not re-litigating:**

- **Overlays are 64×64, not 32×32 like the bodies.** The bodies are a 32-grid
  at 2px cells; overlays are authored at the full output resolution, so gear can
  carry finer detail than the body it hangs off — and it matches the density of
  the baked 64×64 mob sprites. When the bodies are eventually redrawn at 64,
  the layer contract doesn't change.
- **Overlays are full-width.** The bodies are stored as a left half and
  mirrored; anything held in one hand is asymmetric and can't use that trick.
- **Five key grays, not an arbitrary palette.** Matching is nearest-stop by
  luminance rather than exact equality — the plan's worry about palette-swap
  fidelity surviving quantization is handled by tolerance, not by discipline.
- **A brand tints only the highlight stops.** A fire sword should read as steel
  catching fire, not as a red sword, so the shadow stops keep the material's
  own color.
- **`MATERIAL_VISUALS` restates the material registry**, so the registry grades
  it: `shared/itemVisuals.test.ts` fails when a material in `materials.yaml`
  has no ramp, when a ramp names a material that no longer exists, or when a
  ramp's weight disagrees with the YAML's `armor_tag`.

## Phase 3 — Status effect FX (~1 session)

Fully procedural, animated per-frame on top of the cached composite (alongside
existing HP bar / CC badge overlays at `game.ts:2818-2946`, which stay):

- CC kinds: stun = orbiting stars, root = ground tendrils at feet, fear =
  desaturated ghost tint + shiver offset, silence = muted glyph, confuse = swirl.
- Dot/hot ticks: element-colored flecks (fire embers, poison bubbles, frost
  crystals) keyed off the modifier's ability/brand; HoT = rising green motes.
- Data already arrives in `components.modifiers` with `expiresAt` for fade-out.

**Done when:** getting stunned, poisoned, or HoT'd is legible at a glance
without reading the text badges.

## Out of scope (deliberate, revisit later)

- **Walk cycles / directional frames** — single-frame + horizontal flip first.
  Multi-frame is a natural Phase 4 once the layer contract exists (each layer
  becomes an N-frame strip).
- **Server-side appearance field** — not needed now. Confirmed: snapshots ship
  the player's whole `components` object (`world.ts` `entityToSnapshot`), so
  `drawPlayerSprite` reads equipment with no new wire field. Note: snapshots currently
  broadcast every player's full inventory/equipment to everyone in the zone.
  When that gets trimmed (bandwidth/privacy), replace with a compact derived
  `appearance` struct; the client compositor should read equipment through one
  small adapter function so the swap is one-file.
- **Per-item baked sprites** — archetype-shape × material-tint means no
  per-item art; only add a grayscale overlay when a new archetype ships.

## Risks

- **Pose alignment** is the main art risk: SDXL bakes won't naturally produce
  three class bodies in an identical pose with pixel-exact hand anchors.
  Expect manual pixel cleanup on the ~15 templates (one-time cost), or
  hand-draw them at 64×64 — small enough that this may beat fighting the
  diffusion model.
- **Palette-swap fidelity** depends on exact key colors surviving the baker's
  post-quantization (`PALETTE_N=24`). Mitigation: apply magic-key regions as a
  manual post-bake step, or swap by "nearest to key within tolerance."
