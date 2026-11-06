import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { AuthStore, getAuthStore, SESSION_COOKIE, SESSION_MAX_AGE } from "../lib/auth/database.ts";
import { RateLimiter } from "../lib/auth/limiter.ts";
import { createFavoriteHandlers } from "../lib/favorites/http.ts";
import { getLaunchLocationIds } from "../lib/favorites/locations.ts";

const origin = "http://localhost:3000";
const knownIds = new Set(["office-of-the-registrar", "library"]);

function request(method = "GET", cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/favorites`, {
    method,
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function signIn(store: AuthStore, email: string) {
  const user = store.createUser(email, "test-hash");
  const session = store.createSession(user.id);
  return { user, cookie: `${SESSION_COOKIE}=${session.token}`, session };
}

function removeTestDirectory(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(directory.includes("fanmap-favorites-test-"));
  rmSync(directory, { recursive: true, force: true });
}

test("guests and invalid, expired, revoked sessions cannot list or mutate saved locations", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, () => knownIds);
  try {
    const { user, cookie, session } = signIn(store, "registered@example.com");
    const expired = store.createSession(user.id, Date.now() - SESSION_MAX_AGE * 1000);
    store.revokeSession(session.token);
    const cookies = [undefined, `${SESSION_COOKIE}=forged`, cookie, `${SESSION_COOKIE}=${expired.token}`];
    for (const rejectedCookie of cookies) {
      const responses = [
        await handlers.list(request("GET", rejectedCookie)),
        await handlers.add(request("PUT", rejectedCookie, { locationId: "library" })),
        await handlers.remove(request("DELETE", rejectedCookie, { locationId: "library" })),
      ];
      for (const response of responses) {
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    }
    assert.deepEqual(store.listFavoriteIds(user.id), []);
  } finally {
    store.close();
  }
});

test("saved locations are private to each account and saves/removals are idempotent", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, () => knownIds);
  try {
    const first = signIn(store, "first@example.com");
    const second = signIn(store, "second@example.com");
    assert.deepEqual(await (await handlers.list(request("GET", first.cookie))).json(), { locationIds: [] });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const saved = await handlers.add(request("PUT", first.cookie, { locationId: "library" }));
      assert.equal(saved.status, 200);
      assert.equal(saved.headers.get("cache-control"), "no-store");
      assert.equal(saved.headers.get("vary"), "Cookie");
      assert.deepEqual(await saved.json(), { locationIds: ["library"] });
    }
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM favorites").get()?.count, 1);
    assert.deepEqual(await (await handlers.list(request("GET", second.cookie))).json(), { locationIds: [] });
    await handlers.remove(request("DELETE", second.cookie, { locationId: "library" }));
    assert.deepEqual(store.listFavoriteIds(first.user.id), ["library"]);
    await handlers.add(request("PUT", second.cookie, { locationId: "office-of-the-registrar" }));

    for (let repeat = 0; repeat < 2; repeat += 1) {
      const removed = await handlers.remove(request("DELETE", first.cookie, { locationId: "library" }));
      assert.equal(removed.status, 200);
      assert.deepEqual(await removed.json(), { locationIds: [] });
    }
    assert.deepEqual(store.listFavoriteIds(second.user.id), ["office-of-the-registrar"]);
    store.addFavorite(first.user.id, "obsolete-location");
    const removedOld = await handlers.remove(request("DELETE", first.cookie, { locationId: "obsolete-location" }));
    assert.deepEqual(await removedOld.json(), { locationIds: [] });
  } finally {
    store.close();
  }
});

test("registered users and admins can save catalog locations with pending coordinates", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, getLaunchLocationIds);
  try {
    const { cookie, user } = signIn(store, "admin@example.com");
    assert.equal(store.promoteAdmin(user.email), true);
    assert.equal(store.findSession(cookie.slice(SESSION_COOKIE.length + 1))?.role, "admin");
    // This launch catalog entry currently has geometry: null; location IDs are authoritative.
    const response = await handlers.add(request("PUT", cookie, { locationId: "office-of-the-registrar" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { locationIds: ["office-of-the-registrar"] });
  } finally {
    store.close();
  }
});

test("malformed, injected, unknown, and oversized location requests never write favorites", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, () => knownIds);
  try {
    const { cookie, user } = signIn(store, "validation@example.com");
    for (const body of [
      null, [], {}, { locationId: 1 }, { locationId: "" }, { locationId: "a".repeat(129) },
      { locationId: " library" }, { locationId: "unknown-location" },
      { locationId: "library", userId: "another-user" }, { locationId: "library", role: "admin" },
    ]) {
      assert.equal((await handlers.add(request("PUT", cookie, body))).status, 400);
    }
    const malformed = new Request(`${origin}/api/favorites`, {
      method: "PUT", headers: { origin, cookie, "content-type": "application/json" }, body: "{",
    });
    assert.equal((await handlers.add(malformed)).status, 400);
    assert.equal((await handlers.add(request("PUT", cookie))).status, 415);
    assert.equal((await handlers.add(request("PUT", cookie, { locationId: "library" }, { "content-type": "text/plain" }))).status, 415);
    assert.equal((await handlers.add(request("PUT", cookie, { locationId: "library" }, { "content-length": "2048" }))).status, 413);
    // No declared length: the streamed bytes still have to stay within the body limit.
    assert.equal((await handlers.add(request("PUT", cookie, { locationId: "a".repeat(1100) }))).status, 413);
    const forgedDelete = await handlers.remove(request("DELETE", cookie, { locationId: "library", userId: "another-user" }));
    assert.equal(forgedDelete.status, 400);
    assert.deepEqual(store.listFavoriteIds(user.id), []);
  } finally {
    store.close();
  }
});

test("cross-origin saves and removals are rejected without changing an account's favorites", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, () => knownIds);
  try {
    const { cookie, user } = signIn(store, "origin@example.com");
    store.addFavorite(user.id, "library");
    const invalidHeaders: Record<string, string>[] = [
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:3000/path" }, { origin: "null" }, { origin: "" },
      { "sec-fetch-site": "same-site" }, { origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
    ];
    for (const headers of invalidHeaders) {
      for (const mutate of [handlers.add, handlers.remove]) {
        assert.equal((await mutate(request("PUT", cookie, { locationId: "library" }, headers))).status, 403);
      }
    }
    assert.deepEqual(store.listFavoriteIds(user.id), ["library"]);
  } finally {
    store.close();
  }
});

test("mutation rate limits apply per account before database writes", async () => {
  const store = new AuthStore(":memory:");
  const handlers = createFavoriteHandlers(() => store, () => knownIds, new RateLimiter(1, 60 * 1000));
  try {
    const first = signIn(store, "limited@example.com");
    const second = signIn(store, "unlimited@example.com");
    assert.equal((await handlers.add(request("PUT", first.cookie, { locationId: "library" }))).status, 200);
    const limited = await handlers.remove(request("DELETE", first.cookie, { locationId: "library" }));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.deepEqual(store.listFavoriteIds(first.user.id), ["library"]);
    assert.equal((await handlers.add(request("PUT", second.cookie, { locationId: "library" }))).status, 200);
    assert.equal((await handlers.list(request("GET", first.cookie))).status, 200);
  } finally {
    store.close();
  }
});

test("SQLite persists saved locations across restarts and deletes them with their account", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanmap-favorites-test-"));
  const path = join(directory, "auth.sqlite");
  let store = new AuthStore(path);
  try {
    const first = signIn(store, "persistent@example.com");
    const second = signIn(store, "other@example.com");
    store.addFavorite(first.user.id, "library");
    store.addFavorite(second.user.id, "library");
    store.close();
    store = new AuthStore(path);
    assert.deepEqual(store.listFavoriteIds(first.user.id), ["library"]);
    assert.deepEqual(store.listFavoriteIds(second.user.id), ["library"]);
    assert.throws(() => store.addFavorite("missing-user", "library"));
    store.database.prepare("DELETE FROM users WHERE id = ?").run(first.user.id);
    assert.deepEqual(store.listFavoriteIds(first.user.id), []);
    assert.equal(store.findSession(first.session.token), null);
    assert.deepEqual(store.listFavoriteIds(second.user.id), ["library"]);
  } finally {
    store.close();
    removeTestDirectory(directory);
  }
});

test("an existing auth database and hot-reloaded store gain favorites without losing users or sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanmap-favorites-test-"));
  const path = join(directory, "auth.sqlite");
  const oldStore = new AuthStore(path);
  const shared = globalThis as typeof globalThis & {
    fanmapAuthStore?: { path: string; version?: number; store: AuthStore };
  };
  const previousShared = shared.fanmapAuthStore;
  const previousPath = process.env.FANMAP_AUTH_DB;
  let currentStore: AuthStore | undefined;
  try {
    const { user, session } = signIn(oldStore, "existing@example.com");
    oldStore.database.exec("DROP TABLE favorites");
    process.env.FANMAP_AUTH_DB = path;
    shared.fanmapAuthStore = { path: resolve(path), store: oldStore };
    currentStore = getAuthStore();
    assert.notEqual(currentStore, oldStore);
    assert.deepEqual(currentStore.findSession(session.token), user);
    assert.deepEqual(currentStore.listFavoriteIds(user.id), []);
    currentStore.addFavorite(user.id, "library");
    assert.deepEqual(currentStore.listFavoriteIds(user.id), ["library"]);
    assert.equal(getAuthStore(), currentStore);
  } finally {
    if (currentStore) currentStore.close();
    else { try { oldStore.close(); } catch {} }
    shared.fanmapAuthStore = previousShared;
    if (previousPath === undefined) delete process.env.FANMAP_AUTH_DB;
    else process.env.FANMAP_AUTH_DB = previousPath;
    removeTestDirectory(directory);
  }
});
