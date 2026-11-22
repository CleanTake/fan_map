import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import plan from "../data/navigation/campus-landmarks.json" with { type: "json" };
import { readPlaceState } from "../lib/places-repository.ts";
import { coordinateToPixel, pixelToCoordinate, referenceRegistration } from "../lib/navigation/reference.ts";
import { findCampusRoute } from "../lib/navigation/campus-router.ts";

test("labelled campus landmarks appear at their source-map positions without duplicating canonical records", async () => {
  assert.equal(plan.imageSha256, referenceRegistration.imageSha256);
  const { places } = await readPlaceState();
  for (const landmark of plan.landmarks) {
    const matches = places.filter((place) => place.properties.id === landmark.id);
    assert.equal(matches.length, 1, landmark.id);
    assert.ok(matches[0].geometry);
    const pixel = coordinateToPixel(matches[0].geometry.coordinates);
    assert.ok(Math.hypot(pixel[0] - landmark.pixel[0], pixel[1] - landmark.pixel[1]) < 0.001, landmark.id);
  }
  assert.equal(places.filter((place) => place.properties.name === "Building A").length, 1);
  for (const landmark of plan.landmarks.filter((item) => item.pendingAccess)) {
    const place = places.find((item) => item.properties.id === landmark.id)!;
    assert.equal(place.properties.navigationStatus, "pending-access-review", landmark.id);
    assert.equal(place.properties.navigationCoordinates, undefined);
  }
});

test("mapped ground-floor approaches route through the campus graph, including Forwell Hall's filename-based outline", async () => {
  const { places } = await readPlaceState();
  for (const landmark of plan.landmarks.filter((item) => item.navigationPixel)) {
    const place = places.find((item) => item.properties.id === landmark.id)!;
    const route = findCampusRoute(place.properties.navigationCoordinates!, pixelToCoordinate([565, 418]));
    assert.ok(route, landmark.id);
    assert.equal(route.source, "campus", landmark.id);
    assert.ok(route.distanceMetres > 0);
    assert.ok(route.endpointOffsets!.every((offset) => offset < 2), landmark.id);
  }
});

test("legend-only food and retail stay unmapped and existing service metadata is retained", async () => {
  const launch = JSON.parse(await readFile(new URL("../../data/launch-locations.geojson", import.meta.url), "utf8"));
  const { places } = await readPlaceState();
  for (const canonical of launch.features) {
    if (["food", "retail"].includes(canonical.properties.category)) {
      assert.equal(places.find((place) => place.properties.id === canonical.properties.id)?.geometry, null);
    }
  }
  for (const landmark of plan.landmarks.filter((item) => item.existing)) {
    const canonical = launch.features.find((place: { properties: { id: string } }) => place.properties.id === landmark.id);
    const mapped = places.find((place) => place.properties.id === landmark.id)!;
    for (const key of ["id", "name", "roomCode", "buildingCode", "floor", "status", "hours"] as const) {
      assert.deepEqual(mapped.properties[key], canonical.properties[key], `${landmark.id}: ${key}`);
    }
    assert.equal(canonical.geometry, null, "Keep generated catalog geometry unchanged");
  }
  const parking = places.find((place) => place.properties.id === "campus-parking-office-map-label")!;
  assert.match(parking.properties.description, /E2020/);
  assert.equal(parking.properties.navigationStatus, "pending-access-review");
});
