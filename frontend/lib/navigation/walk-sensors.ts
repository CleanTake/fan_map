import type { Coordinate } from "./directions.ts";

export type LocationSensorStatus = "waiting" | "active" | "unavailable" | "denied" | "insecure" | "paused";
export type MotionSensorStatus = LocationSensorStatus;
export type WalkLocationFix = { coordinate: Coordinate; accuracyMetres: number; timestamp: number };
type LocationListener = {
  onFix: (fix: WalkLocationFix) => void;
  onStatus?: (status: LocationSensorStatus) => void;
};

const listeners = new Set<LocationListener>();
const maxFixAgeMs = 10_000;
let watchId: number | null = null;
let generation = 0;
let locationStatus: LocationSensorStatus = "waiting";
let lastFix: WalkLocationFix | undefined;

function notifyLocation(status: LocationSensorStatus) {
  locationStatus = status;
  for (const listener of listeners) listener.onStatus?.(status);
}

function clearPositionWatch() {
  generation++;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastFix = undefined;
}

function startPositionWatch() {
  clearPositionWatch();
  if (document.hidden) { notifyLocation("paused"); return; }
  notifyLocation("waiting");
  const current = generation;
  try {
    const id = navigator.geolocation.watchPosition((position) => {
      if (current !== generation) return;
      const { longitude, latitude, accuracy } = position.coords;
      const age = Date.now() - position.timestamp;
      if (![longitude, latitude, accuracy, age].every(Number.isFinite) || Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180 || accuracy <= 0 || age < -1000 || age > maxFixAgeMs) return;
      if (lastFix && position.timestamp <= lastFix.timestamp) return;
      lastFix = { coordinate: [longitude, latitude], accuracyMetres: accuracy, timestamp: position.timestamp };
      const fix = lastFix;
      notifyLocation("active");
      for (const listener of listeners) listener.onFix(fix);
    }, (error) => {
      if (current !== generation) return;
      // Browsers keep watching after a timeout or a temporarily unavailable fix.
      if (error.code === 1) clearPositionWatch();
      notifyLocation(error.code === 1 ? "denied" : "unavailable");
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 12_000 });
    if (current === generation) watchId = id;
    else navigator.geolocation.clearWatch(id);
  } catch {
    notifyLocation("unavailable");
  }
}

/** Subscribe only after the user asks for location. All consumers share one watch. */
export function watchWalkLocation(onFix: LocationListener["onFix"], onStatus?: LocationListener["onStatus"]): () => void {
  if (typeof window === "undefined" || !window.isSecureContext || !navigator.geolocation) {
    onStatus?.(typeof window !== "undefined" && !window.isSecureContext ? "insecure" : "unavailable");
    return () => {};
  }
  const listener = { onFix, onStatus };
  listeners.add(listener);
  if (listeners.size === 1) document.addEventListener("visibilitychange", startPositionWatch);
  if (listeners.size === 1 || locationStatus === "denied") startPositionWatch();
  else {
    onStatus?.(locationStatus);
    if (lastFix && Date.now() - lastFix.timestamp <= maxFixAgeMs) onFix(lastFix);
  }
  return () => {
    if (!listeners.delete(listener) || listeners.size) return;
    document.removeEventListener("visibilitychange", startPositionWatch);
    clearPositionWatch();
  };
}

/** Obtain a single fresh preview fix, also when a subscriber already has one. */
export function getWalkLocation(signal: AbortSignal): Promise<WalkLocationFix> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.isSecureContext || !navigator.geolocation) {
      reject(new Error("Phone location needs HTTPS and a browser with location support."));
      return;
    }
    let unsubscribe = () => {};
    let finished = false;
    const abort = () => { cleanup(); reject(new DOMException("Location request cancelled.", "AbortError")); };
    const timeout = window.setTimeout(() => {
      cleanup(); reject(new Error("Could not get a fresh location. Choose a starting landmark or try again outdoors."));
    }, 15_000);
    function cleanup() {
      finished = true;
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = watchWalkLocation((fix) => { cleanup(); resolve(fix); }, (status) => {
      if (status === "denied") { cleanup(); reject(new Error("Allow location access or choose a starting landmark.")); }
    });
    if (finished) unsubscribe();
  });
}

type Vector = { x: number | null; y: number | null; z: number | null };
function magnitude(vector: Vector | null) {
  if (!vector || vector.x === null || vector.y === null || vector.z === null) return null;
  const result = Math.hypot(vector.x, vector.y, vector.z);
  return Number.isFinite(result) ? result : null;
}

const rad = Math.PI / 180;
function signedAngle(degrees: number) { return ((degrees + 540) % 360) - 180; }

// Project a forward vector (screen top and away from the face) onto the horizontal
// plane. This is usable with the phone held flat or tilted up to read the map.
// Both the arbitrary orientation reference and magnetic north cancel in step deltas.
export function relativeHeading(alpha: number, beta: number, gamma: number, screenAngle: number) {
  if (![alpha, beta, gamma, screenAngle].every(Number.isFinite)) return undefined;
  const a = alpha * rad, b = beta * rad, g = gamma * rad, s = screenAngle * rad;
  const x = Math.cos(g) * Math.sin(s) - Math.sin(g);
  const z = -Math.sin(g) * Math.sin(s) - Math.cos(g);
  const y = Math.cos(b) * Math.cos(s) - Math.sin(b) * z;
  if (Math.hypot(x, y) < 0.3) return undefined;
  return signedAngle(Math.atan2(x, y) / rad - a / rad);
}

// Thresholds are initial values for a handheld walking pilot. Require two
// gait-like pulses before accepting a new bout; an isolated bump is discarded.
export function createStepDetector() {
  let baseline = 0, filtered = 0, armed = false;
  let lastTime: number | undefined;
  let lastPulse = -Infinity, lastHeading: number | undefined, walking = false;
  return (time: number, accelerationMagnitude: number, heading?: number): (number | undefined)[] => {
    if (!Number.isFinite(time) || !Number.isFinite(accelerationMagnitude)) return [];
    if (lastTime !== undefined && time <= lastTime) return [];
    if (lastTime === undefined || time - lastTime > 250) {
      baseline = accelerationMagnitude;
      filtered = 0; armed = false; walking = false; lastPulse = -Infinity;
      lastHeading = undefined; lastTime = time;
      return [];
    }
    const dt = time - lastTime;
    lastTime = time;
    baseline += (1 - Math.exp(-dt / 700)) * (accelerationMagnitude - baseline);
    filtered += (1 - Math.exp(-dt / 50)) * (accelerationMagnitude - baseline - filtered);
    if (filtered > 0.85) armed = true;
    if (!armed || filtered > 0.1) return [];
    armed = false;
    const interval = time - lastPulse;
    if (interval < 290) return [];
    const turn = lastHeading === undefined || heading === undefined ? undefined : signedAngle(heading - lastHeading);
    lastPulse = time; lastHeading = heading;
    if (interval > 1250) { walking = false; return []; }
    const steps = walking ? [turn] : [undefined, turn];
    walking = true;
    return steps;
  };
}

type PermissionConstructor = { requestPermission?: () => Promise<string> };
function sensorPermission(type: PermissionConstructor | undefined) {
  if (!type) return Promise.resolve(false);
  return Promise.resolve(type.requestPermission ? type.requestPermission() : "granted")
    .then((result) => result === "granted", () => false);
}

type MotionCallbacks = {
  onStep: (turnDegrees: number | undefined) => void;
  onStatus: (status: MotionSensorStatus) => void;
  onPause?: () => void;
};

/** Call directly in the Start walk click handler so permission prompts have user activation. */
export function startWalkMotion({ onStep, onStatus, onPause }: MotionCallbacks): () => void {
  if (typeof window === "undefined" || !window.isSecureContext || !window.DeviceMotionEvent) {
    onStatus(typeof window !== "undefined" && !window.isSecureContext ? "insecure" : "unavailable");
    return () => {};
  }
  let stopped = false;
  let status: MotionSensorStatus = "waiting";
  let detect = createStepDetector();
  let heading: number | undefined, headingTime = -Infinity;
  let screenAngle: number | undefined, previousSource: string | undefined;
  let lastSample: number | undefined;
  let watchdog: number | undefined;
  function report(next: MotionSensorStatus) {
    if (next !== status && !stopped) { status = next; onStatus(next); }
  }
  function reset() {
    detect = createStepDetector();
    heading = undefined; headingTime = -Infinity; lastSample = undefined;
  }
  function angle() {
    const legacy = window as Window & { orientation?: number };
    return window.screen.orientation?.angle ?? legacy.orientation ?? 0;
  }
  function onOrientation(event: DeviceOrientationEvent) {
    if (stopped || document.hidden) return;
    const currentAngle = angle();
    if (screenAngle !== undefined && currentAngle !== screenAngle) reset();
    screenAngle = currentAngle;
    const { alpha, beta, gamma } = event;
    heading = alpha === null || beta === null || gamma === null ? undefined : relativeHeading(alpha, beta, gamma, currentAngle);
    headingTime = performance.now();
  }
  function onMotion(event: DeviceMotionEvent) {
    if (stopped || document.hidden) return;
    const gravity = magnitude(event.accelerationIncludingGravity);
    const withGravity = gravity !== null && gravity > 1;
    const amplitude = withGravity ? gravity : magnitude(event.acceleration);
    if (amplitude === null || amplitude > 45) return;
    const time = performance.now();
    const source = withGravity ? "gravity" : "linear";
    if (lastSample !== undefined && time - lastSample > 2000) { reset(); onPause?.(); }
    if (previousSource !== source) detect = createStepDetector();
    previousSource = source;
    lastSample = time;
    report("active");
    for (const turn of detect(time, amplitude, time - headingTime < 450 ? heading : undefined)) onStep(turn);
  }
  function onVisibility() {
    reset();
    report(document.hidden ? "paused" : "waiting");
    if (document.hidden) onPause?.();
  }
  onStatus("waiting");
  const motion = window.DeviceMotionEvent as unknown as PermissionConstructor;
  const orientation = window.DeviceOrientationEvent as unknown as PermissionConstructor | undefined;
  // Invoke both while the tap is still active, even on platforms where they prompt separately.
  const enable = async () => {
    const [motionGranted, orientationGranted] = await Promise.all([sensorPermission(motion), sensorPermission(orientation)]);
    if (stopped) return;
    if (!motionGranted) { report("denied"); return; }
    if (orientationGranted) window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    let waitingSince = performance.now();
    watchdog = window.setInterval(() => {
      if (document.hidden) { waitingSince = performance.now(); return; }
      if (performance.now() - (lastSample ?? waitingSince) < 3000) return;
      if (status === "active") { reset(); onPause?.(); }
      report("unavailable");
    }, 1000);
    if (document.hidden) onVisibility();
  };
  void enable().catch(() => report("unavailable"));
  return () => {
    stopped = true;
    window.clearInterval(watchdog);
    window.removeEventListener("deviceorientation", onOrientation);
    window.removeEventListener("devicemotion", onMotion);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
