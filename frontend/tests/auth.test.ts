import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { AuthStore, hashSessionToken, SESSION_MAX_AGE } from "../lib/auth/database.ts";
import { createAuthHandlers, isSameOrigin } from "../lib/auth/http.ts";
import { createAuthLimits, RateLimiter } from "../lib/auth/limiter.ts";
import { hashPassword, PasswordWorkBusyError, verifyPassword } from "../lib/auth/password.ts";

const password = "a simple lengthy passphrase";
const origin = "http://localhost:3000";

function request(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  assert.match(header, /HttpOnly; SameSite=Lax/);
  return header.split(";")[0];
}

test("password hashes are salted, versioned, verifiable, and reject malformed formats", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$v1\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("a different lengthy password", first), false);
  assert.equal(await verifyPassword(password, "plaintext-password"), false);
  assert.equal(await verifyPassword(password, first.replace("32768", "1073741824")), false);
});

test("password work has a bounded concurrency instead of an unbounded queue", async () => {
  const first = hashPassword(password);
  const second = hashPassword(password);
  await assert.rejects(hashPassword(password), PasswordWorkBusyError);
  await Promise.all([first, second]);
  assert.equal(await verifyPassword(password, await hashPassword(password)), true);
});

test("SQLite normalizes email, enforces uniqueness, persists roles, and keeps only session digests", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanmap-auth-test-"));
  const path = join(directory, "auth.sqlite");
  let store = new AuthStore(path);
  try {
    const user = store.createUser("  Person@Example.COM ", "test-hash", 1000);
    assert.equal(user.email, "person@example.com");
    assert.equal(user.role, "registered");
    assert.throws(() => store.createUser("PERSON@example.com", "another-hash"));
    const session = store.createSession(user.id, 1000);
    assert.equal(session.token.length, 43);
    const rows = store.database.prepare("SELECT * FROM sessions").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, hashSessionToken(session.token));
    assert.equal(JSON.stringify(rows).includes(session.token), false);
    assert.deepEqual(store.findSession(session.token, 1001), user);
    assert.equal(store.findSession(session.token, 1000 + SESSION_MAX_AGE * 1000), null);
    assert.equal(store.findSession("invalid", 1001), null);
    assert.equal(store.promoteAdmin(" PERSON@EXAMPLE.COM ", 2000), true);
    assert.equal(store.findSession(session.token, 2001)?.role, "admin");
    assert.equal(store.promoteAdmin("missing@example.com"), false);

    store.close();
    store = new AuthStore(path);
    assert.equal(store.findUser(user.email)?.role, "admin");
    store.revokeSession(session.token);
    assert.equal(store.findSession(session.token, 2001), null);
  } finally {
    store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("fanmap-auth-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signup, login, current-session, logout and rotation honor the API contract", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createAuthHandlers(() => store, createAuthLimits());
  try {
    const guest = await handlers.session(request("session"));
    assert.deepEqual(await guest.json(), { user: null });
    assert.equal(guest.headers.get("set-cookie"), null);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);

    const signup = await handlers.signup(request("signup", { email: " New@Example.COM ", password }));
    assert.equal(signup.status, 201);
    assert.equal(signup.headers.get("cache-control"), "no-store");
    const { user } = await signup.json();
    assert.deepEqual(Object.keys(user).sort(), ["email", "id", "role"]);
    assert.equal(user.email, "new@example.com");
    assert.equal(user.role, "registered");
    const initialCookie = sessionCookie(signup);
    assert.deepEqual(await (await handlers.session(request("session", undefined, initialCookie))).json(), { user });

    const duplicate = await handlers.signup(request("signup", { email: "NEW@example.com", password }));
    assert.equal(duplicate.status, 409);
    const chooseAdmin = await handlers.signup(request("signup", { email: "evil@example.com", password, role: "admin" }));
    assert.equal(chooseAdmin.status, 400);
    assert.equal(store.findUser("evil@example.com"), null);

    const wrong = await handlers.login(request("login", { email: user.email, password: "the wrong lengthy passphrase" }));
    const unknown = await handlers.login(request("login", { email: "unknown@example.com", password }));
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());

    const login = await handlers.login(request("login", { email: "NEW@example.com", password }, initialCookie));
    assert.equal(login.status, 200);
    const newCookie = sessionCookie(login);
    assert.notEqual(initialCookie, newCookie);
    assert.deepEqual(await (await handlers.session(request("session", undefined, initialCookie))).json(), { user: null });
    assert.deepEqual(await (await handlers.session(request("session", undefined, newCookie))).json(), { user });

    const forgedLogout = await handlers.logout(request("logout", {}, newCookie, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }));
    assert.equal(forgedLogout.status, 403);
    assert.deepEqual(await (await handlers.session(request("session", undefined, newCookie))).json(), { user });
    const logout = await handlers.logout(request("logout", {}, newCookie));
    assert.deepEqual(await logout.json(), { ok: true });
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.deepEqual(await (await handlers.session(request("session", undefined, newCookie))).json(), { user: null });
  } finally {
    store.close();
  }
});

test("mutation origins, JSON bodies and password lengths are validated before account creation", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createAuthHandlers(() => store, createAuthLimits());
  try {
    assert.equal(isSameOrigin(request("login", {}, undefined, { "sec-fetch-site": "cross-site" })), false);
    assert.equal(isSameOrigin(request("login", {}, undefined, { origin: "http://localhost:3000/path" })), false);
    assert.equal(isSameOrigin(new Request(`${origin}/api/auth/login`)), false);
    assert.equal(isSameOrigin(request("login", {})), true);
    assert.equal(isSameOrigin(request("login", {}, undefined, {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
    })), true);
    assert.equal(isSameOrigin(request("login", {}, undefined, {
      "x-forwarded-host": "attacker.example", origin: "http://attacker.example",
    })), false);
    for (const action of [handlers.signup, handlers.login, handlers.logout]) {
      const response = await action(request("unused", {}, undefined, { origin: "null" }));
      assert.equal(response.status, 403);
    }
    const short = await handlers.signup(request("signup", { email: "user@example.com", password: "short" }));
    assert.equal(short.status, 400);
    const long = await handlers.signup(request("signup", { email: "user@example.com", password: "a".repeat(129) }));
    assert.equal(long.status, 400);
    const invalidEmail = await handlers.signup(request("signup", { email: "not-an-email", password }));
    assert.equal(invalidEmail.status, 400);
    const unsupported = await handlers.signup(request("signup", {}, undefined, { "content-type": "text/plain" }));
    assert.equal(unsupported.status, 415);
    const oversized = await handlers.signup(request("signup", { email: "user@example.com", password: "a".repeat(5000) }));
    assert.equal(oversized.status, 413);
    const malformed = new Request(`${origin}/api/auth/signup`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" });
    assert.equal((await handlers.signup(malformed)).status, 400);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
  } finally {
    store.close();
  }
});

test("rate limits expire, cap key storage, and auth returns 429 with a retry delay", async () => {
  const limiter = new RateLimiter(2, 1000, 2);
  assert.equal(limiter.consume("a", 0), true);
  assert.equal(limiter.consume("a", 1), true);
  assert.equal(limiter.consume("a", 2), false);
  assert.equal(limiter.consume("b", 2), true);
  assert.equal(limiter.consume("c", 3), false);
  assert.equal(limiter.consume("a", 1000), true);
  assert.equal(limiter.consume("c", 1002), true);
  const store = new AuthStore(":memory:");
  const handlers = createAuthHandlers(() => store, { global: new RateLimiter(1, 60000), email: new RateLimiter(1, 60000) });
  try {
    await handlers.signup(request("signup", { email: "invalid", password }));
    const blocked = await handlers.signup(request("signup", { email: "person@example.com", password }));
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));
  } finally {
    store.close();
  }
});

test("trusted admin CLI loads .env.local and promotes only an existing account", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanmap-auth-test-"));
  const path = join(directory, "configured.sqlite");
  let store = new AuthStore(path);
  try {
    store.createUser("admin@example.com", "test-hash");
    store.close();
    writeFileSync(join(directory, ".env.local"), "FANMAP_AUTH_DB=configured.sqlite\n");
    const environment = { ...process.env };
    delete environment.FANMAP_AUTH_DB;
    const script = resolve("scripts/promote-admin.ts");
    const promote = spawnSync(process.execPath, [script, " ADMIN@example.com "], {
      cwd: directory, env: environment, encoding: "utf8",
    });
    assert.equal(promote.status, 0, promote.stderr);
    store = new AuthStore(path);
    assert.equal(store.findUser("admin@example.com")?.role, "admin");
    const missing = spawnSync(process.execPath, [script, "missing@example.com"], {
      cwd: directory, env: environment, encoding: "utf8",
    });
    assert.equal(missing.status, 1);
    assert.equal(store.findUser("missing@example.com"), null);
  } finally {
    // The first handle may already be closed if a subprocess assertion failed.
    try { store.close(); } catch {}
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("fanmap-auth-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local admins sign in by username with a hashed password, while signup keeps its restrictions", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createAuthHandlers(() => store, createAuthLimits());
  try {
    const localPassword = "local-test";
    const user = store.setLocalAdmin("admin", await hashPassword(localPassword));
    assert.equal(user.username, "admin");
    assert.equal(user.role, "admin");
    assert.notEqual(store.findUser("admin")?.password_hash, localPassword);
    const login = await handlers.login(request("login", { email: " ADMIN ", password: localPassword }));
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { user });
    const cookie = sessionCookie(login);
    assert.deepEqual(await (await handlers.session(request("session", undefined, cookie))).json(), { user });
    assert.equal((await handlers.login(request("login", { email: "admin", password: "wrong" }))).status, 401);
    assert.equal((await handlers.signup(request("signup", { email: "admin", password }))).status, 400);
    assert.equal((await handlers.signup(request("signup", { email: "new@example.com", password: localPassword }))).status, 400);
    assert.equal((await handlers.signup(request("signup", { email: "new@example.com", password, username: "admin" }))).status, 400);
    const reset = store.setLocalAdmin("ADMIN", await hashPassword("replacement"));
    assert.equal(reset.id, user.id);
    assert.deepEqual(await (await handlers.session(request("session", undefined, cookie))).json(), { user: null });
  } finally {
    store.close();
  }
});
