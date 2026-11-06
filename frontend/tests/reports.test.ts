import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { AuthStore, getAuthStore } from "../lib/auth/database.ts";
import { RateLimiter } from "../lib/auth/limiter.ts";
import { createReportHandlers } from "../lib/reports/http.ts";
import { createReport, listReports, setReportStatus } from "../lib/reports/repository.ts";
import type { LocationFeature } from "../lib/place-types.ts";

const origin = "http://localhost:3000";
const location: LocationFeature = {
  type: "Feature", geometry: null,
  properties: { id: "registrar", name: "Registrar", category: "service", description: "Room E1012" },
};
const reportBody = { locationId: location.properties.id, message: "The office has moved to the next hallway." };

function request(method: string, token?: string, body?: unknown, query = "", headers = {}) {
  return new Request(`${origin}/api/reports${query}`, {
    method,
    headers: { origin, "content-type": "application/json", ...(token ? { cookie: `fanmap_session=${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fixture() {
  const store = new AuthStore(":memory:");
  const regular = store.createUser("reporter@example.com", "test-hash");
  const admin = store.setLocalAdmin("admin", "test-hash");
  const regularToken = store.createSession(regular.id).token;
  const adminToken = store.createSession(admin.id).token;
  let places = [location];
  const handlers = createReportHandlers(() => store, async () => places, {
    global: new RateLimiter(1000, 60000), submitter: new RateLimiter(1000, 60000),
  });
  return { store, handlers, regular, admin, regularToken, adminToken, setLocations: (value: LocationFeature[]) => { places = value; } };
}

test("guests and registered users can report an active location; admins cannot submit", async () => {
  const { store, handlers, regular, regularToken, adminToken } = fixture();
  try {
    const guest = await handlers.submit(request("POST", undefined, reportBody));
    assert.equal(guest.status, 201);
    assert.equal(guest.headers.get("cache-control"), "no-store");
    const receipt = await guest.json();
    assert.deepEqual(Object.keys(receipt).sort(), ["id", "status"]);
    assert.equal(receipt.status, "open");
    const user = await handlers.submit(request("POST", regularToken, { ...reportBody, message: "  The map pin is on the wrong building.  " }));
    assert.equal(user.status, 201);
    assert.equal((await handlers.submit(request("POST", adminToken, reportBody))).status, 403);
    const reports = listReports(store, "open", 1);
    assert.equal(reports.total, 2);
    assert.equal(Object.getPrototypeOf(reports.reports[0]), Object.prototype, "Reports must serialize as Server Component props");
    assert.deepEqual(reports.reports.map((report) => report.reporterType), ["registered", "guest"]);
    assert.equal(reports.reports[0].message, "The map pin is on the wrong building.");
    assert.equal(reports.reports[0].locationName, "Registrar");
    assert.equal(store.database.prepare("SELECT reporter_user_id FROM location_reports WHERE id = ?").get((await user.json()).id)?.reporter_user_id, regular.id);
    assert.equal(store.database.prepare("SELECT reporter_user_id FROM location_reports WHERE id = ?").get(receipt.id)?.reporter_user_id, null);
  } finally { store.close(); }
});

test("only a current admin can list reports, resolve them or reopen them", async () => {
  const { store, handlers, admin, adminToken, regularToken } = fixture();
  try {
    const { id } = await (await handlers.submit(request("POST", undefined, reportBody))).json();
    const expired = store.createSession(admin.id, 0).token;
    for (const token of [undefined, "forged-session", expired, regularToken]) {
      const expected = token === regularToken ? 403 : 401;
      assert.equal((await handlers.list(request("GET", token))).status, expected);
      assert.equal((await handlers.update(request("PATCH", token, { id, status: "resolved" }))).status, expected);
    }
    const open = await handlers.list(request("GET", adminToken));
    assert.equal(open.status, 200);
    assert.equal(open.headers.get("cache-control"), "no-store");
    assert.equal(open.headers.get("vary"), "Cookie");
    assert.equal((await open.json()).reports[0].id, id);
    store.database.prepare("UPDATE location_reports SET created_at = 100, updated_at = 100 WHERE id = ?").run(id);
    const resolved = await handlers.update(request("PATCH", adminToken, { id, status: "resolved" }));
    assert.equal(resolved.status, 200);
    const updated = (await resolved.json()).report;
    assert.equal(updated.status, "resolved");
    assert.equal(updated.createdAt, 100);
    assert.ok(updated.updatedAt > 100);
    assert.equal(store.database.prepare("SELECT reviewed_by FROM location_reports WHERE id = ?").get(id)?.reviewed_by, admin.id);
    assert.equal((await (await handlers.list(request("GET", adminToken))).json()).total, 0);
    assert.equal((await (await handlers.list(request("GET", adminToken, undefined, "?status=resolved"))).json()).total, 1);
    const repeated = await handlers.update(request("PATCH", adminToken, { id, status: "resolved" }));
    assert.equal((await repeated.json()).report.updatedAt, updated.updatedAt);
    assert.equal((await handlers.update(request("PATCH", adminToken, { id, status: "open" }))).status, 200);
    assert.equal(listReports(store, "open", 1).total, 1);
    assert.equal((await handlers.update(request("PATCH", adminToken, { id: 99999, status: "resolved" }))).status, 404);
    store.database.prepare("UPDATE users SET role = 'registered' WHERE id = ?").run(admin.id);
    assert.equal((await handlers.list(request("GET", adminToken))).status, 403);
    assert.equal((await handlers.update(request("PATCH", adminToken, { id, status: "resolved" }))).status, 403);
    store.revokeSession(adminToken);
    assert.equal((await handlers.list(request("GET", adminToken))).status, 401);
  } finally { store.close(); }
});

test("invalid, foreign-origin and oversized reports cannot create or change records", async () => {
  const { store, handlers, adminToken } = fixture();
  try {
    for (const body of [null, [], {}, { ...reportBody, message: "  " }, { ...reportBody, message: "x".repeat(1001) }, { ...reportBody, locationId: "../file" }, { ...reportBody, status: "resolved" }, { ...reportBody, reporter_user_id: "someone-else" }, { ...reportBody, locationName: "Fake" }]) {
      assert.equal((await handlers.submit(request("POST", undefined, body))).status, 400);
    }
    assert.equal((await handlers.submit(request("POST", undefined, { ...reportBody, locationId: "missing" }))).status, 404);
    assert.equal((await handlers.submit(request("POST", undefined, reportBody, "", { "content-type": "text/plain" }))).status, 415);
    assert.equal((await handlers.submit(request("POST", undefined, { ...reportBody, message: "x".repeat(9000) }))).status, 413);
    const malformed = new Request(`${origin}/api/reports`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" });
    assert.equal((await handlers.submit(malformed)).status, 400);
    for (const headers of [{ origin: "https://foreign.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
      assert.equal((await handlers.submit(request("POST", undefined, reportBody, "", headers))).status, 403);
      assert.equal((await handlers.update(request("PATCH", adminToken, { id: 1, status: "resolved" }, "", headers))).status, 403);
    }
    for (const body of [null, [], {}, { id: 0, status: "open" }, { id: "1", status: "open" }, { id: 1, status: "invalid" }, { id: 1, status: "resolved", message: "tampered" }]) {
      assert.equal((await handlers.update(request("PATCH", adminToken, body))).status, 400);
    }
    for (const query of ["?status=invalid", "?page=0", "?page=-1", "?page=1.5", "?page=99999999999"]) {
      assert.equal((await handlers.list(request("GET", adminToken, undefined, query))).status, 400);
    }
    assert.equal(listReports(store, "all", 1).total, 0);
  } finally { store.close(); }
});

test("submission limits cover guests and users without blocking admin tracking", async () => {
  const { store, adminToken, regularToken } = fixture();
  const handlers = createReportHandlers(() => store, async () => [location], {
    global: new RateLimiter(3, 60000), submitter: new RateLimiter(1, 60000),
  });
  try {
    assert.equal((await handlers.submit(request("POST", undefined, reportBody))).status, 201);
    const limited = await handlers.submit(request("POST", undefined, reportBody));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal((await handlers.submit(request("POST", regularToken, reportBody))).status, 201);
    assert.equal((await handlers.submit(request("POST", regularToken, reportBody))).status, 429);
    assert.equal((await handlers.list(request("GET", adminToken))).status, 200);
    assert.equal((await handlers.update(request("PATCH", adminToken, { id: 1, status: "resolved" }))).status, 200);
  } finally { store.close(); }
});

test("report history keeps the submitted location name after map changes and paginates by status", async () => {
  const { store, handlers, admin, adminToken, setLocations } = fixture();
  try {
    for (let index = 0; index < 27; index++) createReport(store, location, `Report ${index}`, null);
    setLocations([]);
    assert.equal((await handlers.submit(request("POST", undefined, reportBody))).status, 404);
    let page = await (await handlers.list(request("GET", adminToken, undefined, "?status=all&page=1"))).json();
    assert.equal(page.reports.length, 25);
    assert.equal(page.reports[0].id, 27);
    assert.equal(page.reports[0].locationName, "Registrar");
    assert.equal(page.total, 27);
    assert.equal(page.pageCount, 2);
    page = await (await handlers.list(request("GET", adminToken, undefined, "?status=all&page=2"))).json();
    assert.deepEqual(page.reports.map((report: { id: number }) => report.id), [2, 1]);
    setReportStatus(store, 1, "resolved", admin.id);
    setReportStatus(store, 2, "resolved", admin.id);
    page = listReports(store, "open", 2);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 1);
    assert.deepEqual(page.counts, { open: 25, resolved: 2 });
  } finally { store.close(); }
});

test("report migration preserves accounts, sessions and favorites; reports survive restart and account deletion", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanmap-reports-test-"));
  const path = join(directory, "auth.sqlite");
  let store = new AuthStore(path);
  const shared = globalThis as typeof globalThis & { fanmapAuthStore?: { path: string; version: number; store: AuthStore } };
  const previousShared = shared.fanmapAuthStore;
  const previousPath = process.env.FANMAP_AUTH_DB;
  try {
    const user = store.createUser("existing@example.com", "test-hash");
    const session = store.createSession(user.id);
    store.addFavorite(user.id, location.properties.id);
    store.database.exec("DROP TABLE location_reports");
    shared.fanmapAuthStore = { path: resolve(path), version: 3, store };
    process.env.FANMAP_AUTH_DB = path;
    store = getAuthStore();
    assert.deepEqual(store.findSession(session.token), user);
    assert.deepEqual(store.listFavoriteIds(user.id), [location.properties.id]);
    const id = createReport(store, location, reportBody.message, user);
    const admin = store.setLocalAdmin("admin", "test-hash");
    setReportStatus(store, id, "resolved", admin.id);
    store.close();
    store = new AuthStore(path);
    assert.equal(listReports(store, "resolved", 1).reports[0].id, id);
    store.database.prepare("DELETE FROM users WHERE id IN (?, ?)").run(user.id, admin.id);
    const report = listReports(store, "resolved", 1).reports[0];
    assert.equal(report.reporterType, "registered");
    assert.equal(report.message, reportBody.message);
    const internal = store.database.prepare("SELECT reporter_user_id, reviewed_by FROM location_reports WHERE id = ?").get(id);
    assert.equal(internal?.reporter_user_id, null);
    assert.equal(internal?.reviewed_by, null);
  } finally {
    store.close();
    shared.fanmapAuthStore = previousShared;
    if (previousPath === undefined) delete process.env.FANMAP_AUTH_DB;
    else process.env.FANMAP_AUTH_DB = previousPath;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("fanmap-reports-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
