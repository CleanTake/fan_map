import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceMetres, findCampusRoute } from "../lib/navigation/campus-router.ts";
import { pixelToCoordinate } from "../lib/navigation/reference.ts";
import { createWalkGuidance, startingBearing, type WalkFrame } from "../lib/navigation/walk-guidance.ts";
import { createWalkReplay, type WalkReplayScenario } from "../lib/navigation/walk-replay.ts";

function runScenario(scenario: WalkReplayScenario) {
  const script = createWalkReplay(scenario);
  const route = findCampusRoute(script.anchor, script.destination);
  assert.ok(route);
  const guidance = createWalkGuidance(route, script.initialBearingDegrees);
  const history = script.events.map((event) => {
    let frame: WalkFrame;
    if (event.type === "step") frame = guidance.step(event.distanceMetres, event.relativeTurnDegrees);
    else if (event.type === "fix") frame = guidance.fix(event.coordinate, event.accuracyMetres);
    else frame = guidance.snapshot();
    return { event, frame };
  });
  return { route, script, history };
}

test("guided replay reports progress through B and D, holds cues during ambiguity and recognizes the destination", () => {
  const { route, history } = runScenario("guided");
  const initial = history[0].frame;
  assert.equal(initial.remaining, route.distanceMetres);
  const middle = history.map(({ frame }) => frame).find((frame) =>
    frame.instruction.startsWith("B central atrium corridor") && frame.remaining !== null && frame.remaining < 190);
  assert.ok(middle);
  const ambiguous = history.filter(({ frame }) => frame.estimate.status !== "tracking");
  assert.ok(ambiguous.length > 0);
  for (const { frame } of ambiguous) {
    assert.equal(frame.remaining, null);
    assert.match(frame.instruction, /confirm.*landmark/i);
    assert.equal(frame.nearDestination, false);
  }
  for (const [index, { event, frame }] of history.entries()) {
    if (event.type !== "resume" && event.type !== "gps-lost" && event.type !== "pause") continue;
    assert.deepEqual(frame.estimate.coordinate, history[index - 1].frame.estimate.coordinate);
    assert.equal(frame.remaining, history[index - 1].frame.remaining);
  }
  const final = history.at(-1)!.frame;
  assert.equal(final.reroutes, 0);
  assert.ok(final.nearDestination);
  assert.ok(final.remaining !== null && final.remaining < 2);
  assert.match(final.instruction, /near the mapped destination/i);
});

test("wrong-turn replay reroutes from the walked branch once per departure and keeps D as the destination", () => {
  const { route, script, history } = runScenario("wrong-turn");
  const revisions = history.filter(({ frame }, index) => index > 0 && frame.reroutes > history[index - 1].frame.reroutes);
  assert.ok(revisions.length > 0);
  const first = revisions[0].frame;
  assert.ok(!route.traversals?.some((segment) => segment.edgeId === first.estimate.edgeId));
  const edgesWithRevisions = new Set<string>();
  for (const { frame } of revisions) {
    const start = frame.route.traversals?.[0];
    assert.ok(start);
    assert.equal(start.edgeId, frame.estimate.edgeId);
    assert.ok(distanceMetres(frame.route.endpoints[0], frame.estimate.coordinate) < 0.5);
    assert.ok(distanceMetres(frame.route.endpoints[1], script.destination) < 0.5);
    // The walker continues away on each detour corridor. The same instruction
    // can remain active without replacing and refitting the route every 5 m.
    assert.ok(!edgesWithRevisions.has(start.edgeId), `Repeated reroute while continuing on ${start.edgeId}`);
    edgesWithRevisions.add(start.edgeId);
  }
  assert.ok(history.every(({ frame }) => !frame.nearDestination));
});

test("guidance measures between two interior points on a corridor in either travel direction", () => {
  for (const [fromY, toY] of [[404, 433], [433, 404]]) {
    const start = pixelToCoordinate([383, fromY]);
    const end = pixelToCoordinate([383, toY]);
    const route = findCampusRoute(start, end);
    assert.ok(route);
    const traversals = route.traversals!;
    assert.equal(traversals.length, 1);
    assert.ok(traversals[0].startOffset > 1 && traversals[0].endOffset > 1);
    assert.ok(Math.abs(route.distanceMetres - distanceMetres(start, end)) < 0.1);
    const guidance = createWalkGuidance(route, startingBearing(route));
    let frame = guidance.snapshot();
    assert.ok(frame.remaining !== null && Math.abs(frame.remaining - route.distanceMetres) < 0.1);
    const steps = Math.round(route.distanceMetres / 0.72);
    for (let walked = 0; walked < steps; walked++) {
      frame = guidance.step(route.distanceMetres / steps, 0);
      if (walked === Math.floor(steps / 2)) {
        assert.ok(frame.remaining !== null && frame.remaining > 10 && frame.remaining < 17);
        assert.equal(frame.nearDestination, false);
      }
    }
    assert.equal(frame.reroutes, 0);
    assert.ok(frame.nearDestination);
  }
});
