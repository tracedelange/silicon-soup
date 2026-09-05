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
| chest | `chest_light.png` / `chest_heavy.png` | the material's `armor_tag` |
| helmet | `helmet_light.png` / `helmet_heavy.png` | the material's `armor_tag` |

Armor is a silhouette per weight class, not a shape per archetype: a Steel Chest
and a Wool Chest differ by ramp and weight, nothing else. Gloves, boots,
leggings, rings and amulets are deliberately not drawn — a handful of pixels at
on-screen scale reads as noise, so they stay inventory-only.

`sword.png` is a placeholder good enough to prove the pipeline; replace it.
