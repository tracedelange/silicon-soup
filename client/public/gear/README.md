# Gear overlays

Grayscale art for the player paper-doll's equipment layers. Composited over the
class body by `shared/playerComposite.ts`.

```bash
npm run sprite-lab   # http://localhost:3005
```

The workbench both previews and **edits** these files: pick an overlay under
*Editing*, draw with the five-gray palette, and every stroke re-composites onto
the character live before anything touches disk. Save writes the PNG back here.
Rotate pivots on the hand rather than the image centre, so an angled blade stays
in the grip; off a quarter turn it's lossy, so it previews until you Apply.
Aseprite still works fine — the format below is the whole contract, and the
workbench picks up an externally-saved file on *Reload from disk*.

## The contract

- **64x64, transparent background.** Full width — anything held in one hand is
  asymmetric, so overlays can't use the left-half mirror trick the bodies do.
- **Five key grays only**, each mapping to the material's ramp stop at the same
  index (darkest first): `#000000` `#404040` `#808080` `#bfbfbf` `#ffffff`.
  Step 0 is the outline, step 4 is specular highlight. Matching is nearest-stop
  by luminance, so a gray that's a few off still lands correctly.
- **No color.** The material's ramp supplies it (`MATERIAL_VISUALS` in
  `shared/itemVisuals.ts`), an elemental brand tints the top two stops, and
  rarity rings the silhouette. Painting in color fights all three.
- **Align to the pose contract** — head rows 3-13, shoulders 14, hands 19-20,
  belt 20-22, feet 29, in the body's 32-row grid (so double for 64px rows).
  `POSE_ANCHORS` in `shared/playerComposite.ts` is the source of truth. The
  workbench draws those bands directly on the editor grid, along with the hand
  columns a grip must land in (derived from the template by `handColumns`, so
  redrawing a body moves the marker with it), and
  `http://localhost:3005/api/pose-guide.png?klass=fighter&scale=1` exports it as
  a reference layer for Aseprite. `keys.gpl` here is the palette.

## Naming

The filename is the whole registration — there is no manifest to update, and a
missing file simply doesn't draw.

| Slot | Filename | Comes from |
|---|---|---|
| mainhand | `<archetype>.png` (`sword`, `maul`, `staff`, …) | the archetype id in `world/entities/items/archetypes.yaml` |
| armor | `helmet.png` `chest.png` `gloves.png` `leggings.png` `boots.png` | the archetype id, which for armor is also the slot |
| armor variant | `<slot>_cloth.png` | the material's `class` in `materials.yaml` |

One silhouette per armor slot, and within a class the material is only a ramp:
a Steel Chest and a Studded Chest are the same drawing. A **material class** can
ask for a shape of its own, though — cloth does, because a robe is not a
cuirass in a different color. A cloth piece looks for `<slot>_cloth.png` and
falls back to `<slot>.png`, so a variant costs one drawing where it pays and
nothing where it doesn't: `chest_cloth`, `helmet_cloth` and `gloves_cloth` are
drawn, and cloth leggings and boots take the default shapes because a robe
covers them anyway. Delete a variant and its slot silently reverts.

Adding a class (a leather line, say) means a row in `MATERIAL_CLASS_SHAPES` in
`shared/itemVisuals.ts` — the fallback itself needs no registry, but *which*
class prefers *which* suffix does.

Rings and amulets are deliberately not drawn — a handful of pixels at on-screen
scale reads as noise, so they stay inventory-only.

The armor is a first pass: it reads as a suit and lines up with the pose, but
each piece is a plain silhouette with one specular hit. `sword.png` is a
placeholder good enough to prove the pipeline; replace it.

Pieces are drawn against each other, not just against the body: the chest's
sleeve ends where the gauntlet cuff starts (row 34), the leggings' hem (row 54)
laps over the top of the boot shaft (row 53), and the chest stops at row 42 so
the leggings' belt shows under it. Redrawing one piece past those seams leaves
a gap or an overlap on the assembled character, so check a full set in the
workbench, not only the piece you touched.
