import assert from "node:assert/strict";
import { test } from "node:test";
import plan from "../data/navigation/parking-lots.json" with { type: "json" };
import { readPlaceState } from "../lib/places-repository.ts";
import { coordinateToPixel, pixelToCoordinate, referenceRegistration } from "../lib/navigation/reference.ts";
import { distanceMetres } from "../lib/navigation/campus-router.ts";

test("every numbered parking lot on the supplied plan is available in the app, including both Lot 7 sections", async () => {
  assert.equal(plan.imageSha256, referenceRegistration.imageSha256);
  assert.deepEqual([...new Set(plan.lots.map((lot) => lot.number))].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i + 1));
  assert.equal(plan.lots.length, 12);
  assert.equal(new Set(plan.lots.map((lot) => lot.id)).size, plan.lots.length);
  const { places } = await readPlaceState();
  for (const lot of plan.lots) {
    const place = places.find((item) => item.properties.id === lot.id)!;
    assert.ok(place?.geometry, lot.id);
    assert.equal(place.properties.category, "parking");
    const pixel = coordinateToPixel(place.geometry.coordinates);
    assert.ok(Math.hypot(pixel[0] - lot.pixel[0], pixel[1] - lot.pixel[1]) < 0.001, lot.id);
    assert.ok(place.properties.sourceIds?.includes("user-campus-plan"));
  }
  const west = places.find((place) => place.properties.id === "lot-7")!;
  const east = places.find((place) => place.properties.id === "lot-7-east")!;
  assert.ok(distanceMetres(west.geometry!.coordinates, east.geometry!.coordinates) > 70);
});

test("new lot pins await pedestrian access review while Lot 5 retains its existing mapped access", async () => {
  const { places } = await readPlaceState();
  for (const lot of plan.lots.filter((item) => item.id !== "lot-5")) {
    const place = places.find((item) => item.properties.id === lot.id)!;
    assert.equal(place.properties.navigationStatus, "pending-access-review", lot.id);
    assert.equal(place.properties.navigationCoordinates, undefined, "Do not invent a pedestrian exit at the lot centroid");
  }
  const lot5 = places.find((item) => item.properties.id === "lot-5")!;
  assert.notEqual(lot5.properties.navigationStatus, "pending-access-review");
  assert.ok(distanceMetres(lot5.properties.navigationCoordinates!, pixelToCoordinate([118, 252])) < 0.1);
});
