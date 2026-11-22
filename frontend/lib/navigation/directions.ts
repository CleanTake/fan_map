export type Coordinate = [number, number];
export type RouteTraversal = {
  edgeId: string;
  startOffset: number;
  endOffset: number;
  stepIndex: number;
};
export type WalkingDirections = {
  geometry: GeoJSON.LineString;
  distanceMetres: number;
  durationSeconds: number;
  steps: { instruction: string; distanceMetres: number }[];
  endpoints: [Coordinate, Coordinate];
  endpointOffsets: [number, number];
  source?: "mapbox" | "campus";
  approximate?: boolean;
  indoorDistanceMetres?: number;
  segments?: { kind: "indoor" | "outdoor" | "door"; label: string; coordinates: Coordinate[] }[];
  traversals?: RouteTraversal[];
};

function coordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Use the provider's pedestrian network; never fabricate a straight-line route. */
export async function getWalkingDirections(
  start: Coordinate, end: Coordinate, token: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<WalkingDirections> {
  if (!coordinate(start) || !coordinate(end)) throw new Error("Choose locations with valid map positions.");
  if (start[0] === end[0] && start[1] === end[1]) throw new Error("Choose different starting and destination locations.");
  if (!token) throw new Error("Walking directions are unavailable: the map access token is missing.");
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/walking/${start.join(",")};${end.join(",")}`);
  url.search = new URLSearchParams({ access_token: token, geometries: "geojson", overview: "full", steps: "true", alternatives: "false", radiuses: "80;80", language: "en" }).toString();
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url.toString(), { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("Could not reach walking directions. Check your internet connection and try again.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("Walking directions are unavailable with the configured map token. Check its permissions and allowed URLs.");
  if (response.status === 429) throw new Error("Too many directions requests. Wait a moment and try again.");
  if (!response.ok) throw new Error("The walking directions service is unavailable. Please try again.");
  const body = await response.json().catch(() => null);
  if (body?.code === "NoRoute" || body?.code === "NoSegment") throw new Error("No mapped walking route was found near these locations. Try a nearby entrance or another starting point.");
  const route = body?.routes?.[0];
  const points = route?.geometry?.coordinates;
  if (body?.code !== "Ok" || route?.geometry?.type !== "LineString" || !Array.isArray(points) || points.length < 2 || !points.every(coordinate) || !nonnegative(route.distance) || !nonnegative(route.duration)) {
    throw new Error("The directions service returned an invalid route. Please try again.");
  }
  const waypoints = body.waypoints;
  if (!Array.isArray(waypoints) || waypoints.length !== 2 || !waypoints.every((point) => coordinate(point?.location) && nonnegative(point?.distance))) {
    throw new Error("The directions service returned invalid route endpoints. Please try again.");
  }
  const steps: WalkingDirections["steps"] = [];
  if (Array.isArray(route.legs)) {
    for (const leg of route.legs) {
      if (!Array.isArray(leg?.steps)) continue;
      for (const step of leg.steps) {
        if (typeof step?.maneuver?.instruction === "string" && nonnegative(step.distance)) steps.push({ instruction: step.maneuver.instruction, distanceMetres: step.distance });
      }
    }
  }
  return {
    geometry: { type: "LineString", coordinates: points }, distanceMetres: route.distance, durationSeconds: route.duration, steps,
    endpoints: [waypoints[0].location, waypoints[1].location], endpointOffsets: [waypoints[0].distance, waypoints[1].distance],
    source: "mapbox", approximate: false,
  };
}
