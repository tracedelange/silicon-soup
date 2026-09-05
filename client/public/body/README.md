# Paper-doll bodies

The character underneath the gear. Edit them in the workbench:

```bash
npm run sprite-lab   # http://localhost:3005 → Editing → "body — …"
```

## Resolution order

A class draws with its own file, else the shared one, else the template
compiled into `shared/playerComposite.ts`:

| File | Used by |
|---|---|
| `<class>.json` (`fighter`, `rogue`, `wizard`) | that class only |
| `default.json` | every class with no file of its own |
| *(none)* | the built-in templates |

**One body for the whole roster is just `default.json` and no per-class files.**
Deleting a file reverts to the next fallback, so nothing here is one-way.

## Format

`{ "rows": [...] }` — 64 rows of 64 legend characters, `.` for transparent.
JSON rather than PNG because a body is painted in *roles*, not colors: a `g`
cell becomes the player's chosen garment color, `s` becomes the class's skin
tone. There is no fixed RGB to round-trip through an image, and storing one
would bake in the palette the body is supposed to be independent of.

Roles are listed in `BODY_ROLES` (`shared/playerComposite.ts`) and appear as the
editor's swatches: `o` outline, `d` face shadow, `s`/`S` skin, `w`/`e` eyes,
`h` hair, `b`/`B` leather, `m`/`M` metal, `L`/`g`/`G` garment.

## anchors.json

The pose contract — which rows are the head, shoulders, hands, belt and feet —
in sprite pixels. It lives here because it describes *these* bodies: a body
drawn to different proportions moves every landmark on it, and the gear drawn
against the old rows stops lining up. Absent, the defaults in `POSE_ANCHORS`
apply. Edit it in the workbench's **Pose anchors** panel.
