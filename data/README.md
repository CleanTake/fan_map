# Campus data and launch GeoJSON

`campus-places.json` is the source catalog. `launch-locations.txt` is a snapshot of
the project owner's preliminary list with trailing whitespace removed.
`launchLocations` records how each of its
30 named entries maps to the catalog, and `launchGroups` preserves the requested
sections, including the currently empty Residence section.

`launch-locations.geojson` is a generated preview of the initial selection. It
contains one feature per unique destination, rather than one per list entry.
D Cafe and D Courtyard are separate destinations, as are the two gym locations.
Meal Plan, Parking Office and FANCard Service share one office destination. Food
courts have one feature each; their `childIds` refer to vendors in the catalog.
Vendor hours and identities are preserved without creating overlapping vendor
pins. Study-room features are outside this selection; second-floor F Building
study rooms will be added later.

## Coordinates

All initial coordinates are unverified and are deliberately `null`. None of the
prototype coordinates from the frontend is used as a verified location. A
feature with `geometry: null` is valid GeoJSON but will not draw a map pin.

Physical room locations belong in `rooms[].geometry`. Room-based destinations
reference `roomId`; room code, building and floor are derived from the room.
Destinations that share a food court inherit its location through `parentId`.
Roomless locations may reference a building, but a missing room point is never
replaced by the building's centre. A destination may have its own point if it
needs a different position from its room or parent.

For a checked point, set `geometry` to a GeoJSON Point with two finite numeric
coordinates in **longitude, latitude** order. Set the accompanying
`coordinateVerification` fields:

- `status`: `verified` after checking the actual marker location; otherwise
  `pending`.
- `method`: how the point was checked, for example `manual_map_review` or
  `on_site_gps`.
- `verifiedAt`: the check date in `YYYY-MM-DD` format.
- `reference`: the annotated map, survey, field observation or other reference
  used to check the position.

Changing coordinates requires checking them again and updating the verification
record. A checked indoor marker does not establish a usable outdoor entrance for
walking directions. Keep entrance locations separate if routing is added.

Omit both destination `geometry` and `coordinateVerification` to inherit a room,
parent or roomless building anchor. Explicit destination `geometry: null` with
pending verification means its own location is unresolved and blocks inheritance.
Even if an estimated point is entered, the exporter keeps its geometry null
until verification is marked complete. Do not edit the generated file directly.

## Scope and unresolved entries

Three requested identities or locations still need review:

- Continuing Education Office: current office room and building are unknown.
- Foot Patrol: the current security page describes Safe Walk, but equivalence
  with the requested historical service is not established.
- The second Variety Store: do not assume this is The Nest or reuse D1043.

These have explicit pending records and null geometry so the request is not lost.
The local launch-list source establishes requested scope, not proof that an
unresolved service or branch currently exists. Resolve the catalog references
and change the affected launch row's `resolutionStatus` to `resolved` after
confirmation.

New official references support Financial Aid at E1012, Makerspace/3D printing at
F1061, the Institute of Indigenous Learning (formerly First Nations Centre) at
A1046, and the International Centre at E2025. Meal Plan, Parking and FANCard map
to the combined office at E2020. These references establish service and room
metadata; they do not verify latitude or longitude.

Closed locations requested in the list remain in the export with their operating
status: B Cafe and Biz Booth are temporarily closed; the pharmacy is permanently
closed. `status: open` means generally operating, not "open now". Unknown or
expired hours must not be interpreted as open. `campus-holidays.json` remains a
separate reference; prior-year or assumed college closure decisions need review
before using them to override an individual service's hours.

## Generate and check

Run from the repository root:

```sh
python data/validate.py
python data/generate_geojson.py
python data/generate_geojson.py --check
python -m unittest discover -s data -p 'test_*.py'
```

After entering and verifying the launch coordinates and resolving pending scope,
check readiness with:

```sh
python data/validate.py --require-launch-ready
python data/generate_geojson.py --check --require-verified
```

The normal validation accepts an honest draft with null coordinates. Readiness
checks deliberately fail while any selected entry is unresolved or any selected
point is unverified. Non-launch catalog locations can remain pending.

The exporter maps catalog classifications to the current frontend's icon
categories (`food`, `retail`, `service`), while retaining `catalogCategory` and
the requested navigation groups. It does not infer current opening hours.
The frontend is not changed by this data PR; when the export is connected to the
map, only features with verified non-null geometry should be drawn, and closed
services should be labelled clearly.
