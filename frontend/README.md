# FanMap frontend

The Next.js app includes the campus map and minimal email/password authentication.
Guests can explore the map immediately. Signing up creates a registered account;
administrator access is granted separately by a trusted local command. Saving
locations will be added later.

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
default administrators, public role-selection fields or hardcoded passwords.
Existing sessions read the current role from the database on every request.
The command loads development environment files by default; set `NODE_ENV` to
`production` when promoting an account in a production configuration.

## Authentication

The schema has two tables:

- `users`: UUID, unique normalized email, password hash, role (`registered` or
  `admin`), and creation/update timestamps.
- `sessions`: SHA-256 token digest, user reference, creation time, and expiry.

Guests have no user record or session. Passwords accept 15–128 characters without
composition rules and are hashed using asynchronous scrypt (`N=32768`, `r=8`,
`p=3`), a random 16-byte salt, and timing-safe verification. The stored format
includes its version and parameters. Raw passwords and session tokens are never
stored in the database.

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
limiter before deployment. Password resets, email verification and saved locations
are outside this initial implementation.

## Check and build

```sh
npm run test:auth
npm run lint
npm run build
npm start
```

Auth tests exercise password hashing, persisted SQLite accounts, session expiry
and revocation, role restrictions, origin/body validation, and rate limits.
