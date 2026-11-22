import { campusNetwork, distanceMetres, findCampusRoute } from "./campus-router.ts";
import type { Coordinate, WalkingDirections } from "./directions.ts";
import { createWalkTracker } from "./walk-tracker.ts";

/** Initial walking direction is used only when the walker confirms it. */
export function startingBearing(route: WalkingDirections) {
  const [a, b] = route.geometry.coordinates;
  return Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
}

export function createWalkGuidance(plan: WalkingDirections, initialBearing?: number) {
  if (!plan.traversals?.length) throw new Error("Live walking needs a mapped campus route.");
  const destinationEdge = plan.traversals.at(-1)!.edgeId;
  const tracker = createWalkTracker(plan.endpoints[0], {
    initialBearing, initialEdgeId: plan.traversals[0].edgeId,
  });
  let route = plan;
  let mismatchMetres = 0;
  let furthestProgress = 0;
  let reroutes = 0;

  function update(walked: number) {
    const estimate = tracker.snapshot();
    let remaining: number | null = null;
    let instruction = "Position uncertain. Confirm a nearby landmark to continue.";
    let nearDestination = false;
    if (estimate.status === "tracking" && estimate.offsetMetres !== null && estimate.edgeId) {
      const offset = estimate.offsetMetres;
      let travelled = 0;
      let onRoute = false;
      for (const segment of route.traversals!) {
        const length = Math.abs(segment.endOffset - segment.startOffset);
        const along = (offset - segment.startOffset) * Math.sign(segment.endOffset - segment.startOffset);
        if (segment.edgeId === estimate.edgeId && along >= -1 && along <= length + 1) {
          const progress = travelled + Math.max(0, Math.min(length, along));
          // Sustained walking back along the same corridor can also be a departure.
          if (progress + 6 >= furthestProgress) {
            onRoute = true;
            furthestProgress = Math.max(progress, furthestProgress);
            remaining = Math.max(0, route.distanceMetres - progress);
            const next = route.steps[segment.stepIndex + 1];
            instruction = route.steps[segment.stepIndex].instruction + (next ? " · Next: " + next.instruction : "");
            nearDestination = segment === route.traversals!.at(-1) && remaining < 2;
            if (nearDestination) instruction = "Near the mapped destination. Check the landmark when you arrive.";
          }
          break;
        }
        travelled += length;
      }
      const first = route.traversals![0];
      const beforeNewStart = reroutes > 0 && estimate.edgeId === first.edgeId &&
        (offset - first.startOffset) * Math.sign(first.endOffset - first.startOffset) < 0;
      if (!onRoute && beforeNewStart) {
        remaining = route.distanceMetres + Math.abs(offset - first.startOffset);
        instruction = "Turn back and follow the highlighted path.";
        mismatchMetres = 0;
      } else if (onRoute) mismatchMetres = 0;
      else {
        mismatchMetres += walked;
        instruction = "Checking your path…";
        if (mismatchMetres >= 5) {
          const revised = findCampusRoute(estimate.coordinate, plan.endpoints[1], campusNetwork, { start: estimate.edgeId, end: destinationEdge });
          if (revised?.traversals?.length) {
            route = revised;
            reroutes++;
            mismatchMetres = 0;
            furthestProgress = 0;
            remaining = route.distanceMetres;
            instruction = route.steps[0].instruction;
          }
        }
      }
    } else mismatchMetres = 0;
    return { estimate, route, instruction, remaining, nearDestination, reroutes };
  }
  return {
    snapshot: () => update(0),
    step(distanceMetres: number, turn?: number) {
      tracker.step(distanceMetres, turn);
      return update(distanceMetres);
    },
    fix(coordinate: Coordinate, accuracyMetres: number, timestamp?: number) {
      const before = tracker.snapshot();
      const after = tracker.fix(coordinate, accuracyMetres, timestamp);
      const moved = distanceMetres(before.coordinate, after.coordinate);
      return update(before.status === "tracking" && after.status === "tracking" && moved >= 2 ? Math.min(5, moved) : 0);
    },
  };
}
export type WalkFrame = ReturnType<ReturnType<typeof createWalkGuidance>["snapshot"]>;
export type WalkDisplay = { coordinate: Coordinate; uncertain: boolean; replay: boolean; instruction: string };
