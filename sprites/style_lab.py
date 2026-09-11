#!/usr/bin/env python
"""
style_lab.py — art-direction experiments over a fixed subject set.

The production baker answers "make art for this subject". This answers a
different question: "which pipeline settings make art we actually like?" So it
holds the subjects constant and varies the style, which is the opposite of
sprite_baker.py and why it lives beside it rather than inside it.

    ./style_lab.py bake   <style>        # generate + post-process a cycle
    ./style_lab.py repost <style>        # re-post-process from saved raws (no GPU)
    ./style_lab.py sheet  <style> [...]  # contact sheet(s)
    ./style_lab.py list                  # styles and what each one is testing

Nothing here writes to client/. Output lands in sprites/experiments/<style>/ and
stays there until a style is chosen and promoted by hand.

Two properties matter for iterating at a sane pace:

  * The raw ComfyUI frame is saved before any post-processing. Palette, scale
    and outline are all post-process levers, so `repost` re-renders a whole
    cycle in about a second instead of re-queueing the GPU. Only the generation
    axis (checkpoint, steps, resolution, prompt) needs `bake`.

  * Prompts are cached per (subject, grammar) in prompts_cache.json. Haiku is
    cheap but not free, and a prompt that changes under you makes two cycles
    incomparable — which defeats the whole point of holding subjects constant.
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageChops
from scipy import ndimage

import sprite_baker as sb

HERE = os.path.dirname(os.path.abspath(__file__))
EXP_DIR = os.path.join(HERE, "experiments")
PALETTE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(HERE)),
    "ComfyUI", "custom_nodes", "ComfyUI-PixelArt-Detector", "palettes", "1x",
)
PROMPT_CACHE = os.path.join(EXP_DIR, "prompts_cache.json")
SPRITE_SIZE = 64


# ---------------------------------------------------------------------------
# Subjects — held constant across every cycle
# ---------------------------------------------------------------------------
# Chosen to stress different failure modes rather than to look good: a
# quadruped that currently reads as a photo, an amorphous blob that is nothing
# but colour, a plain humanoid that shows palette dullness with no saturated
# props to hide behind, and the multi-figure composition bug. Items cover the
# full scale range, because uniform scaling is the thing being fixed.

SUBJECTS = [
    ("mob",  "bear"),              # quadruped; worst "diffusion under a filter" case
    ("mob",  "wolf_01"),           # quadruped, washed out and low-contrast today
    ("mob",  "goblin_shaman_01"),  # humanoid with saturated props
    ("mob",  "acid_ooze_01"),      # no silhouette landmarks; pure colour read
    ("mob",  "villager"),          # plain humanoid; nowhere for dull palette to hide
    ("mob",  "armorer_01"),        # currently returns three figures in one frame
    ("item", "health_potion"),     # small, hard-edged, glassy
    ("item", "copper_coin"),       # smallest thing in the game; scale-class canary
    ("item", "wolf_pelt"),         # large soft organic; currently painterly mush
    ("item", "iridescent_shard"),  # saturated + translucent; palette stress test
    ("item", "deer_skin"),         # one of six items that read as the same rectangle
]

# Fraction of the 64px frame a subject's longest side should occupy. The
# production baker maximises everything to 62px, which is why a coin and a bear
# hide are the same size on the inventory grid. A coin is not a hide.
SCALE = {
    "copper_coin":       0.42,
    "health_potion":     0.62,
    "iridescent_shard":  0.66,
    "deer_skin":         0.92,
    "wolf_pelt":         0.95,
    "bear":              1.00,
    "wolf_01":           0.92,
    "goblin_shaman_01":  0.86,
    "villager":          0.84,
    "armorer_01":        0.84,
    "acid_ooze_01":      0.74,
}
DEFAULT_SCALE = 0.85


# ---------------------------------------------------------------------------
# Prompt grammars
# ---------------------------------------------------------------------------
# The production grammars ask for "pixel art" and get a diffusion render that
# is later downsampled. These push for the things that survive a downsample:
# flat areas, hard value steps, a strong silhouette, saturated local colour.

GRAMMAR_FLAT = """\
- Always append to positive: flat cel-shaded pixel art, two-tone shading, hard
  value steps, no gradients, thick black outline, high chroma, saturated local
  colour, strong rim light, bold readable silhouette, single subject, centered,
  plain background
- Always include in negative: gradient, soft shading, airbrush, ambient
  occlusion, muted, desaturated, greyish, washed out, photorealistic, 3d render,
  depth of field, blurry, multiple subjects, character sheet, turnaround, text,
  watermark, drop shadow, scene, background scenery
"""

GRAMMAR_STORYBOOK = """\
- Always append to positive: painted fantasy game sprite, rich saturated colour,
  warm key light and cool bounce light, clear dark outline, chunky simplified
  forms, bold silhouette, single subject, centered, plain background
- Always include in negative: muted, desaturated, grey, washed out, flat
  lighting, photorealistic, 3d render, blurry, multiple subjects, character
  sheet, turnaround, text, watermark, scene, background scenery
"""


def _grammar_system(base: str, extra: str) -> str:
    """Splice an art-direction block into a production prompt system.

    Keeps the subject rules (single object, no lore nouns, token budget) and
    replaces only the style clause, so a cycle tests art direction rather than
    accidentally also testing a different idea of what the subject is.
    """
    head = base.split("- Always append to positive:")[0].rstrip()
    tail = "- Keep positive under 70 tokens\n- Describe visually only — no lore proper nouns\n"
    return f"{head}\n{extra}{tail}"


# ---------------------------------------------------------------------------
# Styles — one per cycle
# ---------------------------------------------------------------------------
# `gen` keys change what the GPU produces and need a `bake`.
# `post` keys are free to change and only need a `repost`.

STYLES = {
    # Not a style — an isolation probe. c3/c4/c5 changed the latent to square
    # AND started asserting the subject count positively, so neither explains
    # the multi-figure fix on its own. This is c4 with the portrait latent put
    # back: if villager and armorer_01 still come back as single figures, the
    # aspect ratio was never the cause and SINGLETON_POS is doing the work,
    # which means portrait latents stay available for tall subjects.
    "probe_portrait": {
        "what": "c4 settings with the 832x1216 portrait latent restored — "
                "isolates aspect ratio from the singleton prompt.",
        "gen": {"checkpoint": "dreamshaperXL_lightningDPMSDE.safetensors",
                "steps": 8, "cfg": 2.0, "sampler": "dpmpp_sde",
                "scheduler": "sgm_uniform",
                "latent_size": (832, 1216), "grammar": GRAMMAR_FLAT,
                "palette_max_colors": 24},
        "post": {"palette": "apollo", "saturation": 1.2, "outline": "palette"},
    },
    "c1_control": {
        "what": "Production settings + the post-process bug fixed. The baseline "
                "every other cycle is measured against.",
        "gen": {},
        "post": {"palette": None, "colors": 20, "saturation": 1.0, "outline": "dark"},
    },
    "c2_palette": {
        "what": "Same frames as c1, mapped onto a designed 32-colour palette "
                "with a saturation lift. Isolates 'is dullness a palette problem'.",
        # Literally the same frames, not merely the same settings: reusing c1's
        # raws makes this a controlled A/B on colour alone, and costs no GPU.
        "reuse_raw": "c1_control",
        "gen": {},
        "post": {"palette": "endesga-32", "saturation": 1.35, "outline": "palette"},
    },
    "c3_chunky": {
        "what": "Generate at 768x768 instead of 832x1216 and push CFG, so the "
                "downsample ratio drops and shapes survive as deliberate pixels.",
        "gen": {"latent_size": (768, 768), "cfg": 9.5, "steps": 30,
                "lora_strength": 1.15, "palette_max_colors": 24},
        "post": {"palette": "apollo", "saturation": 1.2, "outline": "palette"},
    },
    "c4_flatcel": {
        "what": "Flat cel-shading grammar on the Lightning checkpoint: hard "
                "value steps and rim light instead of rendered volume.",
        "gen": {"checkpoint": "dreamshaperXL_lightningDPMSDE.safetensors",
                "steps": 8, "cfg": 2.0, "sampler": "dpmpp_sde", "scheduler": "sgm_uniform",
                "latent_size": (768, 768), "grammar": GRAMMAR_FLAT,
                "palette_max_colors": 24},
        "post": {"palette": "apollo", "saturation": 1.2, "outline": "palette"},
    },
    "c5_painted": {
        "what": "Richer painted read on a warmer 36-colour ramp — the counter-"
                "proposal to c4 in case flat cel reads as too cheap.",
        "gen": {"checkpoint": "dreamshaperXL_lightningDPMSDE.safetensors",
                "steps": 8, "cfg": 2.5, "sampler": "dpmpp_sde", "scheduler": "sgm_uniform",
                "latent_size": (768, 768), "grammar": GRAMMAR_STORYBOOK,
                "palette_max_colors": 32},
        "post": {"palette": "apollo", "saturation": 1.15, "outline": "palette"},
    },
}


# ---------------------------------------------------------------------------
# Palettes
# ---------------------------------------------------------------------------

def load_palette(name: str) -> Image.Image:
    """Load a 1x palette swatch as a Pillow palette image for quantize()."""
    path = os.path.join(PALETTE_DIR, f"{name}-1x.png")
    if not os.path.exists(path):
        raise SystemExit(f"no palette {name} at {path}")
    sw = Image.open(path).convert("RGB")
    colors = list(dict.fromkeys(sw.getdata()))  # de-dup, keep order
    pal = Image.new("P", (1, 1))
    flat = [c for rgb in colors for c in rgb]
    flat += [0] * (768 - len(flat))
    pal.putpalette(flat)
    pal.info["n_colors"] = len(colors)
    return pal


# ---------------------------------------------------------------------------
# Post-process
# ---------------------------------------------------------------------------

def post(img: Image.Image, subject_id: str, opts: dict) -> Image.Image:
    """Raw ComfyUI frame -> finished 64px sprite.

    Ordering is the whole point of this function. rembg is a photo-matting
    model: it rewrites RGB and emits a 250-value soft matte, which is what
    turns a clean 20-colour frame into a 100+ colour one with halos. So every
    colour decision has to happen AFTER it, not before — the palette reduction
    the ComfyUI graph already did does not survive this step.
    """
    rgba = sb.remove_background(img.convert("RGB"))

    # 1. Harden the matte first. A pixel is in or out; partial alpha is what
    #    reads as a halo once the sprite sits on a tile background.
    a = np.array(rgba)
    hard = (a[..., 3] >= 128)
    if not hard.any():
        return None  # nothing survived the cut; caller treats as a mis-gen

    # An inventory icon is one thing. rembg happily keeps every blob it thinks
    # is foreground, so copper_coin came back as the coin plus a stray lump,
    # and a mis-composed character sheet comes back as six figures that then
    # get scaled down together into unreadable confetti. Keeping only the
    # largest connected component turns both into a single subject — and when
    # it discards more than half the ink, that is itself the signal that the
    # frame was a multi-figure mis-gen rather than a subject with debris.
    if opts.get("keep_largest", True):
        lbl, n = ndimage.label(hard)
        if n > 1:
            sizes = ndimage.sum(hard, lbl, range(1, n + 1))
            keep = int(np.argmax(sizes)) + 1
            kept, total = sizes.max(), sizes.sum()
            hard = (lbl == keep)
            if kept / total < 0.5:
                print(f"      NOTE {subject_id}: largest blob is only "
                      f"{100*kept/total:.0f}% of the ink — likely multi-figure")
    rgb = Image.fromarray(a[..., :3])

    # 2. Colour, while still at generation resolution — boosting after the
    #    downsample just amplifies whatever the resample averaged together.
    if opts.get("saturation", 1.0) != 1.0:
        rgb = ImageEnhance.Color(rgb).enhance(opts["saturation"])

    # 3. Quantise to a real palette. A named palette makes every sprite in the
    #    set share a ramp, which is what makes a set look authored rather than
    #    generated one at a time.
    if opts.get("palette"):
        pal = load_palette(opts["palette"])
        rgb = rgb.quantize(palette=pal, dither=Image.NONE).convert("RGB")
    else:
        rgb = rgb.quantize(colors=opts.get("colors", 20),
                           method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")

    out = np.dstack([np.array(rgb), (hard * 255).astype(np.uint8)])
    sprite = Image.fromarray(out, "RGBA")

    # 4. Crop to the subject before scaling, so the scale class describes the
    #    subject and not however much empty space the model left around it.
    bb = sprite.getbbox()
    if bb:
        sprite = sprite.crop(bb)

    # 5. Scale to this subject's share of the frame rather than maximising.
    frac = opts.get("scale", SCALE.get(subject_id, DEFAULT_SCALE))
    target = max(4, int(round((SPRITE_SIZE - 2) * frac)))
    w, h = sprite.size
    k = target / max(w, h)
    sprite = sprite.resize((max(1, round(w * k)), max(1, round(h * k))), Image.NEAREST)

    canvas = Image.new("RGBA", (SPRITE_SIZE, SPRITE_SIZE), (0, 0, 0, 0))
    canvas.paste(sprite, ((SPRITE_SIZE - sprite.width) // 2,
                          (SPRITE_SIZE - sprite.height) // 2))

    if opts.get("outline"):
        canvas = outline(canvas, opts["outline"], opts.get("palette"))
    return canvas


def outline(img: Image.Image, mode: str, palette: str | None) -> Image.Image:
    """Trace the silhouette. 'palette' picks the palette's darkest colour so the
    outline belongs to the same ramp as the fill instead of fighting it."""
    color = (26, 22, 30, 255)
    if mode == "palette" and palette:
        pal = load_palette(palette)
        raw = pal.getpalette()[: pal.info["n_colors"] * 3]
        cols = [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]
        dark = min(cols, key=lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
        color = (*dark, 255)

    alpha = img.split()[3]
    mask = alpha.point(lambda v: 255 if v > 128 else 0)
    ring = ImageChops.subtract(mask.filter(ImageFilter.MaxFilter(3)), mask)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, color), (0, 0), ring)
    out.paste(img, (0, 0), img)
    return out


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def subject_description(kind: str, sid: str) -> str:
    src = "mobs.json" if kind == "mob" else "items.json"
    for e in json.load(open(os.path.join(HERE, src))):
        if e["id"] == sid:
            return e["description"]
    raise SystemExit(f"{sid} not found in {src}")


# Applied to every cycle, because these are defects rather than style choices
# and letting them vary would waste cycles re-discovering them.
#
#   'fills frame' told the model to reach the frame edge, and the cheapest way
#   to satisfy that while also obeying 'plain background' is to paint a
#   background panel — so the first control bake returned a coin mounted on a
#   square plaque, and rembg dutifully cut out the plaque. Scale is a
#   post-process concern now (see SCALE), so the instruction is pure downside.
#
#   The multi-figure 'character sheet' layout is the same class of bug on the
#   mob side: armorer_01 ships as three figures in one frame.
ANTI_FRAME_NEG = ("frame, border, plaque, panel, card, inset, ornate surround, "
                  "background plate, vignette, character sheet, turnaround, "
                  "multiple views, multiple subjects, duplicate")
DROP_FROM_POS = ("fills frame", "fills the frame", "edge-to-edge")


# SDXL weighs a negative far more weakly than a positive for compositional
# facts like "how many of these are there". c1_control's villager came back as
# six scattered figures despite 'character sheet, multiple subjects' sitting in
# the negative, so state the count positively as well.
SINGLETON_POS = {"mob": "one single full-body creature, solo character portrait",
                 "item": "exactly one object"}


def _debug_prompt(p: dict, kind: str) -> dict:
    pos = p["positive"]
    for phrase in DROP_FROM_POS:
        pos = pos.replace(f", {phrase}", "").replace(f"{phrase}, ", "")
    return {"positive": f"{pos}, {SINGLETON_POS[kind]}",
            "negative": f"{p['negative']}, {ANTI_FRAME_NEG}"}


def get_prompt(kind: str, sid: str, grammar: str | None) -> dict:
    base = sb.KINDS[kind]["system"]
    system = _grammar_system(base, grammar) if grammar else base
    # v2 in the key so the anti-frame correction invalidates prompts cached
    # before it existed, rather than silently reusing a framed prompt.
    key = hashlib.sha1(f"v3|{sid}|{system}".encode()).hexdigest()[:16]

    cache = {}
    if os.path.exists(PROMPT_CACHE):
        cache = json.load(open(PROMPT_CACHE))
    if key in cache:
        return cache[key]

    p = _debug_prompt(
        sb.build_prompt({"id": sid, "description": subject_description(kind, sid)}, system),
        kind)
    cache[key] = p
    os.makedirs(EXP_DIR, exist_ok=True)
    json.dump(cache, open(PROMPT_CACHE, "w"), indent=2)
    return p


# ---------------------------------------------------------------------------
# Graph overrides
# ---------------------------------------------------------------------------

def apply_gen(wf: dict, gen: dict) -> dict:
    """Extend sprite_baker's override vocabulary with the axes a style varies.

    sprite_baker.inject_prompt already handles lora_strength / latent_size /
    palette_max_colors; checkpoint, steps, cfg and sampler are new here because
    production never had a reason to vary them.
    """
    for node in wf.values():
        ct = node.get("class_type")
        if ct == "CheckpointLoaderSimple" and gen.get("checkpoint"):
            node["inputs"]["ckpt_name"] = gen["checkpoint"]
        elif ct == "KSampler":
            for k in ("steps", "cfg"):
                if gen.get(k) is not None:
                    node["inputs"][k] = gen[k]
            if gen.get("sampler"):
                node["inputs"]["sampler_name"] = gen["sampler"]
            # Lightning checkpoints are distilled for a handful of steps and
            # need sgm_uniform; on the default 'normal' schedule an 8-step run
            # comes back as noise.
            if gen.get("scheduler"):
                node["inputs"]["scheduler"] = gen["scheduler"]
    return wf


# ---------------------------------------------------------------------------
# Cycles
# ---------------------------------------------------------------------------

def style_dir(style: str) -> str:
    return os.path.join(EXP_DIR, style)


def bake(style: str, only: list[str] | None = None, reseed: bool = False):
    cfg = STYLES[style]
    gen, opts = cfg["gen"], cfg["post"]
    d = style_dir(style)
    raw_d = os.path.join(d, "raw")
    os.makedirs(raw_d, exist_ok=True)
    json.dump(cfg, open(os.path.join(d, "style.json"), "w"), indent=2, default=str)

    todo = [(k, s) for k, s in SUBJECTS if not only or s in only]
    print(f"[{style}] {len(todo)} subjects — {cfg['what']}", flush=True)

    borrow = cfg.get("reuse_raw")
    for n, (kind, sid) in enumerate(todo, 1):
        raw_p = os.path.join(raw_d, f"{sid}.png")
        if borrow and not os.path.exists(raw_p):
            src = os.path.join(style_dir(borrow), "raw", f"{sid}.png")
            if os.path.exists(src):
                Image.open(src).save(raw_p)
        if os.path.exists(raw_p) and not reseed:
            print(f"  ({n}/{len(todo)}) {sid}: raw exists, re-posting only", flush=True)
        else:
            t0 = time.time()
            print(f"  ({n}/{len(todo)}) {sid}: prompting...", flush=True)
            prompt = get_prompt(kind, sid, gen.get("grammar"))
            kcfg = dict(sb.KINDS[kind])
            for k in ("lora_strength", "latent_size", "palette_max_colors"):
                if k in gen:
                    kcfg[k] = gen[k]
            wf = apply_gen(sb.inject_prompt(sb.load_workflow(), prompt, kcfg), gen)
            try:
                pid = sb.submit_to_comfy(wf)
                info = sb.poll_comfy(pid, timeout=900)
                sb.fetch_comfy_image(info).save(raw_p)
            except Exception as exc:  # a dead backend shouldn't lose the cycle
                print(f"      FAILED {sid}: {exc}", flush=True)
                continue
            print(f"      generated in {time.time()-t0:.0f}s", flush=True)

        fin = post(Image.open(raw_p), sid, opts)
        if fin is None:
            print(f"      MIS-GEN {sid}: nothing survived background removal", flush=True)
            continue
        fin.save(os.path.join(d, f"{sid}.png"))

    sheet(style)
    print(f"[{style}] done -> {d}", flush=True)


def repost(style: str):
    """Re-run post-process from saved raws. No GPU, ~1s for a whole cycle."""
    cfg = STYLES[style]
    d = style_dir(style)
    raw_d = os.path.join(d, "raw")
    if not os.path.isdir(raw_d):
        raise SystemExit(f"no raws for {style} — run `bake {style}` first")
    n = 0
    for _, sid in SUBJECTS:
        p = os.path.join(raw_d, f"{sid}.png")
        if not os.path.exists(p):
            continue
        fin = post(Image.open(p), sid, cfg["post"])
        if fin is None:
            print(f"  MIS-GEN {sid}")
            continue
        fin.save(os.path.join(d, f"{sid}.png"))
        n += 1
    json.dump(cfg, open(os.path.join(d, "style.json"), "w"), indent=2, default=str)
    sheet(style)
    print(f"[{style}] re-posted {n} sprites")


def sheet(*styles: str, zoom: int = 3):
    """One row per style, one column per subject, so cycles are compared by
    scanning down a column rather than by flipping between files."""
    from PIL import ImageDraw
    styles = [s for s in (styles or STYLES.keys()) if os.path.isdir(style_dir(s))]
    if not styles:
        return
    ids = [s for _, s in SUBJECTS]
    cell = SPRITE_SIZE * zoom
    pad, lab, hdr = 6, 13, 16
    W = len(ids) * (cell + pad) + pad
    H = hdr + len(styles) * (cell + pad + lab) + pad
    sheet = Image.new("RGB", (W, H), (32, 32, 38))
    d = ImageDraw.Draw(sheet)
    for ci, sid in enumerate(ids):
        d.text((pad + ci * (cell + pad), 3), sid[:18], fill=(235, 235, 245))
    for ri, st in enumerate(styles):
        y = hdr + ri * (cell + pad + lab)
        d.text((pad, y), st, fill=(255, 210, 120))
        for ci, sid in enumerate(ids):
            p = os.path.join(style_dir(st), f"{sid}.png")
            x = pad + ci * (cell + pad)
            box = Image.new("RGBA", (cell, cell), (58, 58, 66, 255))
            if os.path.exists(p):
                box.alpha_composite(Image.open(p).convert("RGBA")
                                    .resize((cell, cell), Image.NEAREST))
            sheet.paste(box.convert("RGB"), (x, y + lab))
    out = os.path.join(EXP_DIR, "compare.png" if len(styles) > 1
                       else f"{styles[0]}/sheet.png")
    sheet.save(out)
    print(f"  sheet -> {out}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["bake", "repost", "sheet", "list"])
    ap.add_argument("style", nargs="*")
    ap.add_argument("--only", nargs="*", help="limit to these subject ids")
    ap.add_argument("--reseed", action="store_true", help="regenerate raws that exist")
    a = ap.parse_args()

    if a.cmd == "list":
        for k, v in STYLES.items():
            mark = "*" if os.path.isdir(style_dir(k)) else " "
            print(f" {mark} {k:14} {v['what']}")
        return
    if a.cmd == "sheet":
        sheet(*a.style)
        return
    for st in a.style:
        if st not in STYLES:
            raise SystemExit(f"unknown style {st}; try `list`")
        (bake if a.cmd == "bake" else repost)(
            st, **({"only": a.only, "reseed": a.reseed} if a.cmd == "bake" else {}))


if __name__ == "__main__":
    main()
