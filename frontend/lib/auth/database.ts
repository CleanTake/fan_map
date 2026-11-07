import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./types.ts";

export const SESSION_COOKIE = "fanmap_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

type UserRecord = AuthUser & { password_hash: string };

function withUsername<T extends AuthUser>(row: T & { username?: string | null }): T {
  const { username, ...rest } = row;
  return { ...rest, ...(username ? { username } : {}) } as T;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isSessionToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export class AuthStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'registered' CHECK (role IN ('admin', 'registered')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, location_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS location_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id TEXT NOT NULL,
        location_name TEXT NOT NULL,
        message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
        reporter_type TEXT NOT NULL CHECK (reporter_type IN ('guest', 'registered')),
        reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS location_reports_status_id ON location_reports(status, id DESC);
    `);
    const columns = this.database.prepare("PRAGMA table_info(users)").all();
    if (!columns.some((column) => column.name === "username")) {
      this.database.exec("ALTER TABLE users ADD COLUMN username TEXT");
    }
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL");
  }

  findUser(email: string): UserRecord | null {
    const row = this.database.prepare(
      "SELECT id, email, username, role, password_hash FROM users WHERE email = ? OR username = ? COLLATE NOCASE",
    ).get(normalizeEmail(email), normalizeEmail(email)) as UserRecord | undefined;
    return row ? withUsername(row) : null;
  }

  createUser(email: string, passwordHash: string, now = Date.now()): AuthUser {
    const user: AuthUser = { id: randomUUID(), email: normalizeEmail(email), role: "registered" };
    this.database.prepare(
      "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'registered', ?, ?)",
    ).run(user.id, user.email, passwordHash, now, now);
    return user;
  }

  createSession(userId: string, now = Date.now()): { token: string; expires: Date } {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now + SESSION_MAX_AGE * 1000);
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.database.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashSessionToken(token), userId, now, expires.getTime());
    return { token, expires };
  }

  findSession(token: string | undefined, now = Date.now()): AuthUser | null {
    if (!isSessionToken(token)) return null;
    const row = this.database.prepare(`
      SELECT users.id, users.email, users.username, users.role FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashSessionToken(token), now) as AuthUser | undefined;
    return row ? withUsername(row) : null;
  }

  revokeSession(token: string | undefined): void {
    if (isSessionToken(token)) {
      this.database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    }
  }

  promoteAdmin(email: string, now = Date.now()): boolean {
    return this.database.prepare(
      "UPDATE users SET role = 'admin', updated_at = ? WHERE email = ?",
    ).run(now, normalizeEmail(email)).changes > 0;
  }

  listFavoriteIds(userId: string): string[] {
    const rows = this.database.prepare(
      "SELECT location_id FROM favorites WHERE user_id = ? ORDER BY created_at, location_id",
    ).all(userId) as { location_id: string }[];
    return rows.map((row) => row.location_id);
  }

  // Trusted local setup only; never exposed through public registration.
  setLocalAdmin(username: string, passwordHash: string): AuthUser {
    username = normalizeEmail(username);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(username)) throw new Error("Use a username of 1–32 letters, numbers, underscores or hyphens, starting with a letter.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findUser(username);
      const user = existing ?? this.createUser(`${username}@fanmap.local`, passwordHash);
      this.database.prepare("UPDATE users SET username = ?, password_hash = ?, role = 'admin', updated_at = ? WHERE id = ?")
        .run(username, passwordHash, Date.now(), user.id);
      this.database.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      this.database.exec("COMMIT");
      return { id: user.id, email: user.email, username, role: "admin" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addFavorite(userId: string, locationId: string): void {
    this.database.prepare(
      "INSERT INTO favorites (user_id, location_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, location_id) DO NOTHING",
    ).run(userId, locationId, Date.now());
  }

  removeFavorite(userId: string, locationId: string): void {
    this.database.prepare("DELETE FROM favorites WHERE user_id = ? AND location_id = ?").run(userId, locationId);
  }

  close(): void {
    this.database.close();
  }
}

const shared = globalThis as typeof globalThis & {
  fanmapAuthStore?: { path: string; version: number; store: AuthStore };
};

// Recreate an older hot-reloaded singleton so it gets the current schema and methods.
const AUTH_STORE_VERSION = 4;

export function getAuthStore(): AuthStore {
  const path = resolve(/* turbopackIgnore: true */ process.env.FANMAP_AUTH_DB || ".data/auth.sqlite");
  if (shared.fanmapAuthStore?.path !== path || shared.fanmapAuthStore.version !== AUTH_STORE_VERSION) {
    shared.fanmapAuthStore?.store.close();
    shared.fanmapAuthStore = { path, version: AUTH_STORE_VERSION, store: new AuthStore(path) };
  }
  return shared.fanmapAuthStore.store;
}
