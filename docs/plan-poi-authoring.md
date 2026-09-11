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

### 3. Placement viability at footprint scale — **S/M**

`entranceViable` (`atlas.ts`) tests one tile and the ground immediately around
it. A 64×64 footprint needs most of its *area* on land and clear of mountain.
Sample a coarse lattice across the rect instead of a point.

The stamp paints over whatever is beneath it, so this is an aesthetic constraint
rather than a correctness one — a camp half in the ocean still *works*. But 240
attempts in a 160–400 annulus gets tight with a large footprint, so expect to
relax the biome theming earlier than the current last-third rule.

### 4. Authored entities in the wilderness — **L, engine. The big one.**

This is the largest single item, and the one that decides whether the camp reads
as a place or as a terrain decal.

Wild mobs come from exactly one source today: `Wilderness.materializeChunk`, a
per-chunk procedural roll against a roster. And `isHuntable`
(`server/game/wilderness.ts:31`) **explicitly denylists** `npc`, `friendly`,
`fixture`, `sign`, `inert`, `shop`, `trainer`, and board-carrying templates —
"quest-givers/villagers, kept out of the wilderness on purpose." That is exactly
the quest-giver, the torches, and the notice board a camp needs.

Do not loosen that filter; it is right for the procedural path. Add a second
source:

- authored spawn records on the site, in **footprint-local** coords, using the
  existing `ZoneSpawn` vocabulary against the baked `bounds`;
- a footprint-overlap branch in `materializeChunk` that translates local → signed
  world tiles and bypasses the roster entirely;
- respawn timers per authored spawn — `World._rebuildZone` does this for grid
  zones, the wild has no equivalent;
- despawn/re-materialize on chunk unload. Rotation is nearly free: the existing
  cull already removes every non-player entity in the wild.

### 5. Portals out of a footprint — **S**

`wildTileAt` already returns `'portal'` for `atlas.sites[].worldX/Y`, overriding
both the field and the site's own stamp so an entrance can never seal itself. A
site becomes a footprint plus one or more portal *offsets* within it, each
targeting an interior zone. Same mechanism, plural.

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

### 9. The zone editor cannot open a site zone, and cannot preview one in context — **M, tooling**

`zoneIndex()` (`tools/zone-editor/server.ts:104`) walks `<world>/zones` only, so
`world/dungeons/*.json` is invisible — every dungeon you have was hand-written
JSON. On top of indexing sites, the exterior needs authoring affordances the
editor does not have:

- **Render the surrounding field.** A footprint previewed against a black void
  tells you nothing about the seam that matters most. Draw the actual wilderness
  around it at a candidate anchor — the editor server can import the same
  `wildTileAt` the game uses.
- **A transparent brush** for fall-through cells (see gap 1).
- **A bake button**: `generateZoneGrid` → RLE → write the `grid` stamp and the
  authored spawn list into the site file.
- **An epoch scrubber — now required, not a convenience.** Since the arrangement
  re-rolls, a bake is only shippable once you have seen it across a run of epochs.
  Show where the footprint lands and what it looks like for epoch N, N+1, N+2…,
  catching both "it landed in the ocean" and "the region my boss spawn depends on
  didn't generate this time."

Pair it with a **cross-epoch bake test** in the `npm run test:gen` harness: bake
a site across ~50 epochs and assert that every region an authored spawn references
exists in all of them, and that the great tent's portal region is reachable from
the footprint edge. "Same seed → same output" is already a testable claim in this
repo; "every seed → these regions exist" is the same kind of claim and is exactly
what re-rolling internals puts at risk. Without it, a missing boss is a bug you
find in production at midnight.

### 10. Mob editor covers about a third of `MobTemplate` — **M, tooling**

The form (`tools/zone-editor/index.html:277`) exposes id, name, sprite, role,
behavior, level, speed, aggro, xp, dialogue, loot. Missing and load-bearing for a
boss: `stats`, `hp`, `armor`, `resistances`, `abilities` (id + weight +
cooldown), `unique`, `preferred_range`, `leash_radius`, `respawn_seconds`,
`pack`, `loot_affinity` / `loot_brand`. Abilities live in a separate tool on a
separate port (`tools/ability-editor`, :3002).

- Full `MobTemplate` coverage, grouped (identity / combat / ability kit / loot /
  flags).
- An **ability kit picker** over `world/abilities/*.yaml` with weight and cooldown
  inline. Weight is strict priority, not a roll — say so at the point of entry,
  because a low weight on a long-cooldown signature move starves it to never
  firing.
- A **derived-stats readout**: effective HP, per-hit damage, time-to-kill against
  a level-N player of each class. `tools/combat-sim.ts` already computes this;
  wire it in as a panel instead of a separate CLI run.

Highest-leverage single change for "specify its dialog, behavior, abilities, and
stats" — it collapses three tools and a text editor into one screen.

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
2. **(3) footprint-scale placement** + **(9) bake button and in-context preview**.
   Now you can author a camp and see where it lands.
3. **(4) authored wild entities.** The camp becomes populated. Biggest item; do
   it once the placement half is proven.
4. **(5) + (7) + (7b) portals, multi-zone sites, and the reserved boss chamber.**
   The interior opens up. (7b) is small and should land with the first re-rolled
   interior, not after it.
5. **(10) full mob editor** + combat-sim panel. The boss becomes authorable.
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
- **hot-reload is lost for the exterior.** Editing a zone file rebuilds it in
  place (`server/world/watcher.ts`); a baked footprint lives in the atlas, so
  changing it means a re-bake and an atlas rebuild. Worth wiring the watcher to
  re-bake and re-emit `wild_reset` on a site-file change, or camp iteration
  becomes restart-driven.

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

**One problems panel.** Validation is scattered today: the zone editor captures
mapgen `console.warn`, the quest schema throws at load, ability lint is a CLI,
cross-epoch region existence is checked nowhere. Aggregate them into one surface
that answers "is this site shippable?" — mapgen warnings, unknown spawn entities,
regions missing in any sampled epoch, quest giver not placed, ability lint. This
is where the cross-epoch bake test (gap 9) surfaces interactively.

**A dev channel to the running game.** Editing a zone file hot-reloads it
(`server/world/watcher.ts`); a baked footprint lives in the atlas and does not.
Give the tool a dev-only channel to trigger re-bake + `wild_reset`, plus a
"teleport me there" that reuses `/tp`. This is the difference between a
30-second and a 3-minute iteration loop, and camp authoring is an iteration loop.

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
