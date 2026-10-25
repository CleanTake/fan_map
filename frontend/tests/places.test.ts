import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { deletePlace, readPlaceState, savePlace, updatePlace } from "../lib/places-repository.ts";
import type { PlaceFiles } from "../lib/places-repository.ts";
import type { LocationFeature } from "../lib/place-types.ts";
import { getLaunchLocationIds } from "../lib/favorites/locations.ts";
import { AuthStore } from "../lib/auth/database.ts";
import { createPlaceHandlers } from "../lib/places-http.ts";

async function fixture(run: (files: PlaceFiles) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "fanmap-places-test-"));
  const files = {
    placesFile: join(directory, "places.json"),
    deletedPlaceIdsFile: join(directory, "deleted.json"),
    overridesFile: join(directory, "overrides.json"),
    launchFile: join(directory, "launch.geojson"),
  };
  const pending: LocationFeature = {
    type: "Feature",
    properties: { id: "registrar", name: "Registrar", category: "service", description: "Room E1012", sourceIds: ["campus-catalog"], roomCode: "E1012" },
    geometry: null,
  };
  const stored: LocationFeature = {
    type: "Feature",
    properties: { id: "main-building", name: "Existing main place", category: "building", description: "Existing point" },
    geometry: { type: "Point", coordinates: [-81.1994, 43.013] },
  };
  await writeFile(files.launchFile, JSON.stringify({ type: "FeatureCollection", features: [pending] }));
  await writeFile(files.placesFile, JSON.stringify([stored]));
  try {
    await run(files);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("fanmap-places-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("catalog nulls and main's stored points remain usable after an admin add and delete", async () => {
  await fixture(async (files) => {
    const created = await savePlace({ name: "New room", category: "room", description: "Added on the map", coordinates: [-81.2, 43.01] }, files);
    let state = await readPlaceState(files);
    assert.equal(state.places.length, 3);
    assert.equal(state.places.find((place) => place.properties.id === "registrar")?.geometry, null);
    assert.deepEqual(state.places.find((place) => place.properties.id === "main-building")?.geometry, { type: "Point", coordinates: [-81.1994, 43.013] });
    assert.ok((await getLaunchLocationIds(files)).has(created.properties.id));
    assert.ok((await getLaunchLocationIds(files)).has("registrar"));

    await deletePlace(created.properties.id, files);
    await deletePlace("registrar", files);
    state = await readPlaceState(files);
    assert.deepEqual(state.places.map((place) => place.properties.id), ["main-building"]);
    assert.equal((await getLaunchLocationIds(files)).has(created.properties.id), false);
    assert.equal((await getLaunchLocationIds(files)).has("registrar"), false);
    // Deleting a curated location affects visibility, never the source catalog.
    assert.equal(JSON.parse(await readFile(files.launchFile, "utf8")).features[0].geometry, null);
  });
});

test("edits persist for stored and curated places without changing IDs or catalog metadata", async () => {
  await fixture(async (files) => {
    const catalogBefore = await readFile(files.launchFile, "utf8");
    const storedBefore = await readFile(files.placesFile, "utf8");
    const updated = await updatePlace("registrar", { name: "Updated registrar", category: "service", description: "New description", coordinates: [-81.2, 43.01] }, files);
    assert.equal(updated?.properties.id, "registrar");
    assert.deepEqual(updated?.properties.sourceIds, ["campus-catalog"]);
    assert.equal(updated?.properties.roomCode, "E1012");
    assert.deepEqual(updated?.geometry, { type: "Point", coordinates: [-81.2, 43.01] });
    assert.deepEqual((await readPlaceState(files)).places.find((place) => place.properties.id === "registrar"), updated);
    assert.equal(await readFile(files.launchFile, "utf8"), catalogBefore);
    await updatePlace("main-building", { name: "Renamed building", category: "building", description: "Updated", coordinates: null }, files);
    assert.equal((await readPlaceState(files)).places.find((place) => place.properties.id === "main-building")?.geometry, null);
    assert.equal(await readFile(files.placesFile, "utf8"), storedBefore);
    assert.ok((await getLaunchLocationIds(files)).has("registrar"));
    await deletePlace("registrar", files);
    assert.equal(await updatePlace("registrar", { name: "Revive", category: "service", description: "", coordinates: null }, files), null);
    const tombstones = await readFile(files.deletedPlaceIdsFile, "utf8");
    assert.equal(await deletePlace("does-not-exist", files), false);
    assert.equal(await deletePlace("registrar", files), false);
    assert.equal(await readFile(files.deletedPlaceIdsFile, "utf8"), tombstones);
  });
});

test("concurrent admin additions and edits do not overwrite each other", async () => {
  await fixture(async (files) => {
    const additions = await Promise.all(Array.from({ length: 5 }, (_, index) => savePlace({ name: `Room ${index}`, category: "room", description: "", coordinates: [-81.2, 43.01] }, files)));
    await Promise.all(additions.map((place) => updatePlace(place.properties.id, { name: `${place.properties.name} updated`, category: "service", description: "Changed", coordinates: [-81.21, 43.02] }, files)));
    const places = (await readPlaceState(files)).places;
    assert.equal(places.length, 7);
    for (const added of additions) assert.equal(places.find((place) => place.properties.id === added.properties.id)?.properties.name, `${added.properties.name} updated`);
  });
});

test("place APIs enforce account roles, origins, validation and persisted CRUD", async () => {
  await fixture(async (files) => {
    const store = new AuthStore(":memory:");
    const handlers = createPlaceHandlers(() => store, files);
    const origin = "http://localhost:3000";
    const input = { name: "Test location", category: "room", description: "Added", coordinates: [-81.2, 43.01] };
    function request(method: string, token?: string, body?: unknown, id = "main-building", extraHeaders = {}) {
      return new Request(`${origin}/api/places?id=${id}`, {
        method,
        headers: { origin, "content-type": "application/json", ...(token ? { cookie: `fanmap_session=${token}` } : {}), ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    try {
      const regular = store.createUser("regular@example.com", "test-hash");
      const admin = store.setLocalAdmin("admin", "test-hash");
      const registeredToken = store.createSession(regular.id).token;
      const adminToken = store.createSession(admin.id).token;
      const expiredToken = store.createSession(admin.id, 0).token;
      for (const [method, action] of [["POST", handlers.add], ["PATCH", handlers.update], ["DELETE", handlers.remove]] as const) {
        assert.equal((await action(request(method, undefined, input))).status, 401);
        assert.equal((await action(request(method, registeredToken, input))).status, 403);
        assert.equal((await action(request(method, expiredToken, input))).status, 401);
        assert.equal((await action(request(method, undefined, input, "main-building", { Authorization: "Bearer old-admin-key" }))).status, 401);
        assert.equal((await action(request(method, adminToken, input, "main-building", { origin: "https://foreign.example" }))).status, 403);
        assert.equal((await action(request(method, adminToken, input, "main-building", { "sec-fetch-site": "cross-site" }))).status, 403);
      }
      assert.equal((await handlers.list()).status, 200);
      for (const bad of [null, [], {}, { ...input, coordinates: ["-81", 43] }, { ...input, coordinates: [0, 91] }, { ...input, coordinates: [0, 0, 0] }, { ...input, name: " " }, { ...input, id: "override-id" }]) {
        assert.equal((await handlers.add(request("POST", adminToken, bad))).status, 400);
        assert.equal((await handlers.update(request("PATCH", adminToken, bad))).status, 400);
      }
      assert.equal((await handlers.add(request("POST", adminToken, { ...input, coordinates: null }))).status, 400);
      assert.equal((await handlers.add(request("POST", adminToken, input, "unused", { "content-type": "text/plain" }))).status, 415);
      assert.equal((await handlers.add(request("POST", adminToken, { ...input, description: "x".repeat(5000) }))).status, 413);
      const createdResponse = await handlers.add(request("POST", adminToken, input));
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      store.addFavorite(regular.id, created.properties.id);
      const edit = await handlers.update(request("PATCH", adminToken, { ...input, name: "Edited", category: "food", coordinates: [-81.21, 43.02] }, created.properties.id));
      assert.equal(edit.status, 200);
      assert.equal((await edit.json()).properties.id, created.properties.id);
      assert.deepEqual(store.listFavoriteIds(regular.id), [created.properties.id]);
      const list = await (await handlers.list()).json();
      assert.equal(list.places.find((place: LocationFeature) => place.properties.id === created.properties.id)?.properties.name, "Edited");
      assert.equal((await handlers.update(request("PATCH", adminToken, { ...input, coordinates: null }, "registrar"))).status, 200);
      assert.equal((await handlers.remove(request("DELETE", adminToken, undefined, created.properties.id))).status, 204);
      assert.equal((await getLaunchLocationIds(files)).has(created.properties.id), false);
      assert.equal((await handlers.update(request("PATCH", adminToken, input, created.properties.id))).status, 404);
      assert.equal((await handlers.remove(request("DELETE", adminToken, undefined, "missing"))).status, 404);
      store.database.prepare("UPDATE users SET role = 'registered' WHERE id = ?").run(admin.id);
      assert.equal((await handlers.add(request("POST", adminToken, input))).status, 403);
      store.revokeSession(adminToken);
      assert.equal((await handlers.add(request("POST", adminToken, input))).status, 401);
    } finally {
      store.close();
    }
  });
});

test("a stored duplicate cannot supply coordinates for a pending catalog location or revive a deleted ID", async () => {
  await fixture(async (files) => {
    const duplicate = { type: "Feature", properties: { id: "registrar", name: "Old registrar", category: "service", description: "Old estimate" }, geometry: { type: "Point", coordinates: [-81.2, 43.01] } };
    await writeFile(files.placesFile, JSON.stringify([duplicate]));
    assert.equal((await readPlaceState(files)).places[0].geometry, null);
    await deletePlace("registrar", files);
    assert.deepEqual((await readPlaceState(files)).places, []);
    assert.equal((await getLaunchLocationIds(files)).has("registrar"), false);
  });
});
