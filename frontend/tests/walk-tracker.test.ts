import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coordinate } from "../lib/navigation/directions.ts";
import { createWalkTracker, type WalkNetwork } from "../lib/navigation/walk-tracker.ts";
import { distanceMetres } from "../lib/navigation/campus-router.ts";

// Metre-scale fixture at the equator. The north/south junction, disconnected
// parallel corridor and 7 m outdoor link exercise different failure modes.
const coord = (x: number, y = 0): Coordinate => [x / 111195, y / 111195];
const nodes = {w: coord(0), j: coord(20), e: coord(50), n: coord(20, 22), s: coord(20, -22),
  p: coord(0, 4), q: coord(50, 4), a: coord(57), b: coord(87)};
function edge(id: string, from: keyof typeof nodes, to: keyof typeof nodes, kind: "indoor" | "outdoor" = "indoor") {
  return {id, from, to, kind, lengthMetres: distanceMetres(nodes[from], nodes[to])};
}
const graph: WalkNetwork = {nodes, edges: [
  edge("west", "w", "j"), edge("east", "j", "e"), edge("north", "j", "n"), edge("south", "j", "s"),
  edge("parallel", "p", "q"), edge("gap", "e", "a", "outdoor"), edge("beyond", "a", "b"),
]};
function walk(tracker: ReturnType<typeof createWalkTracker>, steps: number, turn: number | undefined = 0) {
  for (let i = 0; i < steps; i++) tracker.step(1, i ? 0 : turn);
  return tracker.snapshot();
}

test("signed turn observations resolve either branch and a U-turn can reverse mid-edge", () => {
  for (const [turn, label, y] of [[-90, "north", 10], [90, "south", -10]] as const) {
    const tracker = createWalkTracker(coord(10), {network: graph, initialBearing: 90});
    walk(tracker, 10);
    const turned = walk(tracker, 10, turn);
    assert.equal(turned.status, "tracking");
    assert.equal(turned.edgeId, label);
    assert.ok(distanceMetres(turned.coordinate, coord(20, y)) < 2);
    const reversed = walk(tracker, 5, 180);
    assert.equal(reversed.edgeId, label);
    assert.ok(distanceMetres(reversed.coordinate, coord(20, y / 2)) < 2);
  }
});

test("unknown initial direction and a junction without yaw hold the last reliable dot", () => {
  const anchor = coord(10);
  const tracker = createWalkTracker(anchor, {network: graph});
  const last = tracker.snapshot().coordinate;
  const ambiguous = walk(tracker, 4);
  assert.equal(ambiguous.status, "uncertain");
  assert.deepEqual(ambiguous.coordinate, last);
  assert.equal(ambiguous.edgeId, null);
  assert.ok(ambiguous.candidates.every(c => c.edgeId === "west"));
  tracker.reset(coord(18), 90);
  for (let i = 0; i < 7; i++) tracker.step(1);
  const branch = tracker.snapshot();
  assert.equal(branch.status, "uncertain");
  assert.ok(branch.candidates.some(c => c.edgeId === "north"));
  assert.ok(branch.candidates.some(c => c.edgeId === "south"));
  assert.ok(branch.candidates.every(c => c.edgeId !== "parallel"));
});

test("a stationary rotation cannot advance or reverse the tracker; a turn through an unmapped wall leads to loss", () => {
  const tracker = createWalkTracker(coord(5), {network: graph, initialBearing: 90});
  const before = tracker.snapshot();
  assert.deepEqual(tracker.step(0, 180), before);
  assert.deepEqual(tracker.step(NaN, 90), before);
  walk(tracker, 2);
  const inconsistent = walk(tracker, 3, -90);
  assert.equal(inconsistent.status, "uncertain");
  const lost = walk(tracker, 6);
  assert.equal(lost.status, "lost");
  assert.deepEqual(tracker.step(1, 0), lost);
  assert.equal(tracker.reset(coord(20, 10), 0).status, "tracking");
  assert.equal(createWalkTracker(coord(1000), {network: graph}).snapshot().status, "lost");
});

test("noisy, isolated, stale and indoor fixes cannot move the dot across a wall", () => {
  const tracker = createWalkTracker(coord(4), {network: graph, initialBearing: 90});
  const inside = tracker.snapshot();
  for (let i = 0; i < 5; i++) assert.deepEqual(tracker.fix(coord(4, 4), 2, i), inside);
  const outdoor = tracker.reset(coord(53), 90);
  assert.deepEqual(tracker.fix(coord(56), 3, 10), outdoor);
  assert.deepEqual(tracker.fix(coord(56), 3, 9), outdoor);
  assert.deepEqual(tracker.fix(coord(56), 3, 30000), outdoor);
  assert.deepEqual(tracker.fix(coord(56), 65, 31000), outdoor);
  assert.deepEqual(tracker.fix(coord(56), 3, 32000), outdoor);
  assert.deepEqual(tracker.fix(coord(56), 3, 33000), outdoor);
  const corrected = tracker.fix(coord(56), 3, 34000);
  assert.equal(corrected.edgeId, "gap");
  assert.ok(distanceMetres(outdoor.coordinate, corrected.coordinate) > 0.2);
  assert.ok(distanceMetres(outdoor.coordinate, corrected.coordinate) < 2);
});

test("a missed exit at a dead end requests a new anchor instead of silently jumping back down the corridor", () => {
  const tracker = createWalkTracker(coord(20, 15), {network: graph, initialBearing: 0});
  const result = walk(tracker, 12);
  assert.equal(result.status, "lost");
  assert.ok(distanceMetres(result.coordinate, nodes.n) < 2);
});

test("confirming a junction without facing direction retains exits outside the suggested route", () => {
  const tracker = createWalkTracker(nodes.j, {network: graph, initialEdgeId: "east"});
  assert.deepEqual(new Set(tracker.snapshot().candidates.map(c => c.edgeId)), new Set(["west", "east", "north", "south"]));
  const uncertain = walk(tracker, 3);
  assert.equal(uncertain.status, "uncertain");
  assert.deepEqual(uncertain.coordinate, nodes.j);
});

test("consistent GPS follows connected outdoor edges when no step sensor is available", () => {
  const outside: WalkNetwork = {nodes, edges: [edge("w", "w", "j", "outdoor"), edge("e", "j", "e", "outdoor"),
    edge("gap", "e", "a", "outdoor"), edge("inside", "a", "b"), edge("parallel", "p", "q", "outdoor")]};
  const tracker = createWalkTracker(coord(14), {network: outside, initialBearing: 90});
  for (let x = 14; x <= 54; x += 2) tracker.fix(coord(x), 3, x * 1000);
  assert.equal(tracker.snapshot().edgeId, "gap");
  assert.ok(distanceMetres(tracker.snapshot().coordinate, coord(54)) < 2);
  for (let x = 56; x <= 70; x += 2) tracker.fix(coord(x), 3, x * 1000);
  assert.notEqual(tracker.snapshot().edgeId, "inside");
  assert.ok(distanceMetres(tracker.snapshot().coordinate, nodes.a) < 2);
});

test("outdoor GPS holds at ambiguous parallel branches and rejects large geographic jumps", () => {
  const road = { a: coord(0), j: coord(12), n: coord(25, 3), s: coord(25, -3), far: coord(80, 0) };
  const roadEdge = (from: keyof typeof road, to: keyof typeof road) => ({id: from + to, from, to,
    kind: "outdoor" as const, lengthMetres: distanceMetres(road[from], road[to])});
  const outside = {nodes: road, edges: [roadEdge("a","j"), roadEdge("j","n"), roadEdge("j","s"), roadEdge("s","far")]};
  const tracker = createWalkTracker(coord(8), {network: outside, initialBearing: 90});
  for (let x = 8; x <= 22; x += 2) tracker.fix(coord(x), 4, x * 1000);
  assert.equal(tracker.snapshot().status, "uncertain");
  const last = tracker.snapshot().coordinate;
  for (let i = 1; i <= 5; i++) tracker.fix(road.far, 3, (22 + i) * 1000);
  assert.deepEqual(tracker.snapshot().coordinate, last);
});
