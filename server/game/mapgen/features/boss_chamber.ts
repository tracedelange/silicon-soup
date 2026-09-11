import type { FeatureOperator, PhasedOps } from './index.ts';

// boss_chamber — a room that is guaranteed to exist, guaranteed to be open, and
// guaranteed to be reachable, in a zone whose layout re-rolls every epoch.
//
// The failure this exists to prevent is sharp and silent: the generator produces
// a layout with nowhere for the boss to be, the spawn that names that region is
// skipped, and the fight simply does not exist that day. In a rotating world
// that is a bug you find in production at midnight (docs/plan-poi-authoring.md).
//
// Three ops, one per phase, and the phases are the design:
//
//   reserve  — `region` is the only placement atom that CANNOT fail (it resolves
//              a shape and registers it unconditionally, with no search-and-
//              give-up path), so the region always exists. Claiming it in the
//              reserve phase is what keeps it OPEN: everything that competes for
//              space afterwards — scatter_sites, place, stamp, and bsp's wall
//              pass — routes around a reservation.
//   decorate — ensure_reach carves a corridor to it if the layout stranded it.
//              Reserving space inside a dungeon can wall it off; without this
//              the chamber exists and is open and cannot be walked to.
//
// Deliberately centred rather than placed "far from the entrance": distance is
// not expressible coordinate-free, and it is not the guarantee that matters. The
// entrance is whatever region the zone's spawn_point names, and since a
// reserved chamber is never one of the rooms bsp generates, arrival is never
// inside it — which was the actual problem (landing the player on the boss).
export const bossChamber: FeatureOperator = {
  id: 'boss_chamber',
  note: 'A reserved, always-present, always-reachable room named `boss_chamber`, for an encounter that must exist in every re-roll of a rotating zone. Spawns address it by name.',
  params: [
    { field: 'size', label: 'Chamber size (tiles)', min: 5, max: 20, step: 1, default: 11 },
  ],
  blueprint: (p): PhasedOps => {
    const size = Math.max(5, Math.round(p.size));
    return {
      reserve: [
        {
          type: 'region',
          id: 'boss_chamber',
          shape: { kind: 'rect', w: size, h: size },
          at: { center: true },
          floor: 'stone_floor',
          claim: 'reserved',
          tags: ['boss_chamber'],
        },
      ],
      decorate: [
        {
          type: 'ensure_reach',
          from_tag: 'boss_chamber',
          ensure_all: true,
          carve: 'stone_floor',
          through: ['wall', 'cracked_wall'],
        },
      ],
    };
  },
};
