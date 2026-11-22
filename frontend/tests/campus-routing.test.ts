import assert from "node:assert/strict";
import { test } from "node:test";
import { campusNetwork, distanceMetres, findCampusRoute, requestWalkingDirections } from "../lib/navigation/campus-router.ts";
import { pixelToCoordinate as pixel } from "../lib/navigation/reference.ts";
import { readPlaceState } from "../lib/places-repository.ts";

test("C-D routing exits one door, crosses a short outdoor link, and enters the other", () => {
  const route = findCampusRoute(pixel([291, 340]), pixel([449, 350]));
  assert.ok(route);
  const instructions = route.steps.map((step) => step.instruction);
  const exit = instructions.indexOf("Exit C through the nearby door");
  assert.ok(exit >= 0);
  assert.match(instructions[exit + 1], /short outdoor connection/);
  assert.equal(instructions[exit + 2], "Enter D through the nearby door");
  assert.ok(route.distanceMetres - route.indoorDistanceMetres! < 15);
  const reverse = findCampusRoute(pixel([449, 350]), pixel([291, 340]));
  assert.ok(reverse?.steps.some((step) => step.instruction === "Exit D through the nearby door"));
  assert.ok(reverse?.steps.some((step) => step.instruction === "Enter C through the nearby door"));
});

test("B-D and H-M are continuous indoor routes with no invented outdoor doorway", () => {
  for (const [start, end, label] of [[[352, 394], [449, 379], "Continue through the indoor B-D connection"], [[590, 242], [639, 215], "Continue along the door-free H-M corridor"]] as const) {
    const route = findCampusRoute(pixel(start), pixel(end));
    assert.ok(route);
    assert.ok(route.steps.some((step) => step.instruction === label));
    assert.ok(route.segments!.every((segment) => segment.kind === "indoor"));
  }
});

test("F uses its east corridor to D and G uses its enclosed connection", () => {
  const east = findCampusRoute(pixel([531, 300]), pixel([511, 350]));
  assert.ok(east);
  assert.ok(east.segments!.every((segment) => segment.kind === "indoor"));
  assert.ok(east.geometry.coordinates.some((point) => distanceMetres(point, pixel([531, 325])) < 1));
  const enclosed = findCampusRoute(pixel([468, 224]), pixel([521, 281]));
  assert.ok(enclosed);
  assert.ok(enclosed.steps.some((step) => step.instruction.includes("enclosed G / F / L")));
  assert.ok(enclosed.segments!.every((segment) => segment.kind === "indoor"));
});

test("a campus route combines corridors and the Lot 5 pedestrian approach without a Mapbox call", async () => {
  let calls = 0;
  const route = await requestWalkingDirections(pixel([531, 300]), pixel([118, 252]), "", { fetcher: (async () => { calls++; throw new Error("Unexpected provider request"); }) as typeof fetch });
  assert.equal(calls, 0);
  assert.equal(route.source, "campus");
  assert.equal(route.approximate, true);
  assert.ok(route.distanceMetres < 700);
  assert.ok(route.indoorDistanceMetres! > 300);
  assert.ok(route.steps.some((step) => step.instruction === "Parking Lot 5 south pedestrian path"));
});

test("same-edge endpoints route directly; geometric crossings alone do not connect networks", () => {
  const a = [-81.2, 43.013], b = [-81.199, 43.013];
  const base = { nodes: { a, b }, edges: [{ id: "ab", from: "a", to: "b", kind: "outdoor" as const, label: "Path", buildings: [], lengthMetres: distanceMetres(a, b) }], buildings: [] };
  const route = findCampusRoute([-81.1998, 43.013], [-81.1992, 43.013], base);
  assert.ok(route);
  assert.ok(Math.abs(route.distanceMetres - base.edges[0].lengthMetres * 0.6) < 0.01);
  const disconnected = { nodes: { a: [-81.201, 43.013], b: [-81.199, 43.013], c: [-81.2, 43.012], d: [-81.2, 43.014] }, edges: [{ ...base.edges[0], from: "a", to: "b" }, { ...base.edges[0], id: "cd", from: "c", to: "d" }], buildings: [] };
  assert.equal(findCampusRoute([-81.201, 43.013], [-81.2, 43.014], disconnected), null);
});

test("compiled network IDs are unique and every connection has real endpoints", () => {
  assert.equal(new Set(campusNetwork.edges.map((edge) => edge.id)).size, campusNetwork.edges.length);
  for (const edge of campusNetwork.edges) {
    assert.ok(campusNetwork.nodes[edge.from]); assert.ok(campusNetwork.nodes[edge.to]);
    assert.ok(Number.isFinite(edge.lengthMetres) && edge.lengthMetres > 0);
  }
});

test("Student Services is removed and Lot 5 has a corrected pin and a separate pedestrian access", async () => {
  const { places, deletedIds } = await readPlaceState();
  assert.ok(deletedIds.includes("student-services"));
  assert.ok(!places.some((place) => place.properties.id === "student-services"));
  const lot = places.find((place) => place.properties.id === "lot-5")!;
  assert.ok(lot.geometry);
  assert.ok(distanceMetres(lot.geometry.coordinates, pixel([118, 228])) < 1);
  assert.ok(distanceMetres(lot.properties.navigationCoordinates!, pixel([118, 252])) < 1);
  const building = places.find((place) => place.properties.name === "Building A")!;
  assert.ok(building.geometry);
  assert.ok(distanceMetres(building.geometry.coordinates, pixel([575, 425])) < 1);
  assert.ok(distanceMetres(building.properties.navigationCoordinates!, pixel([565, 418])) < 1);
});

test("locations outside the campus network fall back to the provider; aborted requests stop", async () => {
  let called = false;
  const route = await requestWalkingDirections([-79.4, 43.7], [-79.399, 43.701], "token", { fetcher: (async () => {
    called = true;
    return Response.json({ code: "Ok", routes: [{ distance: 150, duration: 120, geometry: { type: "LineString", coordinates: [[-79.4, 43.7], [-79.399, 43.701]] }, legs: [] }], waypoints: [{ location: [-79.4, 43.7], distance: 0 }, { location: [-79.399, 43.701], distance: 0 }] });
  }) as typeof fetch });
  assert.ok(called); assert.equal(route.source, "mapbox");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestWalkingDirections(pixel([291, 340]), pixel([449, 350]), "", { signal: controller.signal }), { name: "AbortError" });
});
