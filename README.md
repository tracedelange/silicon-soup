![Silicon Soup Banner](assets/banner.png)

## Quick start

```bash
npm install
npm run dev            # server (tsx watch, :3000) + client (vite, :5173)
```

Open http://localhost:5173 (**not** :3000 — that serves the last `npm run build`
output in `client/dist`, which goes stale).

```bash
npm run build && npm start      # production-ish: server serves client/dist
npm run typecheck               # tsc across root, client, pipeline, tools
npm run lint                    # eslint
npm test                        # vitest unit tests (colocated *.test.ts)
WORLD_DIR=forge/runs/run_123/world npm start   # boot a generated world instead
WORLD_SEED=silicon-soup npm run dev            # pick the wilderness BASE seed
WILD_ROTATE=0 npm run dev                      # pin the wilds (no daily rotation)
WILD_EPOCH_MS=180000 npm run dev               # roll every 3 min (to watch a rotation)
```

`.env` holds `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
for a proxy/local endpoint), `FIREBASE_SERVICE_ACCOUNT_PATH`, `PORT`,
`CLIENT_ORIGIN`. Only the generation tooling needs the LLM keys — the game runs
without them.

Deploy: client → Firebase Hosting (`scripts/deploy-client.sh`, site `iron-broth`);
server → pm2 (`scripts/start.sh` / `stop.sh`, `ecosystem.config.cjs`).

---

## Repo map

```
shared/          types + constants + worldgen field — imported by BOTH server and client
server/          Socket.IO game server, world loader, hot-reload watcher, SQLite
client/          Vite + <canvas> client (no framework)
world/           the live world: zones, mobs, items, abilities, quests, prefabs, tilesets
forge/           the generation cascade (Tier 1→3), the grow loop, the mob one-shot
pipeline/        v1 Gardener/Implementer loop + the shared LLM transport (llm.ts, validate.ts)
tools/           dev workbenches (zone editor, ability editor, loot lab, biome/world gen)
sprites/         offline Python sprite/tile baker (ComfyUI + SDXL + pixel LoRA)
docs/            design docs — the "why" for nearly every subsystem here
data/            SQLite db + cached region atlases (gitignored)
.claude/skills/  repo-local agent skills: new-mob, new-zone, new-quest, new-zone-feature
```

~35k lines of TypeScript. `shared/types.ts` (1.8k lines) is the single source of
truth for every wire message, entity, and world-definition schema — read it first.

---

## Runtime architecture

**Server-authoritative, fixed tick.** `server/game/loop.ts` runs the world tick;
the client is a renderer plus an input sender. All movement, combat, and pathing
resolve server-side (`systems/autopath.ts` runs A* and advances one step per
tick — client-side path execution was removed because of latency desync).

**Transport:** Socket.IO. The full event contract is `ClientToServerEvents` /
`ServerToClientEvents` in `shared/types.ts`. Requests that need a result use
acks, not response events.

**Two kinds of space** (the core spatial decision, see `docs/rework.md`):

| | Enclosed zones | Open wilderness |
|---|---|---|
| Model | bounded grid, own coordinate space | one continuous, effectively infinite field |
| Definition | `world/zones/*.json` → gen-op pipeline | pointwise function of `(x, y, seed)` |
| Terrain over the wire | full grid in the `zone` snapshot | **never sent** — client recomputes it |
| Entities | per-zone room | per-**chunk** room (`wild:cx,cy`), 32×32 tiles |
| Entry | portals | portal tile in the village → world tile `(0,8)` |

The wilderness determinism contract is load-bearing: `shared/worldgen/`
(`noise.ts`, `field.ts`, `atlas.ts`, `config.ts`) is imported by client *and*
server, so both derive byte-identical terrain. Never move wilderness generation
into `server/`. Difficulty is radial — `dangerAt(x,y)` rises with distance from
origin and plateaus at `DANGER_RADIUS`, so distance **is** the progression
scalar. The sparse region atlas (256-tile cells: danger, biome bias, settlement
registry, dungeon sites) is prebaked once per seed and cached to
`data/atlas-<seed>.json`; dense chunk terrain is derived live and never stored.

**The wilds rotate.** The seed folds in a daily epoch bucket
(`shared/worldgen/epoch.ts`), so terrain, spawns, and dungeon placement/layout
all re-roll together at **midnight Pacific** — **in place, with no restart**
(`kill -USR2 <pid>` forces it early). The village is
seed-independent and stays put, and **danger stays radial**, so level bands never
move — that is what makes rotating the whole world safe. What persists across a
rotation is *discovery*: a named dungeon found once is mapped forever, wherever
the current epoch put it. Read `docs/rotating-wilds.md` before touching any of
this.

**Zones are deterministic programs, not saved grids.** A `ZoneDef` is
`biome + seed + features[] + post_ops[]`; the grid is rebuilt on load from a
~25-verb `GenOp` list (`fill`, `region`, `road`, `cave`, `bsp`, `scatter_sites`,
`stamp`, `network`, `route`, `ensure_reach`, `voronoi`, `portal`, …). Biome
modules (`server/game/mapgen/biomes/`) supply the base program; **feature
operators** (`server/game/mapgen/features/`) are the *only* content interface —
coordinate-free named bundles of ops with a placement phase
(`reserve → build → decorate`). `server/world/watcher.ts` hot-reloads a zone
in place when its JSON changes, so editing a file or running a generator takes
effect without a restart.

**Persistence:** SQLite via `better-sqlite3` (`server/db/schema.sql`) — accounts
(Firebase UID), up to 3 characters each, plus player-writable message boards.
Auth is Firebase ID tokens verified server-side (`server/auth.ts`). Nothing about
the *world* is persisted; it is regenerated from definitions every boot.

---

## Game systems (`server/game/systems/`)

- **combat.ts** — subtractive armor with a 25% minimum-damage floor, dex-based
  dodge (capped 30%), letter-graded stat scaling (`S/A/B/C/D/E` →
  `SCALING_COEFFS`), elemental brands and per-mob resistance multipliers. There
  is deliberately **no accuracy roll** yet.
- **abilities.ts** — the ability engine. Five effect kinds: `damage`, `heal`,
  `modifier` (timed stat bundles + dots/hots + CC flags: stun/root/silence/
  confuse/fear/antagonize), `move` (charge/leap/knockback/blink), `zone`
  (persistent ground hazards independent of any entity). Targeting shapes:
  `self | target | projectile | area | point`. Player abilities have gold-priced
  ranks bought from trainers; mob abilities are weight-prioritized (highest-weight
  *ready* ability fires — weight is priority, cooldown is frequency).
- **ai.ts** — role-driven behavior (`tank | pest | soldier | ranged | support |
  npc | passive`), aggro ranges, dispositions, retaliation for non-hostiles.
  Each engaged mob keeps a **threat table** (damage dealt to it 1:1, healing
  done to anyone already on it at `HEAL_THREAT_FACTOR`) and picks its target off
  that table, not off proximity — a challenger must beat the current target by
  `THREAT_SWITCH_MULT` to pull it. The `antagonize` CC (taunt) overrides the
  table outright while it lasts, and lifts its caster to the top of it so the
  mob doesn't snap back when it expires. Chase is leashed to a radius around the tile the mob *engaged* from (not around
  its target, which a fleeing player can drag forever): break it and the mob
  drops threat, restores to full hp/mana, sheds its debuffs, and walks home —
  damage-immune on the way, so it can't be shot in the back mid-reset. That full
  restore is what makes hit-and-run whittling unprofitable given 1 hp/s
  out-of-combat regen.
- **loot.ts / items/generator.ts** — procedural item bases
  (`archetype × material`) rolled with prefix/suffix affixes across four
  rarities.
- **quests.ts** — staged questlines with five objective kinds (`kill_count`,
  `kill_specific`, `collect_count`, `reach`, `talk`), serial gating, repeatables.
- Also: `movement`, `autopath`, `inventory`, `stats`, `progress`, `dialogue`,
  `commands` (`/tp`, `/give`, `/spell`, `/map`, `/god`, …).

Client-side (`client/src/game.ts`, 4k lines) covers rendering, minimap, the
atlas-derived world map, hotbar, inventory/equipment, quest log, trade/train UI,
chat, and procedural paper-doll player sprites (`playerSprite.ts`).

**Teleports announce themselves.** Every discontinuous relocation — `/tp`, a
portal, an ability blink, a wilds rotation — funnels through `World.teleportFx`,
which emits a puff of smoke at *both* ends (`teleport_fx`, one event per zone
room). Continuous movement, including walking across a zone seam, deliberately
does not; the distinction is the caller's to make, which is why the hook sits on
the explicit teleport entry points rather than on `_relocate`.

---

## The generation stack

This is the point of the project. The history is worth knowing because the
current design is a direct reaction to what failed.

**v1 — `pipeline/` (Gardener → Implementer).** One cheap model, per node, with
local context, asked to invent the standard, design the node, and instantiate it
all at once. Produced "plausible mediocrity": locally valid, globally incoherent,
and every prompt fix moved the defect elsewhere. Largely superseded; its LLM
transport (`pipeline/lib/llm.ts`, `validate.ts`) is still the shared substrate.

**v2 — `forge/` (the current entry point).** Thesis: *author the grammar,
generate the instances; coherence is inherited top-down; quality is checkable,
not hoped for.* See `docs/v2-top-down-generation.md`.

```
Tier 0  world map / biomes / level bands      programmatic (mapgen, atlas)
Tier 1  lore bible → world blueprint          strongest model (opus), rare
Tier 2  region → per-zone decided specs       mid model (sonnet)
Tier 3  specs → concrete YAML instances       cheap model (haiku) / deterministic
```

Model per tier resolves `FORGE_TIER{N}_MODEL → PIPELINE_MODEL → default`
(`forge/lib/models.ts`), so a single local Ollama tag can drive every tier.
Every run streams events to `forge/runs/<id>/events.jsonl` — successes *and*
failures, all tiers — so any run is fully replayable.

**Iterative growth (`forge/grow/`)** — `docs/iterative-growth.md`. The zone graph
is a persistent, append-only artifact the forge reads *and* extends. One `grow`
step designs a themed **region** (~5–8 zones) attached at a frontier seam, with
an approve/regenerate gate. Growth order **is** the difficulty gradient, which
structurally fixes scrambled level bands.

**Two clocks — the novelty/correctness resolution.** Deterministic instancing
from a frozen vocabulary is what made generation correct; it also bounds variety.
So: *grow* (fast clock) recombines the existing library deterministically, while
*invent* (slow clock, `forge/lib/inventor.ts`) mints **new library entries** —
archetypes, factions, prefabs, abilities — validated once and frozen. **Novelty
enters the library, never the instance.**

```bash
npm run forge                    # cascade UI (:3006), stub mode
npm run forge:live               # ... with real model calls
npm run forge:ollama             # ... against a local/cloud Ollama
npm run forge:stage -- run_123   # assemble a run into a bootable world root
npm run forge:grow               # one iterative grow step (add --yes to skip the gate)
npm run mob-forge -- --theme "sunken bog cult" --level 8 --count 3 [--live] [--commit]
npm run mob-forge:explore        # self-directed: model picks concepts from roster gaps
```

**The mob one-shot** (`forge/lib/mob-forge.ts`) is the most refined generator and
the template for the rest. A mob is only as interesting as its actions, so the
mob template and its **ability kit are proposed in one call**. Each kit entry is
either an existing ability id (explicit reuse) or a new inline definition; a
resolver does functional-equivalence dedup (reuse-over-mint), then a **semantic
linter** (`forge/lib/lint-ability.ts`) gates minting. Wild mobs are anchored to
one of the 8 land biomes — the loop assigns the biome, the model invents a niche
within it.

Dry-run and offline **stub mode are the defaults** everywhere: every generator
runs end-to-end without an API key so the flow is testable. `--commit` / `FORGE_LIVE=1`
opt into writes and real calls.

---

## The world data model (`world/`)

| Path | Format | Notes |
|---|---|---|
| `zones/*.json` | `ZoneDef` | biome + seed + `features[]` + `post_ops[]`; grid is derived |
| `dungeons/*.json` | `DungeonDef` | roster: placement metadata + a seedless zone template, instanced per epoch |
| `entities/mobs/*.yaml` | `MobTemplate` | role, stats, sprite, resistances, weighted ability kit, loot table, dialogue |
| `entities/items/bases/*.yaml` | `ItemBase` | hand-authored bases |
| `entities/items/{archetypes,materials,affixes/}` | — | procedural base composition: archetype × material, + prefix/suffix pools |
| `abilities/*.yaml` | `AbilityDef` | shared by players and mobs; Zod-validated (`server/world/ability_schema.ts`) |
| `quests/*.yaml` | `QuestDef` | staged, gated, Zod-validated |
| `prefabs/*.json` | ASCII grid | `data` + `legend` + `anchors`, stamped by `post_ops` |
| `tilesets/overworld.json` | — | 37 tiles → sprite refs |
| `graph.json` / `blueprint.json` | — | the growable zone graph + cumulative lore/region records |

Everything is loaded by `server/world/loader.ts` under `WORLD_DIR` (default
`world/`), so an alternate world root is a first-class thing.

**Current content:** 3 classes (fighter/rogue/wizard), 3 rotating dungeons, 8 zones (starting village
`zone_0_0` + tavern/sewer/basement interiors, eastern forest, bear cave), the
continuous wilderness, ~38 mob templates incl. a boss (the Cradle Lich), 37
abilities, ~70 item bases plus procedural generation over them, 3 questlines,
11 prefabs.

---

## Assets

Sprites and tiles are **baked offline, never generated at runtime**. The pipeline
(`sprites/`, `docs` in `sprites/design.md` + `SETUP.md`) is Python + ComfyUI +
DreamShaperXL + a pixel-art LoRA on Apple Silicon (MPS), with a Haiku prompt
builder turning a mob description into SDXL prompt grammar, then palette-quantize
→ nearest-neighbor downsample to 64×64 → alpha-mask.

`sprite_baker.py` is kind-aware (`mob` | `item`); item icons bake straight to
`client/public/sprites/` and the client loads `/sprites/<id>.png` by id.
Manifests: `sprites/mobs.json`, `items.json`, `tiles.json`, `tiles_manifest.json`;
`pack_atlas.py` packs sheets. Ability icons are a separate **procedural**
seed-driven pixel-grid generator (`shared/abilityIcon.ts`) that scales visually
with ability rank.

---

## Dev tooling

Each is a small Express server + a single HTML page, run on its own port:

```bash
npm run zone-editor        # :3001  paint/inspect zones, place features & prefabs
npm run ability-editor     # :3002  edit world/abilities/*.yaml with live validation
npm run biome-workbench    # :3002  N variants of a biome across seeds, tag good ones
npm run loot-lab           # :3003  roll the loot/affix pipeline
npm run world-map          # :3003  world graph overview
npm run world-gen          # :3004  world/atlas generation preview
npm run sprite-lab         # :3005  draw gear overlays against the player paper-doll
npm run sprite-coverage    # which equippable items have gear art, and which can't
npm run forge              # :3006  live cascade tree UI
npm run render-zone        # ASCII/PNG render of a zone for inspection
npm run test:gen           # generator fixtures
```

Plus `tools/combat-sim.ts`, `lint-abilities.ts`, `ability-duplicates.ts`,
`repair-zones.ts`, `mob-review.html`.

---

## Design philosophy

1. **Structural authority lives at the sparse upper layer; the dense lower layer
   is pure derivation.** Region atlas is authored/prebaked; chunk terrain is
   computed. Zone defs are authored; tile grids are computed. Nobody stores or
   hand-edits the dense layer.
2. **Determinism is a contract, not an optimization.** Shared generation code
   means the client can render what it never received. Breaking it desyncs the
   world silently.
3. **Novelty in the vocabulary, determinism in the instance.** LLMs mint library
   entries under validation; instancing recombines frozen entries mechanically.
   This is what escaped v1's per-instance whack-a-mole.
4. **Push quality determination upward.** A human curating dozens of grammar
   entries has more leverage than any per-instance judge. The judge's job should
   degrade to conformance checking, which small models do reliably.
5. **One unified interface per concern.** `features[]` is the *only* zone-content
   interface (tags, `append_post_ops`, and override-map forms were all removed).
   One feature registry, one placement pass.
6. **Everything runs offline first.** Stub mode + dry-run defaults mean
   generation flows are testable and reviewable without spending a token.
7. **Comments carry the why.** Non-obvious tuning decisions are documented at the
   site of the decision — read `world/entities/mobs/cradle_lich.yaml` for the
   house style. Preserve these when editing.

---

## Conventions and gotchas

- **Check master registries when adding a type.** New feature operator → also
  register in `server/game/mapgen/features/index.ts`. New ability effect kind →
  schema *and* engine. New quest objective kind → schema + validator + engine (3
  places). Adding the implementation alone is never sufficient.
- **Engine primitives are code-gated.** Affix `bonus` keys, quest objective kinds,
  ability effect kinds — expanding these is engine work, deliberately outside the
  automation loop. Composite content (mobs, items, quests, prefabs, factions) is
  pure data.
- Wilderness blocking is narrow: **only `tree` blocks**. Water and rock are
  passable in the open field (`isWildBlocked` / `WILD_BLOCKING`).
- Zone coordinates are unsigned and per-zone; wilderness coordinates are **signed**
  world tiles. Pathing uses string node keys so signed coords don't collide.
- Mob ability weight is **strict priority**, not a random roll. A low weight on a
  long-cooldown signature move starves it to never firing.
- `.claude/skills/` holds repo-local procedures for the four most common content
  tasks (`new-mob`, `new-zone`, `new-quest`, `new-zone-feature`) — they encode the
  registry wiring. Use them.

---

## Docs index

Read the doc before changing the subsystem — most encode a decision that already
cost a rewrite.

| Doc | Subject |
|---|---|
| `docs/rework.md` | world-structure requirements; the continuous-wilderness paradigm shift |
| `docs/wilderness-slice-handoff.md` | as-built map of the wilderness slice |
| `docs/rotating-wilds.md` | the epoch clock, dungeon roster/instance split, discovery, the world map |
| `docs/v2-top-down-generation.md` | the grammar + cascade + judge thesis; why v1 failed |
| `docs/iterative-growth.md` | region-by-region growth, the two clocks, the inventor |
| `docs/anchor-driven-world-development.md` | iterative regional content expansion |
| `docs/biomes.md`, `zone-generation.md`, `zone-generators.md`, `feature-operators.md` | the mapgen stack |
| `docs/abilities-reference.md`, `plan-abilities.md`, `plan-class-abilities.md`, `mob-ability-design-space.md` | the ability engine |
| `docs/plan-combat-retune.md`, `plan-combat-skills.md`, `plan-loot-merchant-pipeline.md`, `plan-affix-brand-procgen.md` | combat/loot roadmap |
| `docs/plan-player-sprites.md`, `prefab-factory.md` | assets |
| `docs/gardener-v1.md`, `implementor-v2.md`, `implementer-mutation-interface.md`, `pipeline-refinement.md` | v1 pipeline history |
| `TODO.md` | directional notes, not a backlog |

Known open threads: no accuracy roll in combat; damage types (slash/pierce/blunt)
unimplemented; the v2 **judge** is designed but not built; `spawn_weights` is a
dead runtime field; a staged forge quest's giver may not be placed.
