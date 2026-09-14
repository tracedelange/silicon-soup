#!/usr/bin/env python3
"""
sprite_baker.py — bake descriptions into pixel-art sprites.

Four kinds of subject, sharing the same ComfyUI + Haiku plumbing (post-
processing diverges — see post_process vs post_process_tile below):

    mob    — 64x64 full-figure creature/character sprites (default)
    item   — 64x64 single-object inventory icons (potion, sword, claw, scroll)
    tile   — 64x64 edge-to-edge ground-texture variants (grass, sand, rock, ...)
    fringe — 64x64 edge-to-edge swatch of how ONE material looks at its rim

Usage:
    python sprite_baker.py mobs.json                  # bake all mobs
    python sprite_baker.py mobs.json skeleton         # bake one mob by id
    python sprite_baker.py --kind item items.json     # bake all item icons
    python sprite_baker.py --kind item items.json health_potion
    python sprite_baker.py --kind tile tiles.json     # bake all tile variants
    python sprite_baker.py --kind tile tiles.json grass_0
    python sprite_baker.py --kind fringe fringes.json # bake all material rims
    python sprite_baker.py --kind item items.json --force

Add --force to re-bake even if the description is unchanged.

mob icons   land in  sprites/out/<id>.png            (packed into an atlas by pack_atlas.py)
item icons  land in  client/public/sprites/<id>.png  (loaded directly by the client)
tile icons  land in  client/public/tiles/<id>.png    (id is "<tileId>_<n>", loaded directly)
fringe tiles land in client/public/tiles/<id>.png    (id is "<tileId>_fringe")

On fringes: autotiling needs a material to look different where it meets
another material than it does in open ground — a turf lip, a sand drift, a
scree edge. It does NOT need 16 baked pieces per material. The alpha shape of
each of the 16 corner cases is exact procedural geometry (bilinear
interpolation of the four corner bits, thresholded at 0.5, which puts the
boundary through the midpoint of every cell edge whose corners differ — the
dual-grid contract), so the renderer composites it at runtime. Diffusion
cannot hold pixel-exact edge geometry across 16 pieces and would produce a
set that does not compose; it is very good at "what does grass look like at
its rim", which is one prompt per material. Keep that split.
"""

import anthropic
import hashlib
import json
import os
import random
import sys
import time

import numpy as np
import requests
from PIL import Image, ImageChops, ImageEnhance, ImageFilter
from rembg import remove as rembg_remove
from scipy import ndimage

COMFY_URL   = "http://localhost:8188"
SPRITE_SIZE = 64

# The palette every mob and item is quantised onto, vendored into the repo
# rather than read out of ComfyUI's custom_nodes so a bake does not depend on
# a path outside it. Chosen by sweeping eight palettes over the same frames
# (sprites/experiments/palette_sweep.png): the vivid 32-colour sets all wreck
# earth tones — a brown bear comes out red, mustard or pink — and an adaptive
# per-image palette gives correct hues but no ramp shared across the set.
PALETTE     = "apollo"
SATURATION  = 1.2

# Fraction of the frame a subject's longest side should fill. Overridable per
# subject via a "scale" key in mobs.json / items.json.
#
# Mobs default to 1.0 — i.e. fill the frame, which is what the old maximise-to-
# 62px behaviour did. Their in-world size is not this sprite's business: the
# client scales an entity by the template's `draw_scale` at draw time
# (client/src/game.ts, authored 0.4–2.4 across world/entities/mobs), and every
# one of those values was tuned against a frame-filling sprite. Shrinking the
# art here too would multiply with it and silently make every mob small.
#
# Items have no such runtime scale — an icon is drawn at a fixed size — so the
# size hierarchy has to live in the art, and their fractions are authored per
# item in items.json (see tools/derive_item_scales.py).
DEFAULT_SCALE = {"mobs": 1.0, "items": 0.8}

HERE        = os.path.dirname(__file__)
CLIENT_SPRITES = os.path.join(HERE, "..", "client", "public", "sprites")
CLIENT_TILES   = os.path.join(HERE, "..", "client", "public", "tiles")

MOB_PROMPT_SYSTEM = """\
You translate mob descriptions into SDXL prompts for pixel art game sprites.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- Lead positive with silhouette-defining features (body type, dominant form)
- Always append to positive: painted fantasy game sprite, rich saturated
  colour, warm key light and cool bounce light, clear dark outline, chunky
  simplified forms, bold readable silhouette, full body, full figure, centered,
  single creature, isolated subject, one single pose, single viewpoint
- For four-legged animals, specify a side profile view (a clear standing
  silhouette); for humanoids and bipeds, a front view facing the viewer
- Always include in negative: blurry, 3d render, photorealistic, multiple
  poses, character sheet, model sheet, reference sheet, turnaround, character
  turnaround, multiple views, multiple angles, side-by-side, T-pose,
  text, watermark, anime, portrait,
  cropped, cut off, partial body, close-up, headshot, detailed, fine detail,
  smooth shading, anti-aliased, realistic texture, multiple creatures,
  duplicate, duplicated, mirror, mirrored, two figures, two creatures,
  two animals, second creature, extra creature, extra subject, multiple
  subjects, group, pair, cloned, clone, repeated subject, collage,
  soft edges, noisy, muddy colors
- Keep positive under 75 tokens
- Describe visually only — no lore proper nouns
- For animals and creatures with thin features (legs, beaks, necks), simplify
  them to bold blocky shapes — describe as "stocky" or "chunky" in the prompt
"""

ITEM_PROMPT_SYSTEM = """\
You translate item descriptions into SDXL prompts for pixel-art game inventory icons.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- The subject is a SINGLE inanimate object or trophy (a potion, a sword, a claw,
  a scroll, a gem) shown as an inventory icon — never a creature, person, or scene
- Lead positive with the object's defining shape and material
- Always append to positive: game item icon, inventory icon, flat cel-shaded
  pixel art, two-tone shading, hard value steps, no gradients, thick black
  outline, high chroma, saturated local colour, strong rim light, bold
  readable silhouette, single object, centered, plain background, isolated
  subject
- Always include in negative: creature, animal, person, character, face, hands,
  full body, scene, landscape, background scenery, multiple objects, duplicate,
  blurry, 3d render, photorealistic, text, watermark, anime, soft edges,
  smooth shading, anti-aliased, drop shadow, gradient background
- Keep positive under 60 tokens
- Describe visually only — no lore proper nouns
"""

TILE_PROMPT_SYSTEM = """\
You translate ground-texture descriptions into SDXL prompts for pixel-art game
tile textures.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- The subject is a top-down ground texture swatch (grass, sand, stone, dirt,
  snow, etc.) that fills the ENTIRE frame edge-to-edge — there is no isolated
  object, no creature, and nothing to separate from a background, because the
  whole image IS the ground
- This texture will be tiled edge-to-edge across a huge continuous field and
  viewed zoomed out, so it must read as CALM at a distance: low contrast,
  muted/desaturated color, soft blended color variation, no dense speckle or
  dot patterns, no bold high-contrast detail. Any accent (a fleck, a pebble,
  a flower) must be sparse, small, and low-contrast against the base color —
  never a dense repeating scatter
- Always append to positive: seamless tileable texture, top-down view, flat
  even lighting, no shadows, no vignette, no border, fills entire frame,
  edge-to-edge, soft muted color, low contrast, smooth color blending, subtle
  texture, pixel art, 16-bit RPG tileset, limited color palette
- Always include in negative: object, item, character, creature, person,
  isolated subject, vignette, border, frame, drop shadow, perspective angle,
  3d render, photorealistic, text, watermark, gradient, high contrast, bold
  outline, chunky pixels, dense speckle pattern, dot pattern, busy detail,
  noisy texture, checkerboard pattern, moire pattern
- Keep positive under 60 tokens
- Describe visually only — no lore proper nouns
"""

FRINGE_PROMPT_SYSTEM = """\
You translate ground-material rim descriptions into SDXL prompts for pixel-art
game tile textures.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- The subject is a top-down ground texture swatch that fills the ENTIRE frame
  edge-to-edge, exactly like a normal ground tile — there is no isolated
  object and nothing to separate from a background
- What makes it a *fringe* is that it shows the material as it looks at the
  rim where it meets other ground: denser, a shade darker or paler, gathered
  or piled. It is NOT a picture of a border, an edge, or two materials
  meeting — the renderer supplies the boundary shape and samples this swatch
  inside it. Never depict a line, a transition, or a second material
- It sits directly against the same material's open-ground tile, so it must
  read as the SAME material, only shifted — a small tonal step, never a
  different color
- Same calm-at-a-distance rules as open ground: low contrast, muted color,
  soft blended variation, no dense speckle or dot patterns
- Always append to positive: seamless tileable texture, top-down view, flat
  even lighting, no shadows, no vignette, no border, fills entire frame,
  edge-to-edge, soft muted color, low contrast, smooth color blending, subtle
  texture, pixel art, 16-bit RPG tileset, limited color palette
- Always include in negative: object, item, character, creature, person,
  isolated subject, two materials, boundary line, transition, edge, seam,
  border, frame, vignette, drop shadow, perspective angle, 3d render,
  photorealistic, text, watermark, gradient, high contrast, bold outline,
  chunky pixels, dense speckle pattern, dot pattern, busy detail, noisy
  texture, checkerboard pattern, moire pattern
- Keep positive under 60 tokens
- Describe visually only — no lore proper nouns
"""


# Per-kind config. `out` is where the finished PNGs land; `manifest` is the
# hash-skip cache (kept out of any web-served dir). `section` names the entry
# bucket inside the manifest so kinds never collide. `post_process` is filled
# in below (needs functions defined further down the file) — see
# _register_post_processors.
KINDS = {
    # cfg 2.5 vs the item side's 2.0: the painted creature grammar wants a
    # little more guidance to hold surface detail, where items read cleaner
    # flatter. Both are far below the old default of 7 — see the tile entry.
    "mob": {
        "out":      os.path.join(HERE, "out"),
        "manifest": os.path.join(HERE, "out", "manifest.json"),
        "system":   MOB_PROMPT_SYSTEM,
        "section":  "mobs",
        "singleton": "one single full-body creature, solo character portrait",
        "cfg":       2.5,
    },
    "item": {
        "out":      CLIENT_SPRITES,
        "manifest": os.path.join(HERE, "items_manifest.json"),
        "system":   ITEM_PROMPT_SYSTEM,
        "section":  "items",
        "singleton": "exactly one object",
        "cfg":       2.0,
    },
    "tile": {
        "out":      CLIENT_TILES,
        "manifest": os.path.join(HERE, "tiles_manifest.json"),
        "system":   TILE_PROMPT_SYSTEM,
        "section":  "tiles",
        # Graph overrides (see inject_prompt) — the shared workflow's hard
        # 20-color palette reduction bands visibly on subtle, near-monochrome
        # ground textures (e.g. snow); disable it entirely for tiles. Soften
        # the pixel-art LoRA (full strength reads as "chunky blocky" — right
        # for a creature silhouette, wrong for a texture swatch). Generate
        # square (SDXL's native 1024) instead of the mob/item portrait aspect,
        # since post_process_tile's resize to a square would otherwise
        # non-uniformly stretch a portrait source.
        "lora_strength":      0.55,
        "palette_max_colors": None,
        "latent_size":        (1024, 1024),
        # Pinned to the pre-Lightning generation settings. workflow.json now
        # defaults to the distilled checkpoint at 8 steps / cfg 2.0, which was
        # measured on creatures and items only; nobody has checked what it does
        # to a seamless ground texture, and a bad tile is visible across the
        # whole map. Re-test before adopting it here.
        "checkpoint": "sd_xl_base_1.0.safetensors",
        "steps":      24,
        "cfg":        7.0,
        "sampler":    "euler_ancestral",
        "scheduler":  "normal",
    },
    # A fringe IS a ground texture — same full-frame swatch, same graph
    # overrides, same post-processing. Only the prompt system and the manifest
    # bucket differ, so it deliberately shares tile's config rather than
    # forking a near-identical copy.
    "fringe": {
        "out":      CLIENT_TILES,
        "manifest": os.path.join(HERE, "fringes_manifest.json"),
        "system":   FRINGE_PROMPT_SYSTEM,
        "section":  "fringes",
        "lora_strength":      0.55,
        "palette_max_colors": None,
        "latent_size":        (1024, 1024),
        # Pinned to the pre-Lightning generation settings. workflow.json now
        # defaults to the distilled checkpoint at 8 steps / cfg 2.0, which was
        # measured on creatures and items only; nobody has checked what it does
        # to a seamless ground texture, and a bad tile is visible across the
        # whole map. Re-test before adopting it here.
        "checkpoint": "sd_xl_base_1.0.safetensors",
        "steps":      24,
        "cfg":        7.0,
        "sampler":    "euler_ancestral",
        "scheduler":  "normal",
    },
}


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

# Compositional facts SDXL gets wrong unless they are asserted positively.
#
# "How many of these are there" is the big one: `character sheet, multiple
# views, multiple subjects, duplicate` all sat in the mob negative for months
# and mobs still came back as six scattered figures. Restating the count as a
# positive clause fixed it outright — verified by re-baking the two worst
# offenders (sprites/experiments/probe_portrait). The aspect ratio, long
# suspected, turned out to be irrelevant.
#
# The frame terms are the other half: asking for "plain background" while also
# demanding the subject fill the frame is contradictory, and the model resolves
# it by painting a background panel — a copper coin came back mounted on a
# square plaque, which rembg then cut out as the subject. "fills frame" is gone
# from both grammars now that scale is handled in post_process.
ANTI_FRAME_NEG = ("frame, border, plaque, panel, card, inset, ornate surround, "
                  "background plate, vignette")


def enforce_composition(prompt: dict, singleton: str | None) -> dict:
    if not singleton:
        return prompt
    return {"positive": f"{prompt['positive']}, {singleton}",
            "negative":  f"{prompt['negative']}, {ANTI_FRAME_NEG}"}


def build_prompt(subject: dict, system: str, singleton: str | None = None) -> dict:
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=600,
        system=system,
        messages=[{"role": "user", "content": subject["description"]}],
    )
    raw = msg.content[0].text if msg.content else ""
    # strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    return enforce_composition(json.loads(raw), singleton)


# ---------------------------------------------------------------------------
# ComfyUI interaction
# ---------------------------------------------------------------------------

def load_workflow() -> dict:
    wf_path = os.path.join(HERE, "workflow.json")
    with open(wf_path) as f:
        return json.load(f)


def inject_prompt(workflow: dict, prompt: dict, cfg: dict | None = None) -> dict:
    """
    Find CLIPTextEncode nodes by their _meta title and inject pos/neg text.
    Titles must be 'positive' and 'negative' in the exported workflow JSON.

    `cfg` (see KINDS) may carry per-kind graph overrides — the workflow is
    shared across mob/item/tile, but a hard 20-color palette reduction and a
    full-strength pixel-art LoRA (both tuned for punchy creature/item
    silhouettes) produce visible banding on subtle, near-monochrome ground
    textures. Overrides are opt-in per key so mob/item behavior is unchanged
    unless a kind explicitly sets one.
    """
    cfg = cfg or {}
    wf = json.loads(json.dumps(workflow))  # deep copy
    for node in wf.values():
        title = node.get("_meta", {}).get("title", "").lower()
        class_type = node.get("class_type")
        if title == "positive" and class_type == "CLIPTextEncode":
            node["inputs"]["text"] = prompt["positive"]
        elif title == "negative" and class_type == "CLIPTextEncode":
            node["inputs"]["text"] = prompt["negative"]
        # Randomize the seed each bake — a fixed seed locks the composition
        # (notably the two-figure "character sheet" layout) across re-runs.
        elif class_type == "KSampler":
            node["inputs"]["seed"] = random.randint(0, 2**63 - 1)
            for key in ("steps", "cfg"):
                if cfg.get(key) is not None:
                    node["inputs"][key] = cfg[key]
            if cfg.get("sampler"):
                node["inputs"]["sampler_name"] = cfg["sampler"]
            # Distilled checkpoints need sgm_uniform; on 'normal' an 8-step run
            # comes back as noise, so this pairs with any checkpoint override.
            if cfg.get("scheduler"):
                node["inputs"]["scheduler"] = cfg["scheduler"]
        elif class_type == "CheckpointLoaderSimple" and cfg.get("checkpoint"):
            node["inputs"]["ckpt_name"] = cfg["checkpoint"]
        elif class_type == "LoraLoader" and cfg.get("lora_strength") is not None:
            node["inputs"]["strength_model"] = cfg["lora_strength"]
            node["inputs"]["strength_clip"] = cfg["lora_strength"]
        elif class_type == "EmptyLatentImage" and cfg.get("latent_size"):
            node["inputs"]["width"], node["inputs"]["height"] = cfg["latent_size"]
        elif class_type == "PixelArtDetectorToImage" and "palette_max_colors" in cfg:
            if cfg["palette_max_colors"] is None:
                node["inputs"]["reduce_palette"] = False
            else:
                node["inputs"]["reduce_palette_max_colors"] = cfg["palette_max_colors"]
    return wf


def submit_to_comfy(workflow: dict) -> str:
    r = requests.post(f"{COMFY_URL}/prompt", json={"prompt": workflow}, timeout=10)
    r.raise_for_status()
    return r.json()["prompt_id"]


def _queue_position(prompt_id: str) -> str:
    """Best-effort human-readable status from /queue, for progress logging.
    Never raises — this is diagnostic output, not load-bearing."""
    try:
        q = requests.get(f"{COMFY_URL}/queue", timeout=10).json()
    except Exception:
        return "queue status unavailable"
    for _, pid, *_ in q.get("queue_running", []):
        if pid == prompt_id:
            return "running"
    for i, (_, pid, *_) in enumerate(q.get("queue_pending", [])):
        if pid == prompt_id:
            return f"queued (position {i + 1})"
    return "not in queue or history yet"


def poll_comfy(prompt_id: str, timeout: int = 600) -> dict:
    """Return the first output image dict (filename, subfolder, type), polling until done.

    Checks the history entry's `status` on every poll so a workflow that
    ComfyUI itself failed (a bad node input, an OOM, etc.) raises immediately
    with ComfyUI's own error message instead of silently eating the full
    timeout. Also logs periodic progress (queue position / running) so a long
    wait — e.g. a cold-start model load on the very first bake — is visible
    rather than looking hung.
    """
    start = time.time()
    deadline = start + timeout
    last_log = 0.0
    while time.time() < deadline:
        resp = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=10).json()
        if prompt_id in resp:
            entry = resp[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                messages = status.get("messages", [])
                raise RuntimeError(f"ComfyUI reported an error for {prompt_id}: {messages}")
            outputs = entry.get("outputs", {})
            for node_out in outputs.values():
                images = node_out.get("images")
                if images:
                    return images[0]
            if status.get("completed"):
                raise RuntimeError(
                    f"No image output found for prompt {prompt_id} "
                    f"(ComfyUI reported the workflow completed, but no node produced an image)"
                )
        elapsed = time.time() - start
        if elapsed - last_log >= 15:
            last_log = elapsed
            print(f"  ...still waiting ({int(elapsed)}s elapsed) — {_queue_position(prompt_id)}")
        time.sleep(1)
    raise TimeoutError(f"ComfyUI did not finish prompt {prompt_id} within {timeout}s")


def fetch_comfy_image(image_info: dict) -> Image.Image:
    """Download an image from ComfyUI's /view endpoint."""
    params = {
        "filename": image_info["filename"],
        "subfolder": image_info.get("subfolder", ""),
        "type": image_info.get("type", "output"),
    }
    resp = requests.get(f"{COMFY_URL}/view", params=params, timeout=30)
    resp.raise_for_status()
    from io import BytesIO
    return Image.open(BytesIO(resp.content))


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def remove_background(img: Image.Image) -> Image.Image:
    return rembg_remove(img)


_PALETTE_CACHE: dict[str, Image.Image] = {}


def load_palette(name: str = PALETTE) -> Image.Image:
    """Load a palette swatch PNG (one pixel per colour) for Image.quantize."""
    if name not in _PALETTE_CACHE:
        path = os.path.join(HERE, "palettes", f"{name}.png")
        px = np.array(Image.open(path).convert("RGB")).reshape(-1, 3).tolist()
        colors = list(dict.fromkeys(map(tuple, px)))  # de-dup, keep ramp order
        pal = Image.new("P", (1, 1))
        flat = [c for rgb in colors for c in rgb]
        pal.putpalette(flat + [0] * (768 - len(flat)))
        pal.info["colors"] = colors
        _PALETTE_CACHE[name] = pal
    return _PALETTE_CACHE[name]


def outline_color() -> tuple[int, int, int, int]:
    """The palette's darkest colour, so the outline belongs to the same ramp as
    the fill rather than fighting it as a foreign near-black."""
    colors = load_palette().info["colors"]
    r, g, b = min(colors, key=lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
    return (r, g, b, 255)


def add_outline(img: Image.Image, thickness: int = 1) -> Image.Image:
    alpha   = img.split()[3]
    mask    = alpha.point(lambda a: 255 if a > 128 else 0)
    dilated = mask.filter(ImageFilter.MaxFilter(2 * thickness + 1))
    edge    = ImageChops.subtract(dilated, mask)  # ring just outside the shape

    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, outline_color()), (0, 0), edge)
    out.paste(img, (0, 0), img)  # subject on top, keeping its interior
    return out


def post_process(img: Image.Image, sprite_id: str, out_dir: str,
                 scale: float | None = None, section: str = "items") -> str:
    """Raw ComfyUI frame → finished 64px sprite. Returns output path.

    The ordering here is load-bearing, and getting it wrong is what made every
    sprite baked before Sept 2026 look like a filtered photo rather than pixel
    art.

    `remove_background` is rembg, a photo-matting model. Measured on a clean
    21-colour input it returns **465 colours and a 250-value soft alpha**. So
    the 20-colour reduction the ComfyUI graph already did does not survive this
    step, and an earlier version of this function assumed it did — it said the
    image "arrives already palette-reduced, so no quantize is needed here",
    which was true on arrival and false by the time it was saved. Hence the
    halos, the 100+ colour sprites, and the module-level PALETTE_N that nothing
    referenced.

    Every colour and geometry decision therefore happens *after* matting.
    """
    rgba = remove_background(img.convert("RGB"))

    # 1. Harden the matte. A pixel is in or out; partial alpha is what reads as
    #    a halo once the sprite sits on a tile background.
    a = np.array(rgba)
    hard = a[..., 3] >= 128
    if not hard.any():
        raise ValueError(f"{sprite_id}: nothing survived background removal")

    # 2. One subject. rembg keeps every blob it reads as foreground, so a coin
    #    arrives with a stray lump beside it and a mis-composed character sheet
    #    arrives as six figures that then scale down together into confetti.
    lbl, n = ndimage.label(hard)
    if n > 1:
        sizes = ndimage.sum(hard, lbl, range(1, n + 1))
        hard = lbl == int(np.argmax(sizes)) + 1
        if sizes.max() / sizes.sum() < 0.5:
            print(f"  WARNING {sprite_id}: largest blob is only "
                  f"{100 * sizes.max() / sizes.sum():.0f}% of the ink — "
                  f"the frame is probably a multi-figure mis-gen")

    # 3. Colour, at generation resolution — lifting saturation after the
    #    downsample only amplifies what the resample averaged together.
    rgb = ImageEnhance.Color(Image.fromarray(a[..., :3])).enhance(SATURATION)

    # 4. Quantise to a fixed authored palette. An adaptive per-image palette
    #    gives correct hues but no shared ramp, so a set of 90 sprites never
    #    coheres; apollo was chosen over seven alternatives because it is the
    #    only one that keeps earth tones honest (endesga-32 turns a brown bear
    #    red) while still reading as a designed palette.
    rgb = rgb.quantize(palette=load_palette(), dither=Image.NONE).convert("RGB")

    sprite = Image.fromarray(
        np.dstack([np.array(rgb), (hard * 255).astype(np.uint8)]), "RGBA")

    # 5. Crop to the subject before scaling, so the scale class describes the
    #    subject rather than however much empty space the model left around it.
    bb = sprite.getbbox()
    if bb:
        sprite = sprite.crop(bb)

    # 6. Scale to this subject's share of the frame instead of maximising.
    #    Maximising is why a copper coin and a bear hide used to occupy the
    #    same 62px on the inventory grid.
    frac = scale if scale is not None else DEFAULT_SCALE[section]
    target = max(4, int(round((SPRITE_SIZE - 2) * frac)))
    k = target / max(sprite.size)
    sprite = sprite.resize((max(1, round(sprite.width * k)),
                            max(1, round(sprite.height * k))), Image.NEAREST)

    canvas = Image.new("RGBA", (SPRITE_SIZE, SPRITE_SIZE), (0, 0, 0, 0))
    canvas.paste(sprite, ((SPRITE_SIZE - sprite.width) // 2,
                          (SPRITE_SIZE - sprite.height) // 2))
    canvas = add_outline(canvas)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{sprite_id}.png")
    canvas.save(out_path)
    return out_path


def post_process_tile(img: Image.Image, sprite_id: str, out_dir: str) -> str:
    """Fit a full-frame ground texture to SPRITE_SIZE. Returns output path.

    Deliberately skips remove_background and add_outline: a tile has no
    subject/background split (the whole frame IS the texture), and an outline
    would draw a visible border where tiles butt up against each other.

    Unlike mob/item post_process, this resamples with LANCZOS (not NEAREST)
    and applies a *light* blur + contrast pull-in — enough to take the edge off
    a busy/speckled result, not so much it flattens genuine texture to nothing.
    This is a backstop for imperfect prompt compliance (see TILE_PROMPT_SYSTEM),
    not the primary lever — tune the description text first if a tile looks
    over- or under-textured; only nudge these if backstop values themselves
    are off for every tile.
    """
    img = img.convert("RGB").resize((SPRITE_SIZE, SPRITE_SIZE), Image.LANCZOS)
    img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    img = ImageEnhance.Contrast(img).enhance(0.92)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{sprite_id}.png")
    img.save(out_path)
    return out_path


# Wire up post_process functions now that they're defined (KINDS itself is
# declared earlier, near the prompt systems, so it reads top-to-bottom next to
# the prompts it pairs with).
KINDS["mob"]["post_process"] = post_process
KINDS["item"]["post_process"] = post_process
KINDS["tile"]["post_process"] = post_process_tile
KINDS["fringe"]["post_process"] = post_process_tile


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def load_manifest(path: str, section: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            manifest = json.load(f)
        manifest.setdefault(section, {})
        return manifest
    return {"sprite_size": SPRITE_SIZE, section: {}}


def save_manifest(manifest: dict, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)


def description_hash(subject: dict) -> str:
    return hashlib.sha256(subject["description"].encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Core bake
# ---------------------------------------------------------------------------

def bake(subject: dict, manifest: dict, cfg: dict, force: bool = False) -> bool:
    """Bake one subject. Returns True if a new sprite was generated."""
    section  = cfg["section"]
    sub_id   = subject["id"]
    new_hash = description_hash(subject)

    existing = manifest[section].get(sub_id, {})
    if not force and existing.get("hash") == new_hash:
        print(f"  skip {sub_id} (unchanged)")
        return False

    print(f"  building prompt for {sub_id}...")
    prompt = build_prompt(subject, cfg["system"], cfg.get("singleton"))
    print(f"  positive: {prompt['positive']}")
    print(f"  negative: {prompt['negative']}")

    print(f"  submitting to ComfyUI...")
    workflow  = load_workflow()
    wf        = inject_prompt(workflow, prompt, cfg)
    prompt_id = submit_to_comfy(wf)

    print(f"  waiting for {prompt_id}...")
    image_info = poll_comfy(prompt_id)

    print(f"  downloading {image_info['filename']}...")
    img = fetch_comfy_image(image_info)

    print(f"  post-processing...")
    # Only mob/item post_process takes a scale class; a tile is the whole frame
    # by definition, so post_process_tile has nothing to scale within it.
    if cfg.get("singleton"):
        out_path = cfg["post_process"](img, sub_id, cfg["out"],
                                       subject.get("scale"), section)
    else:
        out_path = cfg["post_process"](img, sub_id, cfg["out"])

    manifest[section][sub_id] = {
        "hash":   new_hash,
        "prompt": prompt,
        "sprite": os.path.relpath(out_path, os.path.dirname(cfg["manifest"])),
    }

    print(f"  done → {out_path}")
    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    force = "--force" in args
    args = [a for a in args if a != "--force"]

    kind = "mob"
    if "--kind" in args:
        i = args.index("--kind")
        kind = args[i + 1]
        del args[i:i + 2]

    if kind not in KINDS:
        print(f"Unknown kind '{kind}'. Choose one of: {', '.join(KINDS)}")
        sys.exit(1)
    cfg = KINDS[kind]

    if not args:
        print("Missing input JSON path.")
        sys.exit(1)

    subjects_path = args[0]
    filter_id = args[1] if len(args) > 1 else None

    with open(subjects_path) as f:
        subjects = json.load(f)

    if filter_id:
        subjects = [s for s in subjects if s["id"] == filter_id]
        if not subjects:
            print(f"No {kind} with id '{filter_id}' found.")
            sys.exit(1)

    manifest = load_manifest(cfg["manifest"], cfg["section"])

    baked = 0
    for subject in subjects:
        print(f"[{subject['id']}]")
        if bake(subject, manifest, cfg, force=force):
            baked += 1
            save_manifest(manifest, cfg["manifest"])  # save after each so partial runs aren't lost

    print(f"\nDone. {baked}/{len(subjects)} {kind} sprites (re)baked.")


if __name__ == "__main__":
    main()
