#!/usr/bin/env python
"""
derive_item_scales.py — write a `scale` onto every entry in items.json.

    ./derive_item_scales.py           # show what it would write
    ./derive_item_scales.py --write   # write it

An item icon has no runtime scale — the client draws it at a fixed size — so
the size hierarchy has to be baked into the art. Without it a copper coin and
a bear hide both fill the frame and the inventory grid reads as uniform mush,
which was the single biggest legibility complaint about the old set.

The value is derived from the item's own ItemBase (`slot`, then `tags`) rather
than hand-authored per id, so a new item gets a sensible size for free and the
numbers cannot drift from the game data. A derived value is only a starting
point though: an explicit `scale` already present in items.json is never
overwritten, so anything that looks wrong can simply be pinned by hand.

Deliberately a tiny hand-rolled YAML reader rather than a pyyaml dependency —
the bases are flat `key: value` with one optional `[a, b]` list, this needs
exactly two of those keys, and the sprites venv does not otherwise carry yaml.
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
BASES = os.path.join(os.path.dirname(HERE), "world", "entities", "items", "bases")

# Checked before tags and slots, against the id.
#
# Tags describe what an item is *made of* or *for*, not how big it is, and for
# trophies those come apart: a claw is tagged `material` like a pelt is, so the
# heuristic sizes a rat's fang the same as a bear hide. The noun in the id is
# the only signal that separates them, and it generalises — any future
# `*_fang` gets this for free, which a hand-written per-id table would not.
BY_NOUN = [
    (r"(claw|fang|tooth|teeth|ear|tail|bone|nut|coin|ring|shard|scrap|gel)$", 0.50),
    (r"(pelt|hide|fur|skin|cloak|robe)$", 0.92),
    (r"(sword|axe|spear|staff|bow|torch|polearm)$", 0.95),
    (r"(scroll|letter|manifest|ledger|map)$", 0.78),
    (r"(pouch|sack|bag|satchel)$", 0.68),   # a pouch of coins is not a coin
]

# Checked in order; first hit wins. Tags beat slots because they are more
# specific — `quest` covers 28 of 54 items and says nothing about physical size,
# while `potion` or `jewelry` says almost everything.
BY_TAG = {
    "jewelry":  0.42,   # ring, amulet, signet
    "trinket":  0.48,
    "potion":   0.60,
    "healing":  0.60,
    "food":     0.62,
    "letter":   0.78,   # folded paper, scroll
    "blade":    0.95,
    "melee":    0.95,
    "staff":    1.00,   # longest thing in the game
    "heavy":    0.92,   # heavy armour
    "light":    0.86,
    "armor":    0.90,
    "material": 0.84,   # pelts, furs, hides — big floppy things
    "trophy":   0.66,   # claws, fangs, ears
    "waste":    0.70,
}
BY_SLOT = {
    "currency":   0.40,  # coins
    "ring":       0.42,
    "amulet":     0.46,
    "consumable": 0.60,
    "helmet":     0.78,
    "gloves":     0.74,
    "boots":      0.76,
    "leggings":   0.88,
    "chest":      0.92,
    "mainhand":   0.95,
    "crafting":   0.72,
    "misc":       0.70,
    "quest":      0.72,
}
FALLBACK = 0.80


def read_base(path: str) -> dict:
    out = {}
    for line in open(path):
        m = re.match(r"^(slot|tags):\s*(.+?)\s*$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if key == "tags":
            out["tags"] = [t.strip() for t in val.strip("[]").split(",") if t.strip()]
        else:
            out["slot"] = val
    return out


def scale_for(item_id: str, base: dict) -> tuple[float, str]:
    for pattern, val in BY_NOUN:
        m = re.search(pattern, item_id)
        if m:
            return val, f"noun:{m.group(1)}"
    for tag in base.get("tags", []):
        if tag in BY_TAG:
            return BY_TAG[tag], f"tag:{tag}"
    slot = base.get("slot")
    if slot in BY_SLOT:
        return BY_SLOT[slot], f"slot:{slot}"
    return FALLBACK, "fallback"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    items = json.load(open(os.path.join(HERE, "items.json")))
    rows, changed = [], 0
    for entry in items:
        if "scale" in entry:
            rows.append((entry["id"], entry["scale"], "already set"))
            continue
        path = os.path.join(BASES, f"{entry['id']}.yaml")
        if os.path.exists(path):
            val, why = scale_for(entry["id"], read_base(path))
        else:
            # Generic placeholder icons (item_sword, item_misc) have no base,
            # but their ids still carry the noun.
            val, why = scale_for(entry["id"], {})
        rows.append((entry["id"], val, why))
        entry["scale"] = val
        changed += 1

    for i, v, why in sorted(rows, key=lambda r: r[1]):
        print(f"  {v:.2f}  {i:26} {why}")
    print(f"\n{changed} entries would gain a scale ({len(items)} total)")

    if args.write:
        with open(os.path.join(HERE, "items.json"), "w") as f:
            json.dump(items, f, indent=2)
            f.write("\n")
        print("written to items.json")


if __name__ == "__main__":
    main()
