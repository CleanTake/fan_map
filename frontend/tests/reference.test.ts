import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pixelToCoordinate, coordinateToPixel, referenceCorners, referencePassages, referenceQuestions, referenceRegistration } from "../lib/navigation/reference.ts";

test("reference placement round-trips pixels and has the correct image corner order", () => {
  for (const pixel of [[0, 0], [830, 0], [830, 521], [0, 521], [449, 350]]) {
    const roundTrip = coordinateToPixel(pixelToCoordinate(pixel));
    assert.ok(Math.abs(roundTrip[0] - pixel[0]) < 0.000001);
    assert.ok(Math.abs(roundTrip[1] - pixel[1]) < 0.000001);
  }
  assert.deepEqual(referenceCorners[0], pixelToCoordinate([0, 0]));
  assert.deepEqual(referenceCorners[2], pixelToCoordinate([830, 521]));
  assert.ok(referenceCorners.every(([lng, lat]) => lng > -81.22 && lng < -81.18 && lat > 43 && lat < 43.03));
  assert.throws(() => pixelToCoordinate([NaN, 0]));
  assert.throws(() => coordinateToPixel([0, 90]));
});

test("registration preserves the supplied image and its independent error measurements", async () => {
  const image = await readFile(resolve(import.meta.dirname, "../public/navigation/campus-reference.png"));
  assert.equal(createHash("sha256").update(image).digest("hex"), referenceRegistration.imageSha256);
  const checks = referenceRegistration.controlPoints.filter((point) => point.role === "check");
  assert.equal(checks.length, 6);
  for (const point of checks) {
    const predicted = pixelToCoordinate(point.pixel);
    const metres = Math.hypot((predicted[0] - point.coordinates[0]) * Math.cos(43.013 * Math.PI / 180), predicted[1] - point.coordinates[1]) * 111320;
    assert.ok(Math.abs(metres - point.errorMetres) < 0.08);
  }
  assert.equal(referenceRegistration.status, "approximate-schematic-registration");
  assert.ok(referenceRegistration.checkMaxMetres > 10, "Expose the schematic mismatch instead of claiming door-level accuracy");
});

test("the reference records the user's confirmed connections and placeholder removal", () => {
  assert.ok(referencePassages.features.length > 18);
  assert.equal(referenceQuestions.length, 6);
  assert.equal(new Set(referenceQuestions.map((question) => question.id)).size, 6);
  for (const passage of referencePassages.features) {
    assert.equal(passage.properties?.status, "topology-user-confirmed");
    assert.ok(passage.geometry.coordinates.length >= 2);
  }
  assert.deepEqual(referenceQuestions.find((question) => question.id === "Q6")?.coordinates, [-81.19993, 43.01259]);
  assert.equal(referenceQuestions.find((question) => question.id === "Q6")?.status, "removed");
  assert.ok(referenceQuestions.every((question) => question.answer.length > 0));
});
