import data from "../../data/navigation/campus-network.json" with { type: "json" };
import { getWalkingDirections, type Coordinate, type WalkingDirections } from "./directions.ts";

type Edge = { id: string; from: string; to: string; kind: "indoor" | "outdoor" | "door"; label: string; buildings: string[]; lengthMetres: number; sourceId?: string | null };
type SplitEdge = Edge & { originalId?: string; startOffset?: number; endOffset?: number };
type Network = { nodes: Record<string, number[]>; edges: Edge[]; buildings: { code: string; rings: number[][][] }[] };
export const campusNetwork = data as Network;

export function distanceMetres(a: readonly number[], b: readonly number[]) {
  const rad = Math.PI / 180;
  const latitude = (b[1] - a[1]) * rad;
  const longitude = (b[0] - a[0]) * rad;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(latitude / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(longitude / 2) ** 2)));
}

function insideRing(point: readonly number[], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function insideBuilding(point: readonly number[], rings: number[][][]) {
  return insideRing(point, rings[0]) && !rings.slice(1).some((ring) => insideRing(point, ring));
}

function project(point: Coordinate, a: number[], b: number[]) {
  const scale = Math.cos(point[1] * Math.PI / 180);
  const dx = (b[0] - a[0]) * scale, dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / denominator)) : 0;
  const coordinates: Coordinate = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { t, coordinates, offset: distanceMetres(point, coordinates) };
}

function snap(point: Coordinate, network: Network) {
  // Some outline files have no ref tag and retain their filename (building_L).
  // Match that outline to the same building code used by its corridor edges.
  const containing = network.buildings.filter((building) => insideBuilding(point, building.rings))
    .map((building) => ({ ...building, code: building.code.replace(/^building_/, "") }));
  const indoor = containing.length > 0;
  let best: { edge: Edge; t: number; coordinates: Coordinate; offset: number } | null = null;
  for (const edge of network.edges) {
    if (indoor ? edge.kind === "outdoor" || !edge.buildings.some((code) => containing.some((building) => building.code === code)) : edge.kind !== "outdoor") continue;
    const candidate = project(point, network.nodes[edge.from], network.nodes[edge.to]);
    if (candidate.offset > (indoor ? 40 : 80) || (best && candidate.offset >= best.offset)) continue;
    if (!indoor && candidate.offset > 2) {
      // An outdoor pin must not jump through a building to a nearby path.
      const crossesBuilding = [0.2, 0.4, 0.6, 0.8].some((t) => {
        const between = [point[0] + (candidate.coordinates[0] - point[0]) * t, point[1] + (candidate.coordinates[1] - point[1]) * t];
        return network.buildings.some((building) => insideBuilding(between, building.rings));
      });
      if (crossesBuilding) continue;
    }
    best = { edge, ...candidate };
  }
  return best;
}

/** Dijkstra searches the combined network afresh for every pair of endpoints. */
export function findCampusRoute(start: Coordinate, end: Coordinate, network: Network = campusNetwork, matchedEdges?: { start?: string; end?: string }): WalkingDirections | null {
  function endpoint(point: Coordinate, id?: string) {
    if (!id) return snap(point, network);
    const edge = network.edges.find((item) => item.id === id);
    if (!edge) return null;
    const match = project(point, network.nodes[edge.from], network.nodes[edge.to]);
    return match.offset < 2 ? { edge, ...match } : null;
  }
  const origin = endpoint(start, matchedEdges?.start), destination = endpoint(end, matchedEdges?.end);
  if (!origin || !destination) return null;
  const nodes: Record<string, number[]> = { ...network.nodes, "route-start": origin.coordinates, "route-end": destination.coordinates };
  const cuts = new Map<string, { id: string; t: number }[]>();
  for (const [id, position] of [["route-start", origin], ["route-end", destination]] as const) {
    cuts.set(position.edge.id, [...(cuts.get(position.edge.id) ?? []), { id, t: position.t }]);
  }
  const edges: SplitEdge[] = [];
  for (const edge of network.edges) {
    const split = cuts.get(edge.id);
    if (!split) { edges.push(edge); continue; }
    const points = [{ id: edge.from, t: 0 }, ...split, { id: edge.to, t: 1 }].sort((a, b) => a.t - b.t);
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      edges.push({ ...edge, originalId: edge.id, id: `${edge.id}:${index}`, from: a.id, to: b.id,
        startOffset: a.t * edge.lengthMetres, endOffset: b.t * edge.lengthMetres, lengthMetres: (b.t - a.t) * edge.lengthMetres });
    }
  }
  const adjacency = new Map<string, { to: string; edge: SplitEdge }[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), { to: edge.to, edge }]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), { to: edge.from, edge }]);
  }
  const distances = new Map<string, number>([["route-start", 0]]);
  const previous = new Map<string, { from: string; edge: SplitEdge }>();
  const queue: { id: string; distance: number }[] = [{ id: "route-start", distance: 0 }];
  const visited = new Set<string>();
  // The campus graph is small; sorted insertion keeps this queue predictable.
  while (queue.length) {
    queue.sort((a, b) => b.distance - a.distance);
    const current = queue.pop()!;
    if (visited.has(current.id)) continue;
    if (current.id === "route-end") break;
    visited.add(current.id);
    for (const { to, edge } of adjacency.get(current.id) ?? []) {
      const cost = current.distance + edge.lengthMetres;
      if (cost < (distances.get(to) ?? Infinity)) {
        distances.set(to, cost); previous.set(to, { from: current.id, edge }); queue.push({ id: to, distance: cost });
      }
    }
  }
  if (!distances.has("route-end")) return null;
  const traversals: { from: string; to: string; edge: SplitEdge }[] = [];
  let cursor = "route-end";
  while (cursor !== "route-start") {
    const step = previous.get(cursor);
    if (!step) return null;
    traversals.unshift({ from: step.from, to: cursor, edge: step.edge }); cursor = step.from;
  }
  const segments: NonNullable<WalkingDirections["segments"]> = [];
  const steps: WalkingDirections["steps"] = [];
  const itinerary: NonNullable<WalkingDirections["traversals"]> = [];
  let indoorDistanceMetres = 0;
  for (const { from, to, edge } of traversals) {
    if (edge.lengthMetres < 0.01) continue;
    const label = edge.from === from ? edge.label : edge.label.startsWith("Exit ") ? edge.label.replace(/^Exit /, "Enter ") : edge.label.startsWith("Enter ") ? edge.label.replace(/^Enter /, "Exit ") : edge.label;
    const last = segments.at(-1);
    if (last?.label === label && last.kind === edge.kind) {
      last.coordinates.push(nodes[to] as Coordinate); steps[steps.length - 1].distanceMetres += edge.lengthMetres;
    } else {
      segments.push({ label, kind: edge.kind, coordinates: [nodes[from] as Coordinate, nodes[to] as Coordinate] });
      steps.push({ instruction: label, distanceMetres: edge.lengthMetres });
    }
    if (edge.kind !== "outdoor") indoorDistanceMetres += edge.lengthMetres;
    const a = edge.startOffset ?? 0, b = edge.endOffset ?? edge.lengthMetres;
    itinerary.push({ edgeId: edge.originalId ?? edge.id, startOffset: edge.from === from ? a : b,
      endOffset: edge.from === from ? b : a, stepIndex: steps.length - 1 });
  }
  const coordinates = segments.flatMap((segment, index) => index ? segment.coordinates.slice(1) : segment.coordinates);
  if (coordinates.length < 2) return null;
  const distance = distances.get("route-end")!;
  return { geometry: { type: "LineString", coordinates }, distanceMetres: distance, durationSeconds: distance / 1.35, steps, endpoints: [origin.coordinates, destination.coordinates], endpointOffsets: [origin.offset, destination.offset], source: "campus", approximate: true, indoorDistanceMetres, segments, traversals: itinerary };
}

export async function requestWalkingDirections(start: Coordinate, end: Coordinate, token: string, options: { signal?: AbortSignal; fetcher?: typeof fetch } = {}) {
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (![start, end].every((point) => point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) throw new Error("Choose locations with valid map positions.");
  if (distanceMetres(start, end) < 0.1) throw new Error("Choose different starting and destination locations.");
  const local = findCampusRoute(start, end);
  if (local) return local;
  return getWalkingDirections(start, end, token, options);
}

export const campusCorridorFeatures: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  type: "FeatureCollection", features: campusNetwork.edges.filter((edge) => edge.kind !== "outdoor").map((edge) => ({ type: "Feature", properties: { kind: edge.kind, label: edge.label }, geometry: { type: "LineString", coordinates: [campusNetwork.nodes[edge.from], campusNetwork.nodes[edge.to]] } })),
};

export const campusDoorFeatures: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection", features: data.doors.map((door) => ({ type: "Feature", properties: { label: door.label }, geometry: { type: "Point", coordinates: door.coordinates } })),
};
