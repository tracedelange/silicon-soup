# Plan: hand-authored POIs and the tooling to build them

Scope for the "starter dungeon" rework: a discoverable surface camp in the
level 5–10 band, a portal into an authored interior, chests, a named boss, and a
quest loop around it — **built by hand in the GUI**, not by the forge.

This document scopes the *tooling* changes. It is deliberately not a content
plan; the content is the point of the tooling.

## The target loop

```
wild (level 5-10 annulus, position re-rolled per epoch)
  └─ CAMP footprint, painted onto the field
       N tent plots, paths between them, a great tent
       authored mobs on the perimeter and between the tents
       portal tile inside the great tent
         └──▶ INTERIOR zone (enclosed, authored, fixed layout)
                mobs, loot chests, named boss
       quest: giver → boss → return
```

The exterior is **not** a zone the player portals into. It is physically present
in the open world at a seed-determined location, the way the dungeon entrance
outcrop already is — the same mechanism, two orders of magnitude larger.

## The load-bearing idea: a zone is the authoring form, a footprint is the runtime form

Authoring a camp directly against the signed-coordinate infinite field would mean
building a second authoring surface from scratch, and would throw away the op
pipeline that already expresses "N camps connected by paths."

It does not have to. `generateZoneGrid(zoneDef)` (`server/game/mapgen/index.ts:625`)
is a pure function returning `{ grid, bounds, ... }`, already called directly by
the zone editor's server. So:

```
ZoneDef (authored)  ──generateZoneGrid──▶  grid + named region bounds
                                              │
                                              ▼  bake
                            WildStamp {kind:'grid'} in the atlas
                                              │
                                              ▼  wildTileAt
                                    painted into the open world
```

You keep `scatter_sites` → `stamp at_tag` → `network mst` → `route`, the whole
feature registry, prefabs, and every tool that already edits a zone. The wild
receives baked output. This is the repo's existing shape — sparse authored upper
layer, derived dense layer — applied one level further out.

**Decided: the internals re-roll too.** The bake runs per epoch at
`seed = "<site>:<epoch>"`, so position *and* arrangement move together — the camp
stays a discovery rather than a memorized route, and chest positions re-roll so a
second run isn't a fixed circuit. Three consequences follow, and they shape
everything below.

`bounds` is the second half of the gift: the named regions the generator produced
are in footprint-local coords, so authored spawns address them with the exact
`region` / `area` vocabulary `ZoneSpawn` already has.

### Consequence 1: authored spawns address regions, never coordinates

A boss pinned at footprint-local `(34, 21)` is inside a tent wall next epoch. So
authored spawns use `region` (and `area` only within a region's own frame) — the
`at` form is off the table for anything in a re-rolled footprint.

This is the constraint the dungeon roster already documents: *regions the template
names must be ones the biome always produces; anything else needs
`if_region: true`.* It now applies to the camp as well.

### Consequence 2: stamped prefabs are the fixed islands in a re-rolled sea

Re-rolling the arrangement does not mean giving up authorship of the rooms. Both
`place` and `stamp` register the placed AABB as a **named region** (`region?:
string`) and register anchor features. So a hand-drawn great tent, stamped into a
procedurally re-rolled camp, has a byte-identical interior every epoch, moves with
the layout, and exposes `region: 'great_tent'` as a stable spawn address.

Re-roll the arrangement; hand-author the rooms. That is how "internals re-roll"
and "I want more influence over the design" hold at the same time — and it needs
no new mechanism, just prefabs drawn in the editor's existing prefab mode.

### Consequence 3: the bake cannot live inside `buildAtlas`

`buildAtlas` is in `shared/worldgen/atlas.ts`; `generateZoneGrid` is in
`server/game/mapgen/`. **Shared must never import server** — that is the
determinism contract, and the reason the client can render terrain it was never
sent.

So the server bakes and *appends* the grid stamps to the atlas before shipping it.
`server/index.ts:201` is the only game-side `buildAtlas` call, so the seam is
already a single point. The client keeps consuming pure descriptors and the
contract is untouched.

Note `tools/world-gen/server.ts:113` also calls `buildAtlas` and will render camps
as bare terrain until it gets the same treatment.

## What already works (do not rebuild)

Most of the spatial half of this exists. The gaps are narrower than they look.

- **Radial placement in a level band.** `DungeonDef.placement.{min_level,max_level}`
  resolves to a radius annulus in `shared/worldgen/atlas.ts` (`bandRadii`), which
  rejection-samples for an entrance on open, on-theme ground. A 5–10 band lands
  at radius 160–400 with today's constants (`LEVEL_CAP = 100`, `DANGER_RADIUS = 4000`).
  **No change needed to get a POI into the right ring.**
- **Discovery.** Keyed on site id, not position (`docs/rotating-wilds.md`), so a
  camp found once is mapped forever across rotations. Free.
- **"N camps connected by paths with a central tent" is already an op sentence.**
  `scatter_sites` (with `roles` + `claim`) → `stamp` `at_tag` with `role_prefabs`
  → `network` (`mst`) → `route` is exactly how the village lays out its building
  plots (`server/game/mapgen/features/building_plots.ts`). A camp is a *feature
  operator plus prefabs*, i.e. content, not engine work.
- **Portal tiles that override their own footprint.** `wildTileAt` already paints
  `'portal'` over both the field and a site's own stamp, so an entrance can never
  be sealed by what is stamped around it. The great tent's portal is that
  mechanism at an offset (gap 5), not a new one.
- **The spawn vocabulary.** `ZoneSpawn` supports `region`, an inline `area` rect,
  an exact `at`, per-spawn `level`, and `spawn_id`, and the zone editor draws all
  three with the Pack / spawn brush tools. The *authoring* side of camp spawns is
  done; only the runtime that materializes them in the wild is missing (gap 4).
- **Boss identity.** `MobTemplate.unique`, `hp`/`stats`/`armor`/`resistances`
  overrides, a weighted `abilities` kit, `preferred_range`, `leash_radius`, and
  `spawn_id`-scoped quest targeting (`kill_specific` matches spawn_id *or*
  template id — `server/game/systems/quests.ts:195`).

## The gaps

### 1. A `grid` stamp kind — **S, shared. DONE.**

`WildStamp` is `blob | line` (`shared/worldgen/stamps.ts`): pointwise descriptors
evaluated as a pure function of (x, y), which is what keeps client and server
byte-identical. A baked grid is the same contract with a lookup instead of a
formula:

```ts
{ kind: 'grid', ox, oy, w, h, runs }    // runs = flat [count, tile, …]; a
                                        // `transparent` cell falls through
```

`stampTileAt` gains one branch, `wildTileAt` is untouched, and the client gets it
free — it already fetches the whole atlas from `/api/atlas` and derives terrain
locally. Size is a non-issue: today's atlas is 3.5 KB on disk and a 64×64
footprint RLEs to 1–2 KB.

**The transparent cell is the important detail.** A hard-edged rectangle of dirt
in the middle of a forest reads as a rendering bug. Transparency lets the author
ragged the perimeter by hand, and composes with the existing feathered `blob`
for an apron of trampled ground around the camp.

### 2. Wilderness blocking has to widen — **S, shared. DONE.**

`WILD_BLOCKING` was a hardcoded three-tile set (`tree`, `water`, `swamp_water`).
Tent walls and palisades must block too — but *which* tiles block is a property
of the world's **tileset**, which `shared/` deliberately cannot read.

So rather than a second hardcoded list that drifts from the tileset: the bake
collects the blocking tiles it actually painted and puts them on the atlas
(`RegionAtlas.stampBlocking`), and `isWildBlocked(tile, atlas?)` consults it.
The client already fetches the whole atlas, so both sides agree for free — the
same way they already agree about terrain.

New wild tiles still need color/sprite entries in `tilesets/overworld.json`,
which the zone editor can already write (`PUT /api/tiles/:tileset`). The camp
tiles used so far (`thatch`, `wall`, `door`, `wood_floor`) are already there.

### 3. Placement viability at footprint scale — **S/M. DONE.**

`entranceViable` (`atlas.ts`) tests one tile and the ground immediately around
it. A 64×64 footprint needs most of its *area* on land and clear of mountain.
Sample a coarse lattice across the rect instead of a point.

The stamp paints over whatever is beneath it, so this is an aesthetic constraint
rather than a correctness one — a camp half in the ocean still *works*. But 240
attempts in a 160–400 annulus gets tight with a large footprint, so expect to
relax the biome theming earlier than the current last-third rule.

### 4. Authored entities in the wilderness — **L, engine. DONE.**

The largest single item, and the one that decides whether the camp reads as a
place or as a terrain decal.

Wild mobs came from exactly one source: `Wilderness.materializeChunk`, a
per-chunk procedural roll against a roster. And `isHuntable` **explicitly
denylists** `npc`, `friendly`, `fixture`, `sign`, `inert`, `shop`, `trainer`, and
board-carrying templates — "quest-givers/villagers, kept out of the wilderness on
purpose." That is exactly the quest-giver, the torches, and the notice board a
camp needs.

That filter was left alone — it is right for the procedural path. The second
source is `server/game/siteSpawns.ts`:

- **The authoring surface is the footprint's own `spawns` array.** No new
  vocabulary: `ZoneSpawn` already has `region`, `area`, `at`, `count`, `level`,
  `respawn_seconds`, `spawn_id`, and the editor already draws all of them.
- **Resolution is deterministic in (site, epoch)** and runs against the baked
  `bounds`, so the same epoch puts the same camp population in the same places.
  That is what lets a chunk be despawned when nobody is looking and materialized
  again identically when someone returns.
- **By region, never by coordinate** (Consequence 1). A named region that did not
  generate this epoch *warns and skips* rather than silently vanishing — the
  failure the editor's epoch sweep exists to catch, made loud at runtime too.
  `at` survives as the sconce escape hatch: exact, unfiltered, may sit on a wall.
- **Respawn.** `World.tickRespawns` iterates `defs.zones` and `WILD` is not one
  of them, so the wild got its own hook (`GameLoop.onWildRespawn` →
  `Wilderness.tickSiteSpawns`). Only *observed* chunks are ticked; an unobserved
  one has been despawned wholesale and re-materializes identically anyway.
- **Despawning is not dying.** The unload path forgets an authored entity while
  it still exists, which is how "put it back" is told apart from "start the
  respawn clock" — otherwise walking away from a camp and back would leave it
  empty for the respawn interval. Mid-fight survivors are skipped, or the
  re-materialize would stack a second copy on the first.
- **The procedural roll now avoids a footprint whole**, transparent cells
  included. Those cells are the gaps *between* the tents; a wandering band mob in
  there undercuts the authorship the camp exists for.

Rotation was nearly free, as expected: the existing cull removes every non-player
wild entity, and the plan is re-resolved for the new epoch alongside it.

**Bonus: hot-reload is back.** The cost section below flagged that a baked
exterior loses hot-reload, since the watcher rebuilds *zones* and a footprint
lives in the atlas. `rebakeFootprints` in `server/index.ts` closes that: saving in
the editor re-bakes onto the live atlas, culls and re-materializes the wild, and
emits `wild_reset`. Camp iteration is a 30-second loop rather than a restart.

### 5. Portals out of a footprint — **S. Single-portal case is free.**

`wildTileAt` already returns `'portal'` for `atlas.sites[].worldX/Y`, overriding
both the field and the site's own stamp so an entrance can never seal itself.

The bake centers the footprint on the site tile, so **the entrance is always the
footprint's exact center** — a region placed `at: { center: true }` always
contains it, with no offset bookkeeping at all. That is the whole single-portal
case, and it is why the raider camp's great tent is a centered region.

What is left is the plural form: a site as a footprint plus N portal *offsets*
within it, each targeting a different interior zone. Same mechanism, indexed.

### 6. ~~Authored interiors re-roll daily~~ — **deleted; nothing to build**

This was scoped as a `fixed_seed` opt-out so a hand-authored boss room would stop
regenerating. With interiors re-rolling too, **it deletes entirely** — an interior
that re-rolls is just a dungeon zone template, which is exactly what
`world/dungeons/*.json` already is.

Worth noting the axis inverts. Today the split is by *directory*: everything in
`world/zones/` is fixed (own seed, byte-identical every epoch — see
`docs/rotating-wilds.md`), everything in `world/dungeons/` rotates. The rule you
want — **safe zones are fixed, everything else re-rolls** — is already what that
split encodes. So it needs no new flag; it needs the convention written down and
new site content defaulting to the rotating path.

The village's fixity is not incidental, either: it is the fixed point players
return to and the only place guaranteed walkable in every epoch, which is why
stale wilderness saves land there (`wildRestorePoint`). Any future safe zone
inherits that job and belongs in `world/zones/` for the same reason.

### 7. Multi-zone sites — **M, engine**

`DungeonDef` is `placement + one seedless zone`. A site now owns: a footprint
(baked from an exterior ZoneDef), authored spawns, and N interior zones. Promote
it to a `SiteDef`. `planRotation` already takes a `siteIds` list
(`server/game/rotation.ts:38`), so feeding it every member zone id is a call-site
change.

### 7b. Guaranteeing the boss chamber — **S, engine**

Re-rolled internals raise one sharp failure mode: the generator produces a layout
with nowhere for the boss to be, and the fight silently doesn't exist that day.
The fix is small and the vocabulary is already there.

`region` is the primitive that **cannot fail**: it resolves a shape at a position,
paints, and unconditionally calls `bb.addRegion(id, bounds)`
(`server/game/mapgen/index.ts:815`). There is no search-and-give-up path, unlike
`place`/`stamp`. So a named `boss_chamber` region always exists.

What it does *not* do is defend the space. Every other placement atom carries
`claim?: ClaimCategory` — `fill`, `scatter_sites`, `stamp`, `place` all do — and
`region` is the one that doesn't. Nothing stops a tent scattering on top of the
chamber afterwards.

The change is one field and one line:

```ts
| { type: 'region'; id; shape; at; floor?; walls?; only_over?;
    claim?: ClaimCategory }          // ← add
```
```ts
if (op.claim) bb.claimRect(r.bounds, CLAIM[op.claim]);   // ← in case 'region'
```

`Blackboard.claimRect` already exists. Then the boss chamber becomes a
**reserve-phase feature operator** — the phase is documented as exactly this
("reserve → claims space before buildings scatter") — so it takes its ground
first and `scatter_sites`, `network` and `route` all flow around it.

That gives three guarantees for free: the region always exists, it is always open,
and `ensure_reach` will carve to it if the layout ever strands it. It also makes
the chamber a stable spawn address (Consequence 1) and a legal home for a stamped
prefab arena (Consequence 2).

This same operator is the reusable answer for anything that must exist every
epoch — the great tent, a chest vault, a quest-giver's post.

### 8. Chests do not exist — **M, engine + tooling. DEFERRED, spec'd here.**

Deferred by decision — the loop works without it, and the fallback below buys
time. Spec'd now so it is not redesigned later.

No container entity exists: `Entity` is `player | mob | ground_item | corpse`, and
`CorpseEntity` is the only thing carrying a `loot: LootSlot[]` the client will
open. So the payoff has no vehicle.

**Runtime.** A `container` entity type reusing the corpse loot window end to end
(`EntitySnapshot.loot` is already wired client-side), placed by an authored spawn
like any other, addressed by region (Consequence 1).

**The authoring shape — the target UX.** Place a chest, give it a **level** and a
**rarity**, contents auto-populate; plus a list of items that are **guaranteed** to
be in it. The generator already has every primitive this needs
(`server/game/items/generator.ts`):

```
level    → sampleIlvl(level)                    item level for the roll
rarity   → rollRarityForIlvl(ilvl), floored     "at least rare"
contents → pickDropBase(defs, ilvl, theme) × n  + affixes
guaranteed → explicit base ids, appended after the roll
```

Two details worth fixing in the spec now:

- **Rarity is a floor, not an exact grade.** The generator's rarity is already a
  roll biased by item level; a floor composes with that (`max(rolled, floor)`)
  instead of fighting it, and keeps a level-20 chest feeling different from a
  level-5 one at the same setting.
- **Contents are seeded at spawn, never rolled at open.** Same epoch → same
  chest → same loot. Rolling on open makes a chest farmable by leaving and
  re-entering; since the interior re-rolls nightly anyway, seeding costs nothing
  and closes that.

The tool side is mostly assembled already: `tools/loot-lab` has `POST /api/roll`
over this exact pipeline, so the chest form's "preview 20 rolls" is a call into a
route that exists, once the tools are consolidated.

*Fallback while deferred:* an `inert: true` fixture mob with a `loot_table`. Zero
engine work; the player attacks the chest to open it.

### 9. The zone editor cannot open a site zone, and cannot preview one in context — **M, tooling. DONE.**

`zoneIndex()` (`tools/zone-editor/server.ts:104`) walks `<world>/zones` only, so
`world/dungeons/*.json` is invisible — every dungeon you have was hand-written
JSON. On top of indexing sites, the exterior needs authoring affordances the
editor does not have:

**What shipped, and the one decision inside it.** Rather than a fourth editor
mode, a site file contributes two ordinary **zone documents** — `<id>` (interior)
and `<id>__footprint` (exterior) — indexed alongside `world/zones/`. Both are
ZoneDefs, so paint, region, stamp, spawn, the JSON pane and save all work on them
unchanged; the dropdown groups them, and save strips the synthesized `id`/`seed`
back out so the loader's "a template must not set these" rule still holds. A site
with no exterior yet opens as a blank transparent canvas, so *creating* one is
just authoring into it and saving.

The new surface is a **Field panel** on exterior documents:

- **The surrounding field is drawn.** A footprint previewed against a black void
  tells you nothing about the seam that matters most, so the preview composites
  the bake over the actual wilderness at the position this epoch gives it. It is
  **read-only** on purpose — you author in the zone view and *check* in the field
  view; editing through a margin-shifted, procedurally-placed frame is a
  coordinate bug waiting to happen.
- **The bake is the runtime bake.** `POST /api/field-preview` calls
  `bakeSiteFootprint`, the same function `server/index.ts` bakes the live atlas
  with. A preview that lies is worse than no preview.
- **An epoch scrubber — required, not a convenience,** since the arrangement
  re-rolls. Plus a 24-epoch **sweep** (`POST /api/site-epochs`) reporting, per
  epoch, whether the site was placed at all, where, in what biome and local band,
  and *which referenced regions failed to generate*. Rows are clickable — the
  report is a way in to the problem, not just a list of them.
- **A transparent brush** came free: `transparent` is already a tileset entry and
  the palette and canvas already render it as a checkerboard.

Still worth adding: the same region-existence check as a **cross-epoch bake test**
in `npm run test:gen`, so a missing boss fails CI rather than being found in
production at midnight. The interactive sweep is the same claim, run by hand.

### 10. Mob editor covers about a third of `MobTemplate` — **M, tooling. DONE.**

The form exposed 10 of `MobTemplate`'s 35 fields; everything that makes a boss a
boss was hand-written YAML, and abilities lived in a separate tool on a separate
port. It now covers **32 of 35**, grouped the way an author thinks about a mob
(identity / combat / ability kit / wild spawning / loot / dialogue & flags).

**The form is generated from a spec, not written as markup.** 35 hand-written
rows would be unreadable and would drift from the type the moment it changed;
`MOB_FIELDS` *is* the coverage claim, and a coverage check against
`MobTemplate` is a five-line script. `shop`, `featured_stock` and `trainer` are
deliberately left to the JSON pane — merchant configuration is a different
authoring job, and the form says so at the point it stops.

**Blank deletes.** An optional field cleared in the form is removed from the
template rather than written as 0, so an author can always get back to "derived"
instead of being stuck with whatever the form defaulted to.

- The **ability kit picker** reads `world/abilities/*.yaml` through the loader
  and shows each entry's cooldown, range and effect kinds inline. Per-entry
  fields are `weight` and `hp_below` — cooldown is a property of the *ability*,
  not of the mob's use of it, so it is displayed rather than editable. The hint
  says weight is strict priority, not a roll, because a low weight on a
  long-cooldown signature move starves it to never firing.
- The **combat profile** panel runs the real damage core against the template as
  edited: effective HP, per-swing damage, and hits-to-kill both ways versus a
  player of each class. `tools/combat-sim.ts` was split into
  `tools/lib/combat-sim.ts` so the panel and the CLI balance table are the same
  harness — the same one-implementation discipline the mapgen bake follows
  between preview and runtime. The CLI's output is unchanged.

**A finding fell out of wiring it up.** At level parity a *geared* fighter (iron
sword, full iron set) kills a soldier in ~22 swings against ~10 unarmed: a
tier-1 weapon with `D` strength scaling is strictly worse than fists, because
unarmed gets `strBonus` *plus* a per-level term and a scaled weapon gets
neither. That is a balance question for `docs/plan-combat-retune.md`, not a
harness bug — the panel reports the unarmed matchup, which is what the TTK
anchor is stated for, and the geared numbers stay in the API for when the
weapon curve is fixed.

### 11. There is no quest editor — **M/L, tooling (new)**

Quests are hand-written YAML, Zod-validated at load
(`server/world/quest_schema.ts`). Nothing in the GUI touches them, and the README
already records the failure mode: *a staged quest's giver may not be placed*.

A form over `QuestBodySchema`:

- Stage list, five objective kinds, world-populated pickers: giver from mobs
  **and from `spawn_id`s across all zones and sites**, `zone` from the zone index,
  `target_id` from templates + spawn ids, `item_base` from `entities/items/bases`.
- A stage-graph view (`on_complete` edges, `done` terminal) — `validateStageGraph`
  exists; render what it checks.
- Save-time validation through the real `validateQuestDef`, plus the checks the
  loader cannot make: is the giver actually spawned anywhere, does the `reach`
  zone exist, is the `kill_specific` target reachable from the giver.

Note `kill_specific` matches **spawn_id or template id**
(`server/game/systems/quests.ts:197`), so a boss can be targeted as one specific
placed instance — which is what you want when the same template might appear
elsewhere later.

Put it in the zone editor as a `Quest` mode rather than a new port. The pickers it
needs are what that server already loads per world, and a quest is authored
against a place you are looking at.

## Suggested order

Each step is independently useful; nothing later is blocked on a big-bang.

1. ~~**(1) + (2) `grid` stamp and blocking.**~~ **Done.** `GridStamp` +
   `encodeGridRuns` in `shared/worldgen/stamps.ts`; `bakeSiteFootprint` /
   `bakeAtlasFootprints` in `server/game/mapgen/bake.ts` (the one module both the
   tool and the runtime import); `DungeonDef.footprint` is the authored exterior;
   the server bakes at `loadOrBuildAtlas`, before the cache write, on boot *and*
   on rotation. A 40x40 camp bakes to 1.3 KB.
2. ~~**(3) footprint-scale placement** + **(9) bake button and in-context preview**.~~
   **Done.** `footprintViable` samples a lattice across the rect and spacing
   counts the footprint; the editor indexes `world/dungeons/*.json` as ordinary
   zone documents (`<id>` interior, `<id>__footprint` exterior) so every existing
   tool works on them, and a Field panel bakes the open footprint over the real
   wilderness at the epoch you scrub to, with a 24-epoch sweep for placement and
   region existence. `world/dungeons/raider_camp.json` is the seed POI.
3. ~~**(4) authored wild entities.**~~ **Done.** `server/game/siteSpawns.ts`
   resolves a footprint's `spawns` against its baked layout; `Wilderness` owns
   materialize/despawn/respawn; the procedural roll steps around a footprint
   entirely. Hot-reload of a baked exterior came with it.
4. **(5) + (7) + (7b) portals, multi-zone sites, and the reserved boss chamber.**
   The interior opens up. (7b) is small and should land with the first re-rolled
   interior, not after it.
5. ~~**(10) full mob editor** + combat-sim panel.~~ **Done.** 32 of 35
   `MobTemplate` fields, generated from a spec; ability kit picker with the
   registry's own cooldowns; a combat profile panel sharing
   `tools/lib/combat-sim.ts` with the CLI balance table.
6. **(8) chests** — deferred; the `inert` fixture-mob fallback covers the gap
   until the container entity is worth building.
7. **(11) quest mode.** Ties the loop shut.

Steps 1–3 are the ones that don't exist in any form today. Everything from 4
onward is extending a mechanism that already works.

## What this costs versus the enclosed-zone version

Worth stating plainly: the enclosed-zone exterior was nearly free — it reused
mapgen, spawns, portals, hot-reload and the editor with no engine work at all.
The field-stamped version buys physical presence in the open world and
seed-driven relocation, and pays for it in three places:

- **the atlas grows a data-carrying stamp kind** (small, bounded, fine);
- **authored spawns in the wild are genuinely new** (gap 4, the real cost);
- ~~**hot-reload is lost for the exterior.**~~ **Fixed** (gap 4). Editing a zone
  file rebuilds it in place (`server/world/watcher.ts`); a baked footprint lives
  in the atlas, so `rebakeFootprints` re-bakes onto the live atlas, culls and
  re-materializes the wild, and emits `wild_reset`. Position does not move —
  placement is a function of seed, epoch and footprint size, and only the last is
  being edited.

## Consolidating the tools

The tools have collided literally, not just conceptually: `ability-editor` and
`biome-workbench` both bind **:3002**, `loot-lab` and `world-map` both bind
**:3003**. Two pairs that cannot run simultaneously — while authoring a boss needs
the mob editor, the ability editor, and the loot roller open at once.

**The unit of editing changes, and that is the real argument.** Today the editor
pivots on a ZoneDef picked from a dropdown. A site is an exterior ZoneDef *plus*
interiors, authored spawns, placement metadata, the mobs it spawns, the loot they
carry, and the quest that frames it. Editing that across five ports with five
world-caches is the friction; one tool that pivots on **the site** is the fix.

Decisions this implies, in the order they get expensive to change:

**One server, one page, modules — no framework, no build step.** `tools/zone-editor/index.html`
is already 1,679 lines of vanilla JS behind a mode switch; adding site, quest,
ability, and full-mob modes takes it past 5k. Split it into ES modules loaded with
`<script type="module">` and served statically. The game client is deliberately
framework-free; the tooling should not be the thing that introduces React. One
Express server on **:3001**, absorbing the other tools' routes — their world
discovery, caching, and file-write helpers are near-duplicates already.

**One bake function, imported by both the tool and the runtime.** The tool's
footprint preview and the server's atlas bake must never drift. Put
`bakeSiteFootprint(zoneDef, seed)` in one module both import — the same discipline
`shared/worldgen/` already enforces between client and server, applied to tooling.
A preview that lies is worse than no preview.

**One problems panel.** (Partly started: the Field panel's sweep is the first of
these, and `/api/field-preview` already folds mapgen warnings and missing-region
errors into the existing warnings badge.) Validation is scattered today: the zone editor captures
mapgen `console.warn`, the quest schema throws at load, ability lint is a CLI,
cross-epoch region existence is checked nowhere. Aggregate them into one surface
that answers "is this site shippable?" — mapgen warnings, unknown spawn entities,
regions missing in any sampled epoch, quest giver not placed, ability lint. This
is where the cross-epoch bake test (gap 9) surfaces interactively.

**A dev channel to the running game.** Half done: the file watcher now re-bakes
and emits `wild_reset` (gap 4), so saving in the editor moves the tents under
your feet. Still missing is the other half — a "teleport me there" that reuses
`/tp`, so you do not have to walk to your own camp to look at it.

**Settle the vocabulary before writing code.** `DungeonDef` → `SiteDef`,
`DungeonSite` → placed site, "dungeon" → "site" across atlas, loader, rotation,
and docs. Free now, a wide mechanical diff later.

Leave `forge` (:3006) alone — it is a generation pipeline UI, not an authoring
surface, and it has its own event-stream model.

## The safe-zone flag: two properties, not one

Worth separating at the point of naming, because they will drift apart:

- **`safe: true` on a ZoneDef** — the *gameplay* property. No hostile spawns
  today; plausibly rest bonuses, storage, and respawn anchoring later.
- **Fixity** — the *structural* property, that the zone does not re-roll. This is
  already implied by where the definition lives (`world/zones/` vs a site's
  rotating members) and needs no flag.

They coincide right now, which is exactly why conflating them into one flag is
tempting and wrong: a fixed non-safe zone (an authored landmark) and a safe
rotating zone (a wandering camp of friendlies) are both coherent things to want
later.

## The rotation rule, stated once

Everything re-rolls. The exceptions are **safe zones** — the starting village
today, whatever else earns the label later — and they are exceptions because
players need a fixed point to return to, not because they are hand-authored.

That gives a clean test for new content: *does a player need this to be in the
same place tomorrow?* If yes it is a safe zone and lives in `world/zones/`. If no
it re-rolls, and every reference to it must be by **name** — site id, region id,
spawn id — never by coordinate. Discovery already works this way
(`docs/rotating-wilds.md`), and Consequence 1 extends it to spawns.

## Open decisions

- **One POI or a roster?** All of the above works for N sites; the first one just
  proves the path.
- **Does the wild need a level-scaled *guard* population around the footprint,**
  distinct from the authored camp spawns? The procedural roll already puts
  band-appropriate mobs nearby, which may be enough.
