import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { deletePlace, readPlaceState, savePlace } from "../lib/places-repository.ts";
import type { PlaceFiles } from "../lib/places-repository.ts";
import type { LocationFeature } from "../lib/place-types.ts";
import { getLaunchLocationIds } from "../lib/favorites/locations.ts";

async function fixture(run: (files: PlaceFiles) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "fanmap-places-test-"));
  const files = {
    placesFile: join(directory, "places.json"),
    deletedPlaceIdsFile: join(directory, "deleted.json"),
    launchFile: join(directory, "launch.geojson"),
  };
  const pending: LocationFeature = {
    type: "Feature",
    properties: { id: "registrar", name: "Registrar", category: "service", description: "Room E1012" },
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
