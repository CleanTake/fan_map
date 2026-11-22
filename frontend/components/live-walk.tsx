"use client";

import { useEffect, useRef, useState } from "react";
import type { Coordinate, WalkingDirections } from "@/lib/navigation/directions";
import type { LocationFeature } from "@/lib/place-types";
import { distanceMetres, findCampusRoute } from "@/lib/navigation/campus-router";
import { createWalkReplay, type WalkReplayScenario } from "@/lib/navigation/walk-replay";
import { createWalkGuidance, startingBearing, type WalkDisplay, type WalkFrame } from "@/lib/navigation/walk-guidance";
import { startWalkMotion, watchWalkLocation, type MotionSensorStatus } from "@/lib/navigation/walk-sensors";

type Props = {
  plan: WalkingDirections | null;
  originLabel: string;
  busy: boolean;
  places: LocationFeature[];
  onRoute: (route: WalkingDirections | null) => void;
  onDisplay: (display: WalkDisplay | null) => void;
  onActive: (active: boolean) => void;
};
type Walk = ReturnType<typeof createWalkGuidance>;
type Trial = { started: number; metresPerStep: number; start: Coordinate; destination: Coordinate; events: object[] };

function beginTrial(plan: WalkingDirections, metresPerStep: number): Trial {
  return { started: Date.now(), metresPerStep, start: plan.endpoints[0], destination: plan.endpoints[1], events: [] };
}

function recordEvent(trial: Trial | null, event: object) {
  if (trial) trial.events.push({ atMs: Date.now() - trial.started, ...event });
}

const motionMessages: Partial<Record<MotionSensorStatus, string>> = {
  insecure: "Motion tracking needs an HTTPS connection trusted by this phone.",
  denied: "Motion permission is off. You can confirm landmarks manually.",
  unavailable: "No usable motion readings. You can confirm landmarks manually.",
  waiting: "Waiting for phone motion readings…",
  paused: "Motion tracking paused.",
};

export default function LiveWalk({ plan, originLabel, busy, places, onRoute, onDisplay, onActive }: Props) {
  const [mode, setMode] = useState<"live" | "replay" | null>(null);
  const [scenario, setScenario] = useState<WalkReplayScenario>("guided");
  const [frame, setFrame] = useState<WalkFrame | null>(null);
  const [note, setNote] = useState("");
  const [finished, setFinished] = useState(false);
  const [motion, setMotion] = useState<MotionSensorStatus>("waiting");
  const [needsAnchor, setNeedsAnchor] = useState(false);
  const [landmark, setLandmark] = useState("");
  const [faceRoute, setFaceRoute] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [recordTrial, setRecordTrial] = useState(false);
  const [hasTrial, setHasTrial] = useState(false);
  const [checkpointCount, setCheckpointCount] = useState(0);
  const trial = useRef<Trial | null>(null);
  const [stride, setStride] = useState("0.72");
  const stepLength = Number(stride);
  const validStep = stepLength >= 0.3 && stepLength <= 1.3;
  const session = useRef<Walk | null>(null);
  const lastRoute = useRef<WalkingDirections | null>(null);
  const suspended = useRef(false);
  const disposers = useRef<Array<() => void>>([]);

  function log(event: object) {
    recordEvent(trial.current, event);
  }

  function exportTrial() {
    if (!trial.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(trial.current)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "fanmap-walk-" + trial.current.started + ".json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  useEffect(() => () => {
    disposers.current.splice(0).forEach(stop => stop());
    session.current = null;
    onDisplay(null);
    onActive(false);
  }, [onDisplay, onActive]);

  function publish(next: WalkFrame, replay: boolean) {
    setFrame(next);
    if (next.route !== lastRoute.current) {
      onRoute(next.route);
      lastRoute.current = next.route;
    }
    onDisplay({ coordinate: next.estimate.coordinate, uncertain: next.estimate.status !== "tracking", replay, instruction: next.instruction });
  }

  function stop() {
    disposers.current.splice(0).forEach(dispose => dispose());
    session.current = null;
    lastRoute.current = null;
    suspended.current = false;
    setMode(null); setFrame(null); setNote(""); setFinished(false); setNeedsAnchor(false);
    setLandmark(""); setConfirmed(false); setFaceRoute(false);
    onActive(false); onDisplay(null); onRoute(plan);
  }

  function replay() {
    const script = createWalkReplay(scenario);
    const path = findCampusRoute(script.anchor, script.destination);
    if (!path?.traversals?.length) { setNote("The B to D replay route is unavailable."); return; }
    const walk = createWalkGuidance(path, script.initialBearingDegrees);
    session.current = walk;
    onActive(true); setMode("replay"); setFinished(false);
    setNote("Entering B through the south entrance.");
    publish(walk.snapshot(), true);
    let index = 0, elapsed = 0, lastTick: number | undefined;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!document.hidden && lastTick !== undefined) elapsed += Math.min(250, now - lastTick) * 10;
      lastTick = now;
      let next: WalkFrame | undefined;
      while (index < script.events.length && script.events[index].atMs <= elapsed) {
        const event = script.events[index++];
        if (event.note) setNote(event.note);
        if (event.type === "step") next = walk.step(event.distanceMetres, event.relativeTurnDegrees);
        if (event.type === "fix") next = walk.fix(event.coordinate, event.accuracyMetres, event.atMs);
      }
      if (next) publish(next, true);
      if (index === script.events.length) {
        window.clearInterval(timer);
        setFinished(true);
      }
    }, 80);
    disposers.current.push(() => window.clearInterval(timer));
  }

  function live() {
    if (!plan?.traversals?.length || !confirmed || !validStep) return;
    const walk = createWalkGuidance(plan, startingBearing(plan));
    session.current = walk;
    trial.current = recordTrial ? beginTrial(plan, stepLength) : null;
    setCheckpointCount(0); setHasTrial(recordTrial);
    setMode("live"); onActive(true); setNote(""); setMotion("waiting");
    publish(walk.snapshot(), false);
    // Invoke motion permission directly inside the Start walk gesture.
    function pause() {
      if (suspended.current) return;
      suspended.current = true; setNeedsAnchor(true);
      log({ type: "pause" });
      const current = session.current?.snapshot();
      if (current) onDisplay({ coordinate: current.estimate.coordinate, uncertain: true, replay: false, instruction: "Confirm your location to resume." });
    }
    disposers.current.push(startWalkMotion({
      onStep(turn) {
        if (session.current && !suspended.current) {
          const next = session.current.step(stepLength, turn);
          log({ type: "step", turn, coordinate: next.estimate.coordinate, status: next.estimate.status, edgeId: next.estimate.edgeId });
          publish(next, false);
        }
      },
      onStatus: setMotion,
      onPause: pause,
    }));
    disposers.current.push(watchWalkLocation(fix => {
      if (!session.current || suspended.current || Date.now() - fix.timestamp > 10000) return;
      log({ type: "fix", ...fix });
      publish(session.current.fix(fix.coordinate, fix.accuracyMetres, fix.timestamp), false);
    }, status => { if (status === "paused") pause(); }));
  }

  const landmarks = places.filter(place =>
    place.geometry && place.properties.navigationStatus !== "pending-access-review" &&
    (place.properties.floor == null || [0, 1].includes(place.properties.floor)) &&
    (place.properties.navigationCoordinates || place.properties.category === "entrance")
  ).sort((a, b) => a.properties.name.localeCompare(b.properties.name));

  function confirmLandmark() {
    const place = landmarks.find(p => p.properties.id === landmark);
    if (!place?.geometry || !plan) return;
    const anchor = place.properties.navigationCoordinates ?? place.geometry.coordinates as Coordinate;
    if (distanceMetres(anchor, plan.endpoints[1]) < 2) {
      log({ type: "confirmed-arrival", landmark });
      if (session.current) {
        const current = session.current.snapshot();
        publish({ ...current, estimate: { ...current.estimate, coordinate: anchor, status: "tracking" }, instruction: "Destination confirmed.", remaining: 0, nearDestination: true }, false);
      }
      disposers.current.splice(0).forEach(dispose => dispose());
      setFinished(true); setNeedsAnchor(false); setMotion("active"); setNote("Destination confirmed."); return;
    }
    const path = findCampusRoute(anchor, plan.endpoints[1], undefined, { end: plan.traversals?.at(-1)?.edgeId });
    if (!path?.traversals?.length || path.endpointOffsets[0] > 15) {
      setNote("Choose a landmark with a mapped ground-floor approach."); return;
    }
    session.current = createWalkGuidance(path, faceRoute ? startingBearing(path) : undefined);
    log({ type: "reanchor", landmark, anchor, faceRoute });
    suspended.current = false; setNeedsAnchor(false);
    setFaceRoute(false);
    publish(session.current.snapshot(), false);
    setNote("Position confirmed at " + place.properties.name + ".");
  }

  return <div className="live-walk">
    {mode && frame ? <>
      <h3>{mode === "replay" ? (finished ? "Replay complete" : "Replaying B entrance to D") : "Live ground-floor walk"}</h3>
      <p className="walk-cue" role="status">{needsAnchor ? "Confirm a landmark to resume your walk." : frame.instruction}</p>
      <p className="walking-note">{frame.remaining !== null && !needsAnchor ? `About ${Math.round(frame.remaining)} m remaining. ` : ""}{frame.reroutes > 0 ? "Route updated after leaving the path. " : ""}{note}</p>
      {mode === "live" && !finished && <>
        {motionMessages[motion] && <p className="walking-note">{motionMessages[motion]}</p>}
        <label className="form-field">Current landmark<select value={landmark} onChange={e => { setLandmark(e.target.value); setFaceRoute(false); }}>
          <option value="">Choose a landmark you can see</option>
          {landmarks.map(p => <option key={p.properties.id} value={p.properties.id}>{p.properties.name}</option>)}
        </select></label>
        {landmark && <label className="walk-confirm"><input type="checkbox" checked={faceRoute} onChange={e => setFaceRoute(e.target.checked)} />I’m facing the path toward my destination.</label>}
        <button className="admin-button" type="button" disabled={!landmark} onClick={confirmLandmark}>I’m here</button>
        {hasTrial && <button className="admin-button" type="button" disabled={!landmark} onClick={() => {
          log({ type: "observed-checkpoint", landmark, coordinate: frame.estimate.coordinate, status: frame.estimate.status, suspended: suspended.current });
          setCheckpointCount(count => count + 1);
        }}>Log checkpoint only ({checkpointCount})</button>}
      </>}
      {mode === "live" && hasTrial && <button className="admin-button" type="button" onClick={exportTrial}>Download trial</button>}
      <button className="admin-button" type="button" onClick={stop}>{mode === "replay" ? "Close replay" : "End walk"}</button>
    </> : <>
      {plan?.traversals?.length ? <details><summary>Live ground-floor walk</summary>
        <p className="walking-note">Keep the phone in your hand and the map open. Begin at the marked path near {originLabel}.</p>
        <label className="walk-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I’m at the start, facing along the first segment.</label>
        <label className="walk-length">Metres per step <input type="number" min="0.3" max="1.3" step="0.01" value={stride} onChange={e => setStride(e.target.value)} /></label>
        <label className="walk-confirm"><input type="checkbox" checked={recordTrial} onChange={e => setRecordTrial(e.target.checked)} />Record this field test on this device for download.</label>
        <button className="location-button" type="button" onClick={live} disabled={!confirmed || !validStep}>Start walk</button>
      </details> : null}
      <div className="walk-demo"><label>Practice walk<select aria-label="Practice walk" value={scenario} onChange={e => setScenario(e.target.value as WalkReplayScenario)}>
        <option value="guided">B entrance to D</option><option value="wrong-turn">Wrong turn at the B atrium</option>
      </select></label><button type="button" className="admin-button" disabled={busy} onClick={replay}>Play replay</button></div>
      {note && <p role="status" className="walking-note">{note}</p>}
      {hasTrial && <button className="admin-button" type="button" onClick={exportTrial}>Download last trial</button>}
    </>}
  </div>;
}
