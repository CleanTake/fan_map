import { campusNetwork, distanceMetres } from "./campus-router.ts";
import type { Coordinate } from "./directions.ts";

type WalkEdge = {
  id: string; from: string; to: string;
  kind: "indoor" | "outdoor" | "door"; lengthMetres: number;
};
export type WalkNetwork = { nodes: Record<string, number[]>; edges: WalkEdge[] };
export type WalkEstimate = {
  coordinate: Coordinate;
  status: "tracking" | "uncertain" | "lost";
  /** Agreement between map hypotheses, not a calibrated probability. */
  confidence: number;
  edgeId: string | null;
  /** Distance along the edge from its stored 'from' node. */
  offsetMetres: number | null;
  candidates: { edgeId: string; coordinate: Coordinate; weight: number }[];
};
type Options = {network?: WalkNetwork; initialBearing?: number; initialEdgeId?: string};
type Hypothesis = {
  edge: WalkEdge;
  offset: number;
  direction: number;
  strideScale: number;
  bearing: number;
  weight: number;
  mismatchMetres: number;
};

const BEAM_WIDTH = 72;
const ANCHOR_RADIUS_METRES = 12;
const angle = (degrees: number) => ((degrees % 360) + 540) % 360 - 180;
const valid = (p: Coordinate) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

export function createWalkTracker(anchor: Coordinate, options: Options = {}) {
  const network = options.network ?? campusNetwork;
  const incident = new Map<string, WalkEdge[]>();
  const bearings = new Map<string, number>();
  for (const edge of network.edges) {
    const a = network.nodes[edge.from], b = network.nodes[edge.to];
    const east = (b[0] - a[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360);
    bearings.set(edge.id, Math.atan2(east, b[1] - a[1]) * 180 / Math.PI);
    for (const node of [edge.from, edge.to]) {
      const list = incident.get(node) ?? [];
      list.push(edge);
      incident.set(node, list);
    }
  }
  function course(edge: WalkEdge, direction: number) {
    return angle(bearings.get(edge.id)! + (direction < 0 ? 180 : 0));
  }
  function point(edge: WalkEdge, offset: number): Coordinate {
    const t = offset / edge.lengthMetres;
    const a = network.nodes[edge.from], b = network.nodes[edge.to];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function project(edge: WalkEdge, coordinate: Coordinate) {
    const a = network.nodes[edge.from], b = network.nodes[edge.to];
    const scale = Math.cos(coordinate[1] * Math.PI / 180);
    const dx = (b[0] - a[0]) * scale, dy = b[1] - a[1];
    const fraction = ((coordinate[0] - a[0]) * scale * dx + (coordinate[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
    const offset = Math.max(0, Math.min(1, fraction)) * edge.lengthMetres;
    return {edge, offset, gap: distanceMetres(coordinate, point(edge, offset))};
  }

  // Explicitly retain both signs of travel and multiple step lengths until the
  // walk supplies evidence. There is no planned-route input to this filter.
  let beam: Hypothesis[] = [];
  let estimate: WalkEstimate;
  let lastFixTime = -Infinity;
  let stepsSeen = 0;
  type Fix = {position: Coordinate; timestamp: number; accuracy: number; steps: number};
  let outdoorFixes: Fix[] = [];
  let outdoorOrigin: {edge: WalkEdge; offset: number; timestamp: number} | undefined;

  function normalize(states: Hypothesis[]) {
    const sorted = states.sort((a, b) => b.weight - a.weight);
    const top = sorted.slice(0, BEAM_WIDTH);
    const total = top.reduce((sum, s) => sum + s.weight, 0);
    return total > 0 ? top.map(s => ({...s, weight: s.weight / total})) : [];
  }
  function summarize(): WalkEstimate {
    if (!beam.length) return estimate = {...estimate, status: "lost", confidence: 0, edgeId: null, offsetMetres: null, candidates: []};
    const located = beam.map(state => ({state, coordinate: point(state.edge, state.offset)}));
    const candidates = located.map(({state, coordinate}) => ({edgeId: state.edge.id, coordinate, weight: state.weight}));
    // Stride hypotheses on the same corridor can agree. Two parallel,
    // disconnected corridors must remain distinct however close their dots.
    let support = 0;
    let winner = located[0];
    for (const candidate of located) {
      const {edge, direction} = candidate.state;
      let weight = 0;
      for (const other of located) {
        const next = other.state.edge;
        const exit = direction > 0 ? edge.to : edge.from;
        const entry = direction > 0 ? edge.from : edge.to;
        const nextEntry = other.state.direction > 0 ? next.from : next.to;
        const nextExit = other.state.direction > 0 ? next.to : next.from;
        const connected = edge.id === next.id || exit === nextEntry || entry === nextExit;
        const sameDirection = Math.abs(angle(course(edge, direction) - course(next, other.state.direction))) < 65;
        if (connected && sameDirection && distanceMetres(candidate.coordinate, other.coordinate) <= 7) weight += other.state.weight;
      }
      if (weight > support + 1e-8) { support = weight; winner = candidate; }
    }
    if (support < 0.72 || winner.state.mismatchMetres > 2) {
      return estimate = {...estimate, status: "uncertain", confidence: support, edgeId: null, offsetMetres: null, candidates};
    }
    return estimate = {coordinate: winner.coordinate, status: "tracking", confidence: support,
      edgeId: winner.state.edge.id, offsetMetres: winner.state.offset, candidates};
  }
  function reset(position: Coordinate, initialBearing?: number, initialEdgeId?: string) {
    if (!valid(position)) throw new Error("Choose a valid starting coordinate.");
    outdoorFixes = [];
    outdoorOrigin = undefined;
    stepsSeen = 0;
    lastFixTime = -Infinity;
    const edges = initialEdgeId ? network.edges.filter(edge => edge.id === initialEdgeId) : network.edges;
    const projections = edges.map(edge => project(edge, position)).sort((a,b) => a.gap - b.gap);
    const nearest = projections[0];
    estimate = {coordinate: position, status: "lost", confidence: 0, edgeId: null, offsetMetres: null, candidates: []};
    beam = [];
    if (!nearest || nearest.gap > ANCHOR_RADIUS_METRES) return estimate;
    // At a confirmed junction consider the adjacent departing edges. Seeding
    // every line in a circular radius could jump through neighbouring walls.
    const endpointTolerance = Math.min(0.18, nearest.edge.lengthMetres / 10);
    const nearFrom = nearest.offset < endpointTolerance, nearTo = nearest.edge.lengthMetres - nearest.offset < endpointTolerance;
    const node = nearFrom ? nearest.edge.from : nearTo ? nearest.edge.to : null;
    // The hinted edge identifies the correct anchor even where unrelated paths
    // cross on the drawing. It doesn't select a departure at a shared junction.
    const starts = node ? incident.get(node)! : [nearest.edge];
    for (const edge of starts) {
      const offset = node ? (edge.from === node ? 0 : edge.lengthMetres) : nearest.offset;
      for (const direction of [-1, 1]) {
        if (direction < 0 && offset <= 0.001 || direction > 0 && offset >= edge.lengthMetres - 0.001) continue;
        const bearing = course(edge, direction);
        const error = Number.isFinite(initialBearing) ? angle(initialBearing! - bearing) : 0;
        for (const [strideScale, prior] of [[1, 0.6], [0.92, 0.2], [1.08, 0.2]]) {
          beam.push({edge, offset, direction, bearing, strideScale, mismatchMetres: 0, weight: prior * Math.exp(-0.5 * (error / 24) ** 2)});
        }
      }
    }
    beam = normalize(beam);
    const initial = summarize();
    // Position at the landmark is known even when the departure direction isn't.
    return estimate = {...initial, coordinate: point(nearest.edge, nearest.offset), status: "tracking",
      confidence: 1, edgeId: nearest.edge.id, offsetMetres: nearest.offset};
  }

  function advance(s: Hypothesis, metres: number, observeHeading: boolean, depth: number): Hypothesis[] {
    const available = s.direction > 0 ? s.edge.lengthMetres - s.offset : s.offset;
    if (metres <= available + 0.00001) return [{...s, offset: Math.max(0, Math.min(s.edge.lengthMetres, s.offset + s.direction * metres))}];
    if (depth >= 12) return [];
    const node = s.direction > 0 ? s.edge.to : s.edge.from;
    const exits = incident.get(node)!.filter(edge => edge.id !== s.edge.id);
    const result: Hypothesis[] = [];
    for (const edge of exits) {
      const direction = edge.from === node ? 1 : -1;
      const bearing = course(edge, direction);
      const error = observeHeading ? angle(s.bearing - bearing) : 0;
      const weight = s.weight * Math.exp(-0.5 * (error / 36) ** 2) / exits.length;
      if (weight < 1e-12) continue;
      result.push(...advance({...s, edge, direction, weight, offset: direction > 0 ? 0 : edge.lengthMetres,
        bearing: observeHeading ? s.bearing : bearing}, metres - available, observeHeading, depth + 1));
    }
    return result;
  }
  function step(metres: number, relativeTurnDegrees?: number) {
    // A stationary phone rotation supplies no displacement or walking bearing.
    if (!beam.length || !Number.isFinite(metres) || metres <= 0 || metres > 3) return estimate;
    stepsSeen++;
    const observed = Number.isFinite(relativeTurnDegrees);
    const states: Hypothesis[] = [];
    let survivingMass = 0;
    for (const previous of beam) {
      const s = {...previous};
      s.bearing = observed ? angle(s.bearing + relativeTurnDegrees!) : course(s.edge, s.direction);
      // A pedestrian can turn around anywhere, including mid-corridor.
      if (observed && Math.abs(angle(s.bearing - course(s.edge, s.direction))) > 145) s.direction *= -1;
      const initialCount = states.length;
      for (const next of advance(s, metres * s.strideScale, observed, 0)) {
        const difference = angle(next.bearing - course(next.edge, next.direction));
        next.mismatchMetres = observed && Math.abs(difference) > 55 ? next.mismatchMetres + metres : 0;
        if (next.mismatchMetres > 6) continue;
        if (observed) {
          next.weight *= Math.exp(-0.5 * (difference / 52) ** 2 * metres);
          // Gently realign small gyro errors on straight stretches; larger
          // residuals may be a real turn just before the projected junction.
          if (Math.abs(difference) < 30) next.bearing = angle(next.bearing - 0.06 * difference);
        }
        states.push(next);
      }
      if (states.length > initialCount) survivingMass += previous.weight;
    }
    // Walking past a mapped dead end must not suddenly promote a nearly
    // impossible reverse-direction track far behind the walker.
    beam = survivingMass >= 0.02 ? normalize(states) : [];
    return summarize();
  }

  // Find only outdoor projections reachable within this walking-distance
  // budget. Even a very close parallel path may require a long detour.
  function outdoorMatches(origin: {edge: WalkEdge; offset: number}, position: Coordinate, budget: number) {
    const reachable = new Set([origin.edge]);
    const distances = new Map<string, number>();
    const queue: string[] = [];
    function visit(node: string, distance: number) {
      if (distance <= budget && distance < (distances.get(node) ?? Infinity)) {
        distances.set(node, distance);
        queue.push(node);
      }
    }
    visit(origin.edge.from, origin.offset);
    visit(origin.edge.to, origin.edge.lengthMetres - origin.offset);
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      for (const edge of incident.get(node)!) {
        if (edge.kind !== "outdoor") continue;
        reachable.add(edge);
        visit(node === edge.from ? edge.to : edge.from, distances.get(node)! + edge.lengthMetres);
      }
    }
    return Array.from(reachable, edge => {
      const projection = project(edge, position);
      const viaFrom = (distances.get(edge.from) ?? Infinity) + projection.offset;
      const viaTo = (distances.get(edge.to) ?? Infinity) + edge.lengthMetres - projection.offset;
      const direct = edge === origin.edge ? Math.abs(projection.offset - origin.offset) : Infinity;
      const walk = Math.min(direct, viaFrom, viaTo);
      const direction = direct === walk ? Math.sign(projection.offset - origin.offset) || 1 : viaFrom <= viaTo ? 1 : -1;
      return {...projection, walk, direction};
    }).filter(match => match.walk <= budget);
  }

  function fix(position: Coordinate, accuracyMetres: number, timestamp = Date.now()) {
    if (!valid(position) || !Number.isFinite(timestamp) || timestamp <= lastFixTime) return estimate;
    if (timestamp - lastFixTime > 15000) { outdoorFixes = []; outdoorOrigin = undefined; }
    lastFixTime = timestamp;
    const outdoor = beam.filter(s => s.edge.kind === "outdoor");
    const outdoorMass = outdoor.reduce((sum, s) => sum + s.weight, 0);
    if (!Number.isFinite(accuracyMetres) || accuracyMetres <= 0 || accuracyMetres > 12 || outdoorMass < 0.75) {
      outdoorFixes = [];
      outdoorOrigin = undefined;
      return estimate;
    }
    const gate = Math.max(10, Math.min(18, accuracyMetres * 2));
    const previous = outdoorFixes.at(-1);
    if (previous && distanceMetres(position, previous.position) >
        2.5 * (timestamp - previous.timestamp) / 1000 + Math.min(8, (accuracyMetres + previous.accuracy) / 2)) {
      outdoorFixes = [];
      outdoorOrigin = undefined;
      return estimate;
    }
    if (!outdoorOrigin) {
      const nearby = outdoor.find(s => distanceMetres(position, point(s.edge, s.offset)) <= gate);
      if (!nearby) return estimate;
      outdoorOrigin = {edge: nearby.edge, offset: nearby.offset, timestamp};
    }
    outdoorFixes = outdoorFixes.filter(f => timestamp - f.timestamp <= 16000);
    outdoorFixes.push({position, accuracy: accuracyMetres, timestamp, steps: stepsSeen});
    const first = outdoorFixes[0];
    if (outdoorFixes.length < 3 || timestamp - first.timestamp < 1500) return estimate;
    const travel = distanceMetres(first.position, position);
    const evidenceRadius = Math.max(4, Math.min(10, (accuracyMetres + first.accuracy) / 2));
    if (first.steps === stepsSeen && travel > evidenceRadius) {
      const uncertainty = Math.max(2, Math.min(8, accuracyMetres));
      const elapsed = (timestamp - outdoorOrigin.timestamp) / 1000;
      const budget = Math.min(45, elapsed * 2.5 + uncertainty,
        distanceMetres(point(outdoorOrigin.edge, outdoorOrigin.offset), position) + uncertainty + 3);
      const matches = outdoorMatches(outdoorOrigin, position, budget)
        .filter(m => m.gap <= uncertainty).sort((a, b) => a.gap - b.gap);
      const best = matches[0];
      if (!best) return estimate = {...estimate, status: "uncertain", edgeId: null, offsetMetres: null, confidence: 0};
      const bestPoint = point(best.edge, best.offset);
      const ambiguous = matches.slice(1).some(other => {
        if (other.gap - best.gap > Math.max(1, uncertainty * 0.6)) return false;
        const separation = distanceMetres(bestPoint, point(other.edge, other.offset));
        const shared = [best.edge.from, best.edge.to].some(node => node === other.edge.from || node === other.edge.to);
        if (shared && separation < 1.5) return false;
        // Collinear consecutive segments have the same usable position near
        // the split. Two paths diverging from the same junction do not.
        const along = course(best.edge, best.direction), otherAlong = course(other.edge, other.direction);
        const consecutive = (best.direction > 0 ? best.edge.to : best.edge.from) ===
          (other.direction > 0 ? other.edge.from : other.edge.to) ||
          (other.direction > 0 ? other.edge.to : other.edge.from) === (best.direction > 0 ? best.edge.from : best.edge.to);
        return !consecutive || Math.abs(angle(along - otherAlong)) > 35;
      });
      if (ambiguous) return estimate = {...estimate, status: "uncertain", confidence: 0, edgeId: null, offsetMetres: null};
      const lastProgress = distanceMetres(point(outdoorOrigin.edge, outdoorOrigin.offset), bestPoint);
      if (lastProgress < 0.8) return estimate;
      beam = [1, 0.92, 1.08].map((strideScale, i) => ({edge: best.edge, offset: best.offset,
        direction: best.direction, bearing: course(best.edge, best.direction), strideScale,
        weight: i === 0 ? 0.6 : 0.2, mismatchMetres: 0}));
      outdoorOrigin = {edge: best.edge, offset: best.offset, timestamp};
      return summarize();
    }
    if (!outdoor.some(s => distanceMetres(position, point(s.edge, s.offset)) <= gate)) return estimate;
    // With active steps (or no convincing geographic displacement), gently
    // refine the existing hypotheses instead of reseeding the track from GPS.
    beam = normalize(beam.map(s => {
      const delta = distanceMetres(position, point(s.edge, s.offset));
      const weight = s.weight * Math.exp(-0.5 * (delta / Math.max(4, accuracyMetres)) ** 2);
      if (s.edge.kind !== "outdoor") return {...s, weight};
      const projected = project(s.edge, position);
      return {...s, weight,
        offset: projected.gap <= gate ? s.offset + 0.35 * (projected.offset - s.offset) : s.offset};
    }));
    const result = summarize();
    if (result.status === "tracking" && beam[0].edge.kind === "outdoor") {
      outdoorOrigin = {edge: beam[0].edge, offset: beam[0].offset, timestamp};
    }
    return result;
  }
  reset(anchor, options.initialBearing, options.initialEdgeId);
  return { step, fix, reset, snapshot: () => estimate };
}
