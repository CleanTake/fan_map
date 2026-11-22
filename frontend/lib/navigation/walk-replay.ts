import { distanceMetres } from "./campus-router.ts";
import type { Coordinate } from "./directions.ts";
import { pixelToCoordinate } from "./reference.ts";

export type WalkReplayScenario = "guided" | "wrong-turn";

export type ReplayEvent = { atMs: number; note?: string } & (
  | { type: "step"; distanceMetres: number; relativeTurnDegrees: number }
  | { type: "fix"; coordinate: Coordinate; accuracyMetres: number }
  | { type: "pause" | "resume" | "gps-lost" }
);

export type WalkReplay = {
  anchor: Coordinate;
  destination: Coordinate;
  initialBearingDegrees: number;
  events: ReplayEvent[];
};

// Script the walker from recognizable points on the reviewed ground-floor
// drawing. The estimator receives the same step, turn, and fix inputs as a
// live session. It never sees the intermediate coordinates from this script.
const entrance: Coordinate = [-81.2006769, 43.0111652];
const southHall = pixelToCoordinate([364.3, 451]);
const atriumSouth = pixelToCoordinate([383, 451]);
const atriumNorth = pixelToCoordinate([383, 394]);
const dDestination = pixelToCoordinate([481, 350]);
const guidedLegs = [
  pixelToCoordinate([449, 394]),
  pixelToCoordinate([449, 375]),
  pixelToCoordinate([481, 375]),
  dDestination,
];
const detourLegs = [pixelToCoordinate([352, 394]), pixelToCoordinate([352, 435])];

function bearing(from: Coordinate, to: Coordinate) {
  const meanLatitudeRadians = (from[1] + to[1]) * Math.PI / 360;
  const east = (to[0] - from[0]) * Math.cos(meanLatitudeRadians);
  const north = to[1] - from[1];
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export function createWalkReplay(scenario: WalkReplayScenario = "guided"): WalkReplay {
  const events: ReplayEvent[] = [];
  const initialBearingDegrees = bearing(entrance, southHall);
  let previousBearing = initialBearingDegrees;
  let previousPoint = entrance;
  let atMs = 0;
  let stepNumber = 0;
  const legEnds = [southHall, atriumSouth, atriumNorth, ...(scenario === "guided" ? guidedLegs : detourLegs)];

  // One useful outdoor fix at the identified entrance, then intermittent indoor reception.
  events.push({ atMs, type: "fix", coordinate: [...entrance], accuracyMetres: 4 });
  for (const [leg, end] of legEnds.entries()) {
    const nextBearing = bearing(previousPoint, end);
    const turn = (nextBearing - previousBearing + 540) % 360 - 180;
    const metres = distanceMetres(previousPoint, end);
    const steps = Math.max(1, Math.round(metres / 0.72));
    for (let index = 0; index < steps; index++) {
      if (leg === 0 && index === 7) {
        events.push({ atMs: atMs + 1, type: "gps-lost", note: "Location signal lost inside B." });
      }
      if (leg === 2 && index === Math.floor(steps / 2)) {
        events.push({ atMs: atMs + 1, type: "pause", note: "Standing still and rotating the phone." });
        atMs += 6_000;
        events.push({ atMs, type: "resume", note: "Walking again." });
      }
      // Vary step length and turn observations deterministically for repeatable
      // replays. The small systematic bias also avoids exact graph-node landings.
      stepNumber++;
      atMs += 510 + Math.round(30 * Math.sin(stepNumber));
      const step: ReplayEvent = {
        type: "step",
        atMs,
        distanceMetres: metres / steps * (1.003 + 0.035 * Math.sin(stepNumber)),
        relativeTurnDegrees: (index === 0 ? turn : 0) + 0.45 * Math.cos(stepNumber),
      };
      if (leg === 3 && index === 0) {
        step.note = scenario === "guided"
          ? "Turning toward the B–D connection."
          : "Taking the opposite turn at the B atrium.";
      }
      events.push(step);
    }
    if (leg === 1) {
      // A noisy fix across the building must not teleport the indoor marker.
      events.push({ atMs: atMs + 1, type: "fix", coordinate: pixelToCoordinate([437, 415]), accuracyMetres: 65,
        note: "A weak location fix arrives indoors." });
    }
    previousPoint = end;
    previousBearing = nextBearing;
  }

  return { anchor: [...entrance], destination: [...dDestination], initialBearingDegrees, events };
}
