import assert from "node:assert/strict";
import { test } from "node:test";
import { campusNetwork, distanceMetres, findCampusRoute } from "../lib/navigation/campus-router.ts";
import type { Coordinate } from "../lib/navigation/directions.ts";
import { pixelToCoordinate } from "../lib/navigation/reference.ts";
import { createWalkReplay, type WalkReplay } from "../lib/navigation/walk-replay.ts";
import { createWalkTracker } from "../lib/navigation/walk-tracker.ts";

// Integrate the simulated inertial readings without graph matching. This
// independently verifies signs and distance units against the traced endpoints.
function deadReckon(replay: WalkReplay): Coordinate {
  const position: Coordinate = [...replay.anchor];
  let heading = replay.initialBearingDegrees;
  for (const event of replay.events) {
    if (event.type !== "step") continue;
    heading += event.relativeTurnDegrees;
    const angle = heading * Math.PI / 180;
    position[0] += event.distanceMetres * Math.sin(angle) / (111195 * Math.cos(position[1] * Math.PI / 180));
    position[1] += event.distanceMetres * Math.cos(angle) / 111195;
  }
  return position;
}

test("both replays navigate to D; the wrong-turn walker actually takes B's western atrium branch", () => {
  const guided = createWalkReplay("guided");
  const detour = createWalkReplay("wrong-turn");
  assert.deepEqual(guided.anchor, detour.anchor);
  assert.deepEqual(guided.destination, detour.destination);
  const route = findCampusRoute(guided.anchor, guided.destination);
  assert.ok(route?.steps.some((step) => step.instruction === "Continue through the indoor B-D connection"));
  assert.ok(distanceMetres(deadReckon(guided), guided.destination) < 3);
  assert.ok(distanceMetres(deadReckon(detour), pixelToCoordinate([352, 435])) < 3);
  assert.ok(distanceMetres(deadReckon(detour), detour.destination) > 130);
});

test("indoor replay includes a weak fix, a signal loss and a stationary interval with no steps", () => {
  for (const scenario of ["guided", "wrong-turn"] as const) {
    const replay = createWalkReplay(scenario);
    assert.deepEqual(replay, createWalkReplay(scenario));
    const points = replay.events;
    assert.ok(points.every((event, index) => !index || event.atMs > points[index - 1].atMs));
    assert.ok(points.some((event) => event.type === "gps-lost"));
    const fixes = points.filter((event) => event.type === "fix");
    assert.equal(fixes.length, 2);
    assert.ok(fixes[1].accuracyMetres >= 50, "A weak indoor fix must carry its uncertainty");
    const pause = points.findIndex((event) => event.type === "pause");
    assert.ok(pause > 0 && points[pause + 1].type === "resume");
    assert.ok(points[pause + 1].atMs - points[pause].atMs >= 5_000);
    for (const event of points.filter((item) => item.type === "step")) {
      assert.ok(event.distanceMetres > 0.4 && event.distanceMetres < 1.0);
      assert.ok(!("coordinate" in event || "edgeId" in event), "Motion samples cannot reveal the scripted location");
    }
  }
});

test("the live tracker follows the walked branch in each synthetic replay without receiving the route", () => {
  for (const scenario of ["guided", "wrong-turn"] as const) {
    const replay = createWalkReplay(scenario);
    const tracker = createWalkTracker(replay.anchor, { initialBearing: replay.initialBearingDegrees });
    for (const event of replay.events) {
      if (event.type === "step") tracker.step(event.distanceMetres, event.relativeTurnDegrees);
      if (event.type === "fix") {
        const before = tracker.snapshot().coordinate;
        tracker.fix(event.coordinate, event.accuracyMetres);
        if (event.accuracyMetres > 50) assert.ok(distanceMetres(before, tracker.snapshot().coordinate) < 1);
      }
    }
    const estimate = tracker.snapshot();
    assert.equal(estimate.status, "tracking");
    const walkedEdge = campusNetwork.edges.find((edge) => edge.id === estimate.edgeId);
    if (scenario === "guided") {
      assert.ok(walkedEdge?.buildings.includes("D"));
      assert.ok(distanceMetres(estimate.coordinate, replay.destination) < 4);
    } else {
      assert.equal(walkedEdge?.sourceId, "B-atrium-west");
      assert.ok(distanceMetres(estimate.coordinate, pixelToCoordinate([352, 435])) < 4);
    }
  }
});
