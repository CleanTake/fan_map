# FanMap frontend

The Next.js app includes the campus map, a light-only interface, admin map editing,
and minimal email/password authentication.
Guests can explore the map immediately. Signing up creates a registered account;
administrator access is granted separately by a trusted local command. Registered
users and administrators can save favorite locations to their account and find
them again after signing in.

## Run locally

Use **Node.js 24 or later**; authentication uses Node's built-in SQLite module.

```sh
npm install
```

Copy `.env.example` to `.env.local`, add your Mapbox access token, then run:

```sh
npm run dev
```

Open `http://localhost:3000`. Account pages are `/sign-up`, `/sign-in` and
`/sign-out`. Registration signs the user in immediately. Sign-out returns them to
guest access.

To test from a phone on the same Wi-Fi or hotspot, find the computer's Wi-Fi IPv4
address using `ipconfig`, then run (replace the example IP with that address):

```powershell
$env:FANMAP_DEV_ORIGINS = "172.20.10.2"
npm run dev -- --webpack --hostname 0.0.0.0 --port 3000
```

Open `http://172.20.10.2:3000` on the phone. `FANMAP_DEV_ORIGINS` allows Next.js
development assets and hot reload from the supplied hostname/IP. It accepts a
comma-separated list without schemes or ports, and can also be set in `.env.local`.
Restart the server after changing it. Keep the computer awake and on the same
network; if Windows prompts, allow Node.js on the private network. An HTTPS setup
is needed for live phone GPS; the annotation page works over HTTP.

### Phone HTTPS for a live walk

Put the phone and computer on the same private Wi-Fi network or hotspot.
From `frontend`, run the following command with Node 24 and Git for Windows
(the script uses its bundled OpenSSL).

```powershell
node scripts/phone-https.mjs
```

The script selects the Wi-Fi IPv4 address, or accepts an explicit one, e.g.
`node scripts/phone-https.mjs 172.20.10.2`. It starts a separate HTTPS development
server on that interface at port 3443. Keep the terminal open while testing.

Transfer the printed **FanMap-phone-root.cer** file to your own test phone via
USB or another trusted transfer. On iPhone, install the certificate profile,
then enable it under **Settings → General → About → Certificate Trust Settings**.
On Android, select **Install a certificate → CA certificate** under security
settings and choose the file. Menu names vary by device.
[Apple's certificate trust instructions](https://support.apple.com/en-us/102390) ·
[Google's certificate settings](https://support.google.com/pixelphone/answer/2844832)

Open the printed HTTPS URL in Safari or Chrome, start the walk, and grant the
requested sensors. The certificate must be trusted for the phone browser to
accept the connection. The server key stays in the computer's per-user temporary
directory. The short-lived test CA is specific to this setup; its signing key
is discarded after issuing the server certificate. Remove the test CA from your
phone when testing is finished. If the Wi-Fi IP changes or the certificate
expires, rerun the command and install the newly printed public certificate.

The database is created automatically at `.data/auth.sqlite`. No separate database
server, migration command, secret signing key or seed password is required. The
database and its journal files are ignored by Git. `FANMAP_AUTH_DB` can select
another file; relative paths resolve from the frontend working directory. The
server and admin command both load the Next.js environment files.

## Create an administrator

First create a regular account through `/sign-up`. From this directory, run:

```sh
npm run auth:admin -- account@example.com
```

This promotes that existing account in the configured database. There are no
automatically created administrators, public role-selection fields or hardcoded passwords.
Existing sessions read the current role from the database on every request.
The command loads development environment files by default; set `NODE_ENV` to
`production` when promoting an account in a production configuration.

For a local administrator with a username, set a password through the environment
and run the local setup command (PowerShell):

```powershell
$env:FANMAP_ADMIN_PASSWORD = 'your-local-test-password'
npm run auth:local-admin -- admin
Remove-Item Env:FANMAP_ADMIN_PASSWORD
```

This creates username `admin` in the configured SQLite database with a scrypt
password hash and an internal `admin@fanmap.local` email. Running it again resets
that username's password and revokes its existing sessions. The command refuses
production mode and never runs automatically. Sign in through `/sign-in` using
the username and chosen password. Existing email sign-ins continue to work.

## Admin map editing

Sign in to an administrator account, then select **Admin** to enable map editing.
Click an empty spot on the map to add a place. Click an existing map pin (or select
any location from the list) and choose **Edit this place** or **Delete this place**.
Edits can change its name, type, description, latitude and longitude. Locations
awaiting map positions can keep both coordinates empty. Deletion asks for
confirmation before saving. Changes persist after a page refresh.

Guests and registered users can explore and save favorites as before, but cannot
edit the map. Every add, update and delete request checks the current session and
administrator role in the database and requires the app's own origin. The old
`ADMIN_API_KEY` is no longer used. Signing out or revoking the admin role immediately
removes API access, including for already open browser tabs.

`POST /api/places` adds a place, `PATCH /api/places?id=...` updates one, and
`DELETE /api/places?id=...` removes one. Add/update bodies contain `name`, `category`,
`description` and `coordinates` (`[longitude, latitude]`; `null` is allowed for updates).
Unknown or deleted IDs return 404; guests receive 401 and non-admin accounts 403.

The map combines two existing data sources through `GET /api/places`:

- The file-backed store at `frontend/data/places.json`, including the existing
  main-branch places and admin-created places. Deletions are persisted in
  `frontend/data/deleted-place-ids.json` when needed. Explicit admin edits are
  persisted in `frontend/data/place-overrides.json`, preserving location IDs,
  favorites, and additional catalog metadata without rewriting the source catalog.
- The curated launch selection generated at `data/launch-locations.geojson`
  in the repository root. `GET /api/locations` remains a curated-only export.

Existing stored coordinates are preserved unless an administrator edits them. Curated locations with unknown
positions keep `geometry: null`; they remain selectable for details and favorites
without creating map pins or distance lines. The merge does not geocode or estimate
location coordinates. Regenerate the curated export after
editing its catalog; see `../data/README.md` for that workflow.

The JSON store is intended for local development or a single persistent Node.js
server. Serverless deployments require a persistent database instead of the local
JSON repository, alongside persistent storage for accounts and favorites.

## Authentication

The schema has four tables:

- `users`: UUID, unique normalized email, optional unique username, password hash, role (`registered` or
  `admin`), and creation/update timestamps.
- `sessions`: SHA-256 token digest, user reference, creation time, and expiry.
- `favorites`: user reference, location ID, and creation time, unique per user and
  location. Deleting a user also deletes their sessions and favorites.
- `location_reports`: location ID and name at submission, problem description,
  guest/registered reporter type, optional user reference, open/resolved status,
  reviewing administrator, and creation/update timestamps. Reports remain after a
  location or account is removed; deleted accounts have their references cleared.

Guests have no user record or session. Public signup passwords accept 15–128 characters without
composition rules and are hashed using asynchronous scrypt (`N=32768`, `r=8`,
`p=3`), a random 16-byte salt, and timing-safe verification. The stored format
includes its version and parameters. Raw passwords and session tokens are never
stored in the database. Sign-in accepts the password already assigned to an
account, including shorter local test passwords. Public signup cannot assign a
username or administrator role. Existing databases gain the optional username
column automatically while preserving accounts, sessions and favorites.

Sessions use random 32-byte opaque tokens and expire after seven days. Cookies are
`HttpOnly`, `SameSite=Lax`, and `Secure` in production. Signing in rotates the
current browser session; signing out revokes it in the database and clears the
cookie. All auth responses use `Cache-Control: no-store`.

The API accepts JSON and requires same-origin POST requests. Browser fetch
metadata is also checked when supplied. If hosting behind a reverse proxy, set
`FANMAP_AUTH_ORIGIN` to the public origin, for example
`https://fanmap.example.com`, and serve production over HTTPS.

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/auth/signup` | `{ "email": "…", "password": "…" }` | `{ "user": { "id", "email", "role" } }`, status 201 |
| `POST /api/auth/login` | `{ "email": "…", "password": "…" }` | `{ "user": { "id", "email", "role" } }` |
| `POST /api/auth/logout` | No body required | `{ "ok": true }` |
| `GET /api/auth/session` | No body | `{ "user": { "id", "email", "role" } }` or `{ "user": null }` |

Errors return `{ "error": "message" }` and a corresponding non-2xx status.
Server Components can call `getCurrentUser()` from `lib/auth/server.ts` to obtain
`Promise<AuthUser | null>`; client-safe types are in `lib/auth/types.ts`. Protected
server operations must check the current user and role themselves.

Rate limiting is intentionally simple and per process: 60 submissions per minute
across the instance and eight submissions per email per ten minutes, with bounded
key storage. At most two scrypt jobs run concurrently. For production, run one
Node server with a persistent writable disk for SQLite, and back up the database.
Ephemeral or multi-instance hosting requires a shared database and shared rate
limiter before deployment. Password resets and email verification are outside
this initial implementation.

## Saved locations

Select a location and use its star button to save or remove it. The Favorites
list in the sidebar opens saved locations and has a remove button for each one.
Opening a favorite restores its category and recenters the map when coordinates
are available. Guests can continue exploring the map and are
invited to sign in or create an account to save locations. Favorites persist in
the same SQLite database as accounts; existing databases gain the table
automatically without a separate migration command.

Every favorites endpoint requires a valid session and derives the account from
its session cookie. Registered users and admins have the same saving behavior.
PUT and DELETE require same-origin JSON requests containing only `locationId`.
PUT accepts active IDs from the combined map data, including curated entries
awaiting coordinates and places in the file-backed store. Deleted locations are
excluded. DELETE can also remove obsolete saved IDs after catalog changes.
Saving or removing the same location twice is harmless.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/favorites` | No body | `{ "locationIds": ["…"] }` |
| `PUT /api/favorites` | `{ "locationId": "…" }` | `{ "locationIds": ["…"] }` |
| `DELETE /api/favorites` | `{ "locationId": "…" }` | `{ "locationIds": ["…"] }` |

Responses use `Cache-Control: no-store`. Errors return `{ "error": "message" }`,
with 401 for guests or expired sessions, 400 for invalid locations, and 403 for
foreign origins. Mutations are limited to 60 per account per minute in each
server process; GET requests remain available when this limit is reached.

## Inaccurate location reports

Guests and registered users can select a location and choose **Report inaccurate
location** beneath the favorite control. Enter a short description (up to 1,000
characters) and choose **Send report**. No account or contact details are required
for guests. A confirmation appears after submission. Signed-in administrators
cannot submit reports; they can edit the map directly.

Administrators can open **Reports** in the map header, or visit `/admin/reports`.
The minimal tracker shows the location, description, report number, guest/user
type and timestamps. Filter by **Open**, **Resolved**, or **All**, open the location
on the map, and choose **Mark resolved** or **Reopen report**. Resolving a report
changes its tracking status; location changes are made through the existing map
editor. Use **Refresh** to fetch new reports. Lists are paginated at 25 reports.

Reports use the same `.data/auth.sqlite` database (or `FANMAP_AUTH_DB`) as accounts
and favorites. The table is added automatically to existing databases. No separate
database, migration command, or seed is needed. Location IDs and the submitted
location names are preserved even if a location is later renamed or deleted.
Report descriptions are visible only to admins, and reports do not change map data.

| Endpoint | Access and request | Response |
| --- | --- | --- |
| `POST /api/reports` | Guest/registered; `{ "locationId": "…", "message": "…" }` | `{ "id": 1, "status": "open" }`, status 201 |
| `GET /api/reports?status=open&page=1` | Admin; status is `open`, `resolved`, or `all` | `{ "reports": [...], "page", "pageCount", "total", "counts" }` |
| `PATCH /api/reports` | Admin; `{ "id": 1, "status": "resolved" }` or `"open"` | `{ "report": {...} }` |

Mutations require same-origin JSON and bounded request bodies. Unknown/deleted
locations cannot receive new reports. Reporter identity comes from the session,
never the request body. Guests and regular users cannot list reports or change
their statuses; every admin request checks the current database role.
All responses use `Cache-Control: no-store`.

Submission limits are intentionally basic and per server process: 30 attempts
per minute globally and five per minute per signed-in account or shared guest
bucket. Guests do not receive a tracking cookie and IP addresses are not stored.
Rate-limited requests receive 429 with `Retry-After`; admin review remains available.
For a larger public deployment, replace these coarse in-memory limits with shared
abuse protection. The existing single-server SQLite persistence requirements apply.

## Walking directions

Everyone, including guests, can choose **Directions** in the header. Select a
starting campus place (or **My location**) and a destination, then choose **Get
walking route**. Selecting a map location and choosing **Directions here** prefills
the destination. Each request runs a shortest-path search over a combined campus
network: traced ground-floor corridors, confirmed connections and doors, and
OpenStreetMap outdoor pedestrian paths. There is no admin route selection.
Locations outside the connected campus network fall back to Mapbox's outdoor
walking directions.
Use **Pick start on map** / **Pick destination on map** to test locations that do
not yet have a reliable catalogue pin. Tap the ground-floor map; a labelled marker
records the chosen point. These temporary points do not edit the location data.

The map displays the returned path and its start/end points, fits the route into
view, and shows walking distance, estimated time and expandable instructions.
Changing either endpoint, clearing, closing, or cancelling aborts old requests and
removes the old route. Places without map coordinates are excluded from the
selectors. Failed or unmapped routes display an error, with no straight-line
fallback. The separate location-details distance remains explicitly straight-line.

Campus routing runs locally in the browser using `lib/navigation/campus-router.ts`.
Indoor segments are purple, outdoor segments red, and doors green. Indoor routes
use a flat map with corridor and door context instead of hiding the path behind
3D buildings. The Q1 C-D connection has two doors and a short outdoor crossing;
Q2 follows F's east side to D; Q3 B-D and Q5 H-M are continuous corridors without
invented outdoor doors; Q4's curved G/F/L link is enclosed. These topological
connections follow the user's 2026-11-18 confirmations. Precise geometry and
walking-time estimates remain approximate because the base image is a schematic.

The generic Student Services placeholder is deleted. Parking Lot 5's old pin was
near Lot 3 on the schematic; its corrected pin is in Lot 5, with a separate
`navigationCoordinates` point on the south pedestrian path. Routing uses that
access point while the map pin continues to label the parking area.
The old Building A pin, which was near the gyms, is likewise aligned with the A
footprint and has a ground-floor corridor anchor separate from its display pin.

Endpoints inside buildings snap to that building's ground-floor corridors (up
to 40 m), rather than a nearby outdoor street. Outdoor endpoints snap up to 80 m,
with building-crossing approaches rejected. Endpoints on the same edge are split
and connected directly. Crossings in the outdoor dataset only join through shared
OSM nodes. Places explicitly on upper floors are excluded from the route selectors.
This does not provide room-door precision, verified step-free paths or live closure
information. The UI distinguishes approximate campus geometry from provider routes.

Fallback requests use the existing `NEXT_PUBLIC_MAPBOX_TOKEN` and send the two
coordinates to Mapbox. The token must permit Directions API requests from the
current URL; those requests count toward the account's Directions usage. The
provider's snap radius is 80 m. Offsets over 25 m are displayed.

Phone GPS and motion sensors need trusted HTTPS and user permission. Two selected
campus places and the ground-floor walk replay work over HTTP. The live walk
pilot uses the phone's location outdoors, estimated steps and turns on the
ground-floor path network, and confirmed landmarks to recover position. Use it
with the page visible; the phone pilot still needs on-campus validation.

API reference: https://docs.mapbox.com/api/navigation/directions/

## Campus reference overlay and passage review

**Review campus map** in the public header overlays the user-supplied campus
schematic on the existing geographic map. It switches to a flat view, hides the
extruded buildings, and draws the existing footprint outlines in teal. Opacity
can be varied to compare the image and map. Closing review restores the prior
camera and building display. Directions and review use separate views.

The review lines come from the compiled campus routing graph, including generated
entrance approaches and doorway links such as B's south entrance. The original
source traces remain preserved as evidence, while the review view shows the
actual connections used by navigation. Imported OSM streets/pathways retain the
underlying basemap display.

Purple lines show the ground-floor passages; red lines show outdoor links. Green
**Q1–Q5** markers record the user's confirmations. Q6 remains in the review log
as a removed placeholder, without placing its old pin on the map. The reference
PNG is preserved unchanged; source-image traces and the confirmation record are
in `data/navigation/reference-passages.json`.

Registration uses six manually matched building corners and six independent
checkpoints from the repository's existing building polygons. The image is a
schematic: checkpoint RMS is approximately 6.5 m and maximum error is 11.6 m,
especially around M. These values describe registration against the existing
footprints, not surveyed absolute accuracy. They do not certify door positions.
`data/navigation/reference-registration.json` records the source hash, control
vertices, Web Mercator affine transform and residuals. Reproduce it with:

```sh
python scripts/prepare-navigation-reference.py
```

Rebuild `data/navigation/campus-network.json` from the source traces and the
included `data/navigation/sources/campus.osm.gz` extract using
`python scripts/prepare-campus-network.py`. Both the graph compiler and the
entrance review verify the SHA-256 of the decompressed OSM source. The compiled graph records
the source URL, input hash and OpenStreetMap ODbL attribution. The generator does
not download data. It splits the single-floor traced paths at junctions, joins
explicit public entrance ports, and preserves shared OSM node topology. The
schematic is registered approximately; user confirmation establishes connectivity,
not survey accuracy or current door-access hours.

The 17 additions from the user's 2026-11-22 review are included in both the route
graph and the reference overlay. The original JSON is preserved unchanged in
`data/navigation/reviews/2026-11-22.json`. `scripts/apply-campus-review.py` records
the reviewed geometry and provenance in `reference-passages.json`; it aligns
nearly horizontal/vertical stretches, preserves intended bends, joins near-miss
endpoints to exact junctions, and merges A010's duplicate backtrack. The largest
shape adjustment is under four reference pixels. A011 supplies the shared R1
south doorway, and A009 includes the visible G west approach to the existing
indoor corridor. Exposed roads/courtyards are outdoor; door boundaries remain
schematic estimates. Reapplying this review is idempotent:

```sh
python scripts/apply-campus-review.py
python scripts/apply-campus-review.py --entrances
python scripts/prepare-campus-network.py
```

The cumulative follow-up is preserved in `reviews/2026-11-22-entrances.json`.
Its five new strokes describe three connections: the F and M entrance approaches,
and a curved indoor T/B hallway with a central branch. The original seventeen
marks are checked against the first export and retained. F reuses its existing
door; M gains an east-side doorway transition. The outdoor approaches connect
to two explicitly identified OSM footpath junctions, without enabling automatic
joins at unrelated geometric crossings. The T/B curve is preserved while its
near-miss ends and branch become exact shared vertices. The review panel counts
20 connections, represented by 22 drawing strokes.

## Parking locations and annotation handoff

The numbered lots visible on the supplied reference (1–11) have mapped pins,
including both separate Lot 7 sections. `data/navigation/parking-lots.json`
records their source pixels and review areas. Regenerate missing stored pins
with `python scripts/prepare-parking-lots.py`; existing locations/overrides,
including Lot 5 and its access point, are preserved. The P-number meter labels
are not treated as additional numbered lots.

New lot locations carry `navigationStatus: "pending-access-review"`. They appear
in the map, search, and favorites; directions from/to those named lots explain
that their pedestrian access awaits review rather than treating a lot-centre
pin as a verified exit. Lot 5 retains its existing walking access.

**Review campus map → Annotate parking connections** opens the offline-capable
`/navigation/annotate-parking-connections.html`. This refreshed copy contains all
1,884 current graph segments, including the accepted 20 path additions and
generated entrance links. It shows parking labels and supports selecting a lot,
drawing its missing pedestrian links, adding notes, autosaving, and exporting
JSON/PNG. New marks start at A023; previous accepted marks are now base geometry.
The export stores the graph hash, parking IDs and source-image coordinates.
The previous annotation document is preserved separately.

## Labelled reference-map locations

`data/navigation/campus-landmarks.json` records the source pixels of named
buildings, gyms, office areas, campus entrances, and metered parking locations.
`python scripts/prepare-campus-landmarks.py` adds missing pins and positions four
existing catalog records through overrides, preserving their IDs and catalog
metadata. Repeating the import preserves existing points and admin edits.
The numbered lots, Building A and existing entrance/bus pins are retained.

Food & Retail legend entries have no individual positions drawn on this plan and
are deliberately excluded. Map-area pins do not identify exact room doors.
Ground-floor navigation uses reviewed corridor approaches where available;
unreviewed building/metered-parking access remains pending. The map's Parking
Office D1018 label is a separate, unconfirmed reference landmark: the existing
FANCard/Parking/Lockers catalog entry at E2020 is retained.

## Check and build

```sh
npm run test:auth
npm run lint
npm run build
npm start
```

Tests exercise password hashing, persisted SQLite accounts and favorites, session
expiry and revocation, per-account favorites isolation, role restrictions,
origin/body validation, rate limits, report submission/review restrictions,
report persistence and pagination, and automatic database-table migration.
