# Launch locations

`campus-places.json` is the curated launch catalog, using schema version 4. It
contains 31 destinations: 25 locations selected for the initial map and six
confirmed vendors shown inside their food courts. Its 23 room records hold the
physical anchors. `buildingNames` contains only nine code-to-name labels for
those rooms: A, B, D, E, F, H, J, L and SC. Building geometry, addresses, zones and
the broader campus inventory are outside this catalog.

`launch-locations.txt` preserves the owner's preliminary list, with trailing
whitespace removed. The list has 30 named service entries and no explicit room
numbers or study-room locations. There are 25 active `launchLocations` rows and
five `excludedLaunchLocations` rows, so every original request remains accounted
for. `launchGroups` preserves the original sections, including empty Residence.

`launch-locations.geojson` is a generated preview with 25 map features. D Cafe
and D Courtyard are separate locations; Gym 1 & 2 and Gym 3 are separate too.
Meal Plan, Parking Office and FANCard Service resolve to one destination. Food
courts have one feature each, with `childIds` referring to their vendors rather
than overlapping vendor pins. D Cafe contains Harvey's and Tim Hortons
self-serve; D Courtyard contains Pizza Pizza, Subway and Tim Hortons Junction;
H Cafe contains Starbucks. Study rooms are deferred.

## Exclusions and deferred locations

The active catalog omits Pharmacy, B Cafe and its eight vendors, and Biz Booth.
The sources report the pharmacy permanently closed after April 24, 2026, and
B Cafe and Biz Booth closed for the Fall 2026 term. Their original request rows
and reasons remain in `excludedLaunchLocations`; closed services are not drawn
as launch destinations.

Continuing Education Office and Foot Patrol are deferred because their current
office or service identity needs confirmation. The Variety Store row includes
only the confirmed D1043 location and explains that the second requested store
is deferred. The Nest has not been substituted. D Cafe's unconfirmed On the Go
vendor and the other locations outside the preliminary launch scope are removed.
Revisit the recorded decisions when a service reopens or its location is confirmed.

Distinct services sharing a room remain searchable: Registrar and Financial Aid
at E1012; Student Health and Fowler Kennedy at J1004. They share physical room
anchors without losing their individual service names.

Official sources establish Financial Aid at E1012, Makerspace/3D printing at
F1061, the Institute of Indigenous Learning at A1046, and the International Centre
at E2025. The hair salon, Dernier CRI Hair Group, is operating in L1002 with
published hours: Monday–Wednesday 10:00–17:00, Thursday 10:00–19:00, Friday
10:00–18:00 and Saturday 11:00–14:00. Its hours are subject to change; Sunday hours
are unpublished and remain unknown. Source retrieval dates are recorded per
reference. A room assignment does not verify latitude or longitude.

## Coordinates and the app preview

All 23 initial room geometries are deliberately `null`. Prototype coordinates
have not been promoted to real locations. The app can preview the 25 selected
locations in its list; their map pins remain pending until manually checked
coordinates are entered.
A feature with `geometry: null` is valid GeoJSON and cannot draw a pin.

Physical locations belong in `rooms[].geometry`. Room-based destinations use
`roomId`, and their room code, floor and building label are derived from that
room. Vendor destinations inherit their food court's anchor through `parentId`.
There are no building geometry anchors or centroid fallbacks. A destination may
override the point if it needs a distinct position within its room.

For each manually checked location, enter a GeoJSON Point with two finite numeric
coordinates in **longitude, latitude** order. Longitude must be between -180 and
180, and latitude between -90 and 90. Leave the geometry null until the actual
marker location has been checked; do not store estimated points as non-null
geometry. No additional coordinate date, method, reference or status fields are
required. Validation checks the shape and numeric bounds of a point; it cannot
prove geographic accuracy. Review each location manually before populating it.

Changing a point requires checking the new location again.
A checked indoor marker does not establish an outdoor entrance for walking
directions; entrance locations need their own review if routing is added.

Omit destination `geometry` to inherit its room or parent anchor. An explicit
destination `geometry: null` blocks inheritance. A valid non-null point is
exported directly, so manual review must happen before it is entered. Do not edit
the generated GeoJSON directly.

`status: open` describes a generally operating service. It does not mean "open
now". Unknown days, missing schedules or expired hours must not imply that a
service is currently open or closed. `campus-holidays.json` remains unchanged and
separate; prior-year or assumed college closure decisions need review before
overriding an individual service's hours.

## Generate and validate

Run from the repository root:

```sh
python data/validate.py
python data/generate_geojson.py
python data/generate_geojson.py --check
python -m unittest discover -s data -p 'test_*.py'
```

After manually checking and entering the launch coordinates, run:

```sh
python data/validate.py --require-launch-ready
python data/generate_geojson.py --check --require-coordinates
```

Default validation accepts a draft with null coordinates. Readiness checks fail
until every selected point is present and structurally valid. They do not prove
that a manual accuracy check happened. Recorded exclusions and deferred items
are outside the active selection and do not block its readiness.

The exporter maps catalog classifications to the app's icon categories (`food`,
`retail`, `service`), preserves navigation groups and does not infer live opening
hours. The frontend reads the generated GeoJSON and draws pins only for non-null,
structurally valid Point geometries.
