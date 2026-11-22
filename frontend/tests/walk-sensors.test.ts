import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStepDetector, getWalkLocation, relativeHeading, startWalkMotion, watchWalkLocation,
  type LocationSensorStatus, type MotionSensorStatus,
} from "../lib/navigation/walk-sensors.ts";

test("a synthetic walking bout preserves relative turns, slow and fast cadence, and unknown first heading", () => {
  for (const period of [380, 650, 1050]) {
    const detect = createStepDetector();
    const steps = [];
    for (let t = 0; t <= 1000 + 10 * period; t += 20) {
      const walking = t >= 500 && t < 500 + 10 * period;
      const magnitude = 9.81 + (walking ? 2.1 * Math.sin(2 * Math.PI * (t - 500) / period) : 0);
      const yaw = t < 500 + 6 * period ? 355 : 265;
      steps.push(...detect(t, magnitude, relativeHeading(yaw, 42, 0, 0)));
    }
    assert.deepEqual(steps, [undefined, 0, 0, 0, 0, 0, 90, 0, 0, 0], String(period));
  }
});

test("stopping and turning the handset in place adds neither steps nor a turn to the following bout", () => {
  const detect = createStepDetector();
  const turns = [];
  for (let t = 0; t < 9000; t += 20) {
    const walking = (t >= 500 && t < 2500) || (t >= 6000 && t < 8000);
    const shake = t >= 4200 && t < 4260 ? 5 : 0;
    const magnitude = 9.81 + shake + (walking ? 2 * Math.sin(2 * Math.PI * t / 500) : 0);
    turns.push(...detect(t, magnitude, t < 4300 ? 0 : 180));
  }
  assert.deepEqual(turns, [undefined, 0, 0, 0, undefined, 0, 0, 0]);
});

// Limit the fake browser to this test's lifetime; restore Node's own navigator.
function installBrowser(windowValue: object, documentValue: object, navigatorValue: object) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: windowValue, document: documentValue, navigator: navigatorValue })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

test("map and route preview share a watch; stale fixes and timeouts do not suppress valid later fixes", async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const watchers: { ok: PositionCallback; error: PositionErrorCallback }[] = [];
  const cleared: number[] = [];
  const geolocation = {
    watchPosition(ok: PositionCallback, error: PositionErrorCallback) { watchers.push({ ok, error }); return watchers.length; },
    clearWatch(id: number) { cleared.push(id); },
  };
  const restore = installBrowser({ isSecureContext: true, setTimeout, clearTimeout }, doc, { geolocation });
  let updates = 0;
  const statuses: LocationSensorStatus[] = [];
  const stop = watchWalkLocation(() => updates++, (status) => statuses.push(status));
  try {
    const preview = getWalkLocation(new AbortController().signal);
    assert.equal(watchers.length, 1);
    watchers[0].error({ code: 3 } as GeolocationPositionError);
    const coords = { latitude: 43, longitude: -81, accuracy: 10 };
    watchers[0].ok({ timestamp: Date.now() - 30_000, coords } as GeolocationPosition);
    assert.equal(updates, 0);
    watchers[0].ok({ timestamp: Date.now(), coords } as GeolocationPosition);
    assert.deepEqual((await preview).coordinate, [-81, 43]);
    assert.equal(updates, 1);
    assert.deepEqual(statuses, ["waiting", "unavailable", "active"]);
    assert.equal(watchers.length, 1);
    await getWalkLocation(new AbortController().signal); // already cached, synchronously delivered
    doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(cleared, [1]);
    watchers[0].ok({ timestamp: Date.now(), coords } as GeolocationPosition);
    assert.equal(updates, 1);
    doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(watchers.length, 2);
    const abort = new AbortController();
    const cancelled = getWalkLocation(abort.signal);
    abort.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    watchers[1].error({ code: 1 } as GeolocationPositionError);
    assert.equal(statuses.at(-1), "denied");
  } finally { stop(); restore(); }
  assert.deepEqual(cleared, [1, 2]);
});

test("motion permission settles safely after stopping and unsupported motion reports immediately", async () => {
  let enableMotion: (result: string) => void = () => {};
  let permissions = 0;
  const motionType = { requestPermission() {
    permissions++; return new Promise<string>((resolve) => { enableMotion = resolve; });
  } };
  const win = Object.assign(new EventTarget(), { isSecureContext: true, DeviceMotionEvent: motionType, clearInterval });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const restore = installBrowser(win, doc, {});
  try {
    const statuses: MotionSensorStatus[] = [];
    const callbacks = { onStatus: (status: MotionSensorStatus) => statuses.push(status), onStep: () => assert.fail("unexpected step") };
    const stop = startWalkMotion(callbacks);
    assert.equal(permissions, 1, "request permission in the caller's tap handler");
    stop();
    enableMotion("granted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(statuses, ["waiting"]);
    win.isSecureContext = false;
    startWalkMotion(callbacks)();
    assert.equal(statuses.at(-1), "insecure");
    assert.equal(permissions, 1);
  } finally { restore(); }
});

test("browser motion callbacks need finite samples, recover without an orientation sensor, and pause on hiding", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  let tick = () => {};
  const win = Object.assign(new EventTarget(), {
    isSecureContext: true, DeviceMotionEvent: {},
    setInterval(fn: () => void) { tick = fn; return 1; },
    clearInterval() {},
  });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const restore = installBrowser(win, doc, {});
  const turns: (number | undefined)[] = [];
  const statuses: MotionSensorStatus[] = [];
  let pauses = 0;
  const stop = startWalkMotion({
    onStep: (turn) => turns.push(turn),
    onStatus: (status) => statuses.push(status),
    onPause: () => pauses++,
  });
  function motion(z: number | null) {
    win.dispatchEvent(Object.assign(new Event("devicemotion"), {
      accelerationIncludingGravity: { x: 0, y: 0, z }, acceleration: null,
    }));
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 0)); // permission promises settle
    motion(null);
    now = 4000; tick();
    assert.equal(statuses.at(-1), "unavailable");
    for (; now < 7000; now += 20) motion(9.81 + (now >= 4500 ? 2 * Math.sin(2 * Math.PI * now / 500) : 0));
    assert.deepEqual(turns, Array(5).fill(undefined));
    assert.equal(statuses.at(-1), "active");
    now += 4000; tick();
    assert.equal(pauses, 1, "lost motion stream invokes the re-anchor callback");
    doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
    motion(20);
    assert.equal(statuses.at(-1), "paused");
    doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(statuses.at(-1), "waiting");
    stop();
    motion(9.81);
    assert.equal(statuses.at(-1), "waiting");
  } finally { stop(); restore(); }
});
