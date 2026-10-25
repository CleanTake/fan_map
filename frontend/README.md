# FanMap frontend

The Next.js app includes the campus map, light/dark themes, admin map editing,
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
