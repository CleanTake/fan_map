import assert from "node:assert/strict";
import { test } from "node:test";
import { getWalkingDirections, type Coordinate } from "../lib/navigation/directions.ts";

const start: Coordinate = [-81.2, 43.01];
const end: Coordinate = [-81.199, 43.011];
const body = () => ({ code: "Ok", routes: [{ distance: 180, duration: 140, geometry: { type: "LineString", coordinates: [start, [-81.2, 43.011], end] }, legs: [{ steps: [{ maneuver: { instruction: "Turn right onto the walkway" }, distance: 70 }] }] }], waypoints: [{ location: start, distance: 0 }, { location: end, distance: 18 }] });
const mock = (value: unknown, status = 200) => (async () => Response.json(value, { status })) as typeof fetch;

test("requests pedestrian directions with full geometry, bounded snapping and instructions", async () => {
  let requested: URL | undefined;
  const fetcher = (async (input: string | URL | Request) => { requested = new URL(String(input)); return Response.json(body()); }) as typeof fetch;
  const route = await getWalkingDirections(start, end, "test-token", { fetcher });
  assert.equal(requested!.origin, "https://api.mapbox.com");
  assert.match(requested!.pathname, /mapbox\/walking\/-81.2,43.01;-81.199,43.011$/);
  assert.equal(requested!.searchParams.get("steps"), "true");
  assert.equal(requested!.searchParams.get("radiuses"), "80;80");
  assert.deepEqual(route.geometry.coordinates, body().routes[0].geometry.coordinates);
  assert.equal(route.distanceMetres, 180);
  assert.equal(route.durationSeconds, 140);
  assert.equal(route.steps[0].instruction, "Turn right onto the walkway");
  assert.deepEqual(route.endpointOffsets, [0, 18]);
});

test("bad input and missing credentials never make paid API calls", async () => {
  const fetcher = (async () => { throw new Error("Unexpected fetch"); }) as typeof fetch;
  await assert.rejects(getWalkingDirections(start, start, "token", { fetcher }), /different/);
  await assert.rejects(getWalkingDirections([NaN, 0], end, "token", { fetcher }), /valid map/);
  await assert.rejects(getWalkingDirections(start, end, "", { fetcher }), /token is missing/);
});

test("unmapped and disconnected endpoints never fall back to a straight line", async () => {
  for (const code of ["NoRoute", "NoSegment"]) await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock({ code }) }), /No mapped walking route/);
  for (const invalid of [{ ...body(), code: "error" }, { ...body(), routes: [] }, { ...body(), waypoints: [] }]) {
    await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock(invalid) }), /invalid route/);
  }
  const invalid = body(); invalid.routes[0].geometry.coordinates = [[Infinity, 0], end];
  await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock(invalid) }), /invalid route/);
});

test("provider errors explain credentials, throttling, malformed replies and network failure", async () => {
  for (const status of [401, 403]) await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock({}, status) }), /permissions and allowed URLs/);
  await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock({}, 429) }), /Too many/);
  await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: mock({}, 503) }), /service is unavailable/);
  await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: (async () => new Response("bad JSON")) as typeof fetch }), /invalid route/);
  await assert.rejects(getWalkingDirections(start, end, "token", { fetcher: (async () => { throw new Error("offline"); }) as typeof fetch }), /internet connection/);
});

test("cancellation is passed to the network layer", async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = (async (_input: unknown, init: RequestInit) => { assert.equal(init.signal, controller.signal); throw new DOMException("Aborted", "AbortError"); }) as typeof fetch;
  await assert.rejects(getWalkingDirections(start, end, "token", { signal: controller.signal, fetcher }), { name: "AbortError" });
});
