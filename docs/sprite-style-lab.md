# Sprite style lab

How the mob/item sprite look was chosen in Sept 2026, and why the pipeline is
shaped the way it is. The conclusions are implemented in `sprites/sprite_baker.py`
and `sprites/workflow.json`; the harness that produced them is
`sprites/style_lab.py` (cycles are regenerable with `sprites/run_cycles.sh`,
output is gitignored).

Goal: find a look that reads as **authored pixel art** rather than a diffusion
render with a filter over it, with a palette that isn't dull, and per-subject
scale so a coin isn't the size of a bear hide.

Nothing in `experiments/` is wired to the game. Promotion to `client/` is a
separate, deliberate step once a style wins.

## Pre-cycle findings (not cycles — setup)

Two defects were found and fixed before cycle 1 counted, because letting them
vary would have wasted cycles rediscovering them.

**1. `rembg` destroys the palette.** The ComfyUI graph already reduces to 20
colours (`PixelArtDetectorToImage`, `reduce_palette=True`). Then
`sprite_baker.post_process` runs `rembg`, which is a photo-matting model:
measured on a clean 21-colour input it returns **465 colours and 250 distinct
alpha values**. That is the source of the soft halos and the "painted, not
pixelled" read across all 90 shipped sprites (median 103–109 colours).
`PALETTE_N = 24` exists at `sprite_baker.py:56` and is never referenced — the
repair was designed and never wired up. `style_lab.post()` does the colour work
*after* matting instead, and hardens alpha to 2 values.

**2. `fills frame` makes the model paint a background plate.** The first
control generation of `copper_coin` came back as a coin mounted on a square
brown plaque, which `rembg` then cut out as the subject. "Fills frame" and
"plain background" are contradictory; the model resolves them by inventing a
panel. Scale is a post-process concern now, so the instruction is pure
downside — stripped from positive, with `frame, border, plaque, panel, card,
inset, background plate` added to negative for every cycle.

Also learned: the raw frame arriving from ComfyUI is already ~104x152, not
832x1216 — `PixelArtDetector` downscales to 1:1 pixel scale inside the graph.
So "generate smaller to reduce the downsample ratio" is a weaker lever than it
looked; c3 tests it anyway, but expectations are lowered.

Throughput on MPS: **~143s per SDXL-base generation**, so an 11-subject cycle is
~26 min. The Lightning checkpoint at 8 steps should be several times faster —
that's part of what c4/c5 measure.

## Cycles

| # | style | what it tests | verdict |
|---|-------|---------------|---------|
| 1 | `c1_control` | production gen + fixed post-process | _pending_ |
| 2 | `c2_palette` | c1's exact frames on endesga-32, +35% sat | _pending_ |
| 3 | `c3_chunky`  | 768² square, CFG 9.5, stronger LoRA | _pending_ |
| 4 | `c4_flatcel` | Lightning + flat cel-shading grammar | _pending_ |
| 5 | `c5_painted` | Lightning + painted grammar on pear36 | _pending_ |

c2 reuses c1's raw frames rather than regenerating, so the palette comparison
is a true A/B on colour alone and costs no GPU time.

### Verdicts

**c1 partial (5/11), 21:2x** — big step up on the pixel-art read already: `bear`
is genuinely good, `acid_ooze_01` is vivid, `wolf_01` is acceptable. Colour
counts landed at 15–19 and alpha is a hard 2-value mask, so the rembg fix holds
in the wild.

One failure: `villager` came back as **six scattered figures**, despite
`character sheet, multiple views, multiple subjects` all sitting in the
negative. Hypothesis: the 832x1216 portrait latent invites the model to fill
vertical space by stacking figures — SDXL treats a tall frame as an invitation
to compose. c3/c4/c5 are all 768x768 square, so the experiment already tests
this; additionally `SINGLETON_POS` now states the count *positively*, which
SDXL weighs far more heavily than a negative. That lands from c2 onward —
c1 had already imported the module, so it stays a clean control.

---

### c1_control — verdict: **strong baseline, two composition failures**

The pixel-art read is already fixed relative to production: 15–19 colours, a
hard 2-value alpha, no halos. `bear` is genuinely good art, `acid_ooze_01` is
vivid, `health_potion` and `iridescent_shard` are clean.

**Scale classes work.** The coin is visibly a small object and the pelt a large
one, in the same grid. That was the single biggest legibility complaint and it
is resolved in post-process, independent of any style choice.

Failures: `villager` and `armorer_01` both returned scattered multi-figure
character sheets. `wolf_pelt` renders a wolf's *face* rather than a folded
hide — the description says pelt, the model draws the animal. `copper_coin`
came back with a stray second blob.

### c2_palette — verdict: **rejected, and informative**

endesga-32 at +35% saturation is punchier and more cohesive, but it distorts
hue badly: the bear turns **red**, the wolf turns blue, and the shard loses the
pink that made it iridescent. A vivid 32-colour palette simply has no earth
ramp, and this subject range is mostly earth tones.

### Palette sweep (free, no GPU — `experiments/palette_sweep.png`)

Eight palettes over c1's saved frames. **`apollo` wins clearly**: correct warm
brown on the bear, a cool grey-green wolf, bright acid green on the ooze, and
it preserves the shard's pink/cyan. It is the only candidate that is both
naturalistic *and* a shared ramp.

- `adaptive` (per-image median cut) — correct hues but no shared palette, so a
  set of 90 will never cohere. This is what production effectively does.
- `resurrect-64`, `jehkoba64`, `pear36` — bear goes red / mustard / pink.
- `fantasy-24` — pleasant muted mood, but the acid ooze goes teal.
- `lost-century` — desaturated and introduces dither speckle.

**Decision: `apollo` is the palette.** c3/c4/c5 switched to it so those cycles
isolate the generation axis instead of re-testing colour.

### Post-process fix added: largest-connected-component

An icon is one thing; rembg keeps every foreground blob. Keeping only the
largest component fixes `copper_coin`'s stray lump, and the discarded fraction
doubles as a mis-gen detector — it correctly flagged `villager` (38% of ink in
the largest blob) and `armorer_01` (34%) as multi-figure without being told.

### c4_flatcel — verdict: **winner so far, and the fastest**

Lightning checkpoint (8 steps, cfg 2.0, dpmpp_sde + sgm_uniform) at 768x768
with the flat cel-shading grammar, on apollo.

**82s per generation vs 143s for SDXL base — 1.75x faster**, and better art.
That is the single most useful parameter finding of the night: the distilled
checkpoint is both quicker and more suited to the job, because 8 steps of a
model that commits early produces flatter, higher-contrast shapes than 24 steps
of SDXL base rendering volume it then loses in the downsample.

Wins over c1:
- `wolf_01` went from a slumped grey mass to a readable snarling wolf.
- `goblin_shaman_01` is now a clear figure with a staff instead of a thin smear.
- `copper_coin` is an actual round struck coin with an emblem, not a blob.
- **`villager` and `armorer_01` are single figures.** The multi-figure bug is
  fixed. Both the square latent and `SINGLETON_POS` changed at once, so which
  one did it is unproven — c3 (square, no grammar change) separates them.
- `health_potion` and `iridescent_shard` are close to shippable.

Remaining: `villager` is plain (that is the subject, not the style), and
`deer_skin` still leans rectangular. `wolf_pelt` needed the blob filter — the
raw had four pelts, now collapsed to one and it reads as a mounted hide.

Note: c4 imported the module before the blob filter existed, so its first pass
shipped all four pelts; `repost` fixed it for free. Cheap illustration of why
raws are saved.

### c5_painted — verdict: **keep as a second, distinct style**

Same Lightning checkpoint and square latent as c4, cfg 2.5, painted grammar
(warm key + cool bounce, chunky simplified forms) on apollo. 90s/gen. No
mis-gens.

Not a worse c4 — a different look, and worth keeping as an option:

- Richer surface texture and more internal detail. `wolf_01` is a stronger
  read here than in c4 (near-black fur, higher contrast), and `villager` gets
  an actual blue robe and some character instead of c4's plain brown.
- `armorer_01` drifts toward "armoured knight" rather than "smith", so the
  painted grammar pulls harder on genre than on the description.
- Items are weaker than c4: `wolf_pelt` reads as a fur wreath, `health_potion`
  is muddier, `copper_coin` less crisp.

**Split recommendation: c4's flat grammar for items, c5's painted grammar for
creatures.** They share checkpoint, sampler, scheduler, latent and palette, so
this is a one-line grammar switch per kind, not two pipelines.

### c3_chunky — verdict: **rejected, over-cooked**

SDXL base at 768x768, cfg 9.5, 30 steps, LoRA 1.15. 115s/gen. Worst cycle of
the five despite being the second most expensive.

CFG 9.5 is far too high: the bear collapses into red mush, `wolf_01` is harsh
and speckled with blown highlights, `iridescent_shard` is over-contrasted,
`copper_coin` is a scribbled disc, and `wolf_pelt` came back as what look like
metal lockers. `villager` shows two merged figures even with the square latent.

Useful negative result: **high CFG is the wrong regime for this job.** The
Lightning checkpoint's cfg 2.0–2.5 is not just faster, it is the correct
setting — low guidance leaves flat, confident colour areas, high guidance
fights the palette reduction and produces speckle.

Also corrects an earlier claim of mine: c3 does **not** isolate "square latent"
from "singleton prompt", because `SINGLETON_POS` was already live when c3 ran.
c3 vs c4/c5 isolates grammar and CFG instead. See `probe_portrait` below for
the actual aspect-ratio isolation.

### probe_portrait — aspect ratio is NOT the cause

c4's exact settings with the 832x1216 portrait latent restored, on `villager`
and `armorer_01` — the two subjects that failed as multi-figure sheets in c1.

**Both came back as single figures**, with no blob-filter intervention. So the
tall latent was never the problem; `SINGLETON_POS` — stating the subject count
positively rather than only negatively — is what fixed it. Portrait latents
stay available, which matters for tall subjects (a staff, a polearm, a standing
humanoid), and the portrait villager has visibly better proportions than the
square one.

(c1's armorer only *looks* single in the comparison because the blob filter
salvaged one figure out of six. The raw is still a character sheet.)

---

## Conclusions

### Two styles worth keeping

`experiments/recommended/` is the split assembled as one set.

1. **Painted, for creatures** — c5's grammar. Richer surface, more internal
   detail, best-in-test on `wolf_01` and `bear`. cfg 2.5.
2. **Flat cel, for items** — c4's grammar. Crisper edges and cleaner reads at
   small size; `health_potion`, `copper_coin` and `iridescent_shard` are close
   to shippable. cfg 2.0.

They differ only in grammar and CFG, so this is one pipeline with a per-kind
switch, not two.

### The ComfyUI parameter set

Settled across all five cycles. Put these in the workflow:

| node | setting | value | why |
|---|---|---|---|
| CheckpointLoaderSimple | `ckpt_name` | `dreamshaperXL_lightningDPMSDE` | 82s vs 143s **and** better art |
| KSampler | `steps` | 8 | distilled; 24 buys nothing |
| KSampler | `cfg` | 2.0 items / 2.5 creatures | c3 proved high CFG speckles and muddies |
| KSampler | `sampler_name` | `dpmpp_sde` | pairs with the distilled checkpoint |
| KSampler | `scheduler` | `sgm_uniform` | required; `normal` returns noise at 8 steps |
| EmptyLatentImage | size | 768² or 832x1216 | both fine — portrait proven safe by the probe |
| LoraLoader | `strength` | 1.0 | 1.15 (c3) added nothing once CFG was sane |
| PixelArtDetectorToImage | `reduce_palette` / `max_colors` | true / 24 | the real palette is applied in post |

`SPRITE_SIZE` 64 and the ~104x152 raw stay as they are — the node's internal
1:1 downscale is doing the right thing.

### Post-process order (this is the part that was broken)

Every colour decision must come **after** rembg, which is the whole bug:

1. rembg → RGBA
2. **harden alpha** at 128 → exactly 2 alpha values (kills halos)
3. **largest connected component** (one subject; doubles as mis-gen detector)
4. saturation x1.15–1.2, at generation resolution
5. **quantise to `apollo`**, dither off
6. crop to subject bbox
7. **scale to `SCALE[id]`** as a fraction of the frame — not maximise
8. outline in the palette's darkest colour
9. centre on 64x64

### Still open

- `wolf_pelt` and `deer_skin` draw the animal rather than a flat hide. Needs a
  description or grammar fix ("flat folded hide, no head"), not a style change.
- `villager` is plain — acceptable, but a richer description would help.
- Scale classes are hand-authored for 11 subjects. Production needs them for
  all 54 items; derive from the `ItemBase` so they can't drift from game data.
- None of this is promoted. `sprite_baker.py` is untouched; `client/` is
  untouched.
