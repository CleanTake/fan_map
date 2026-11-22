import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import source from "../data/navigation/reference-passages.json" with { type: "json" };
import compiled from "../data/navigation/campus-network.json" with { type: "json" };
import { campusNetwork, distanceMetres, findCampusRoute } from "../lib/navigation/campus-router.ts";
import { readPlaceState } from "../lib/places-repository.ts";
import { pixelToCoordinate as pixel, referencePassages, referenceReviewSummary } from "../lib/navigation/reference.ts";

const review = source.reviews.find((entry) => entry.date === "2026-11-22")!;
const additions = source.passages.filter((passage) => "reviewAnnotationId" in passage);

test("the original review is preserved and every one of its 17 additions reaches the routing graph and overlay", async () => {
  const original = await readFile(new URL("../data/navigation/reviews/2026-11-22.json", import.meta.url));
  assert.equal(createHash("sha256").update(original).digest("hex"), review.sourceSha256);
  const raw = JSON.parse(original.toString());
  assert.equal(raw.annotations.length, 17);
  assert.equal(referenceReviewSummary.annotationCount, 22);
  assert.equal(referenceReviewSummary.connectionCount, 20);
  assert.equal(referenceReviewSummary.latestDate, "2026-11-22");
  for (const annotation of raw.annotations) {
    const parts = additions.filter((part) => part.reviewAnnotationId === annotation.id);
    assert.ok(parts.length > 0, annotation.id);
    for (const part of parts) {
      assert.ok(campusNetwork.edges.some((edge) => edge.sourceId === part.id), part.id);
      assert.ok(referencePassages.features.some((feature) => feature.properties?.id === part.id), part.id);
    }
  }
});

test("all reviewed edges share the existing campus component rather than appearing as disconnected lines", () => {
  const anchor = campusNetwork.edges.find((edge) => edge.sourceId === "D-west")!.from;
  const neighbors = new Map<string, string[]>();
  for (const edge of campusNetwork.edges) {
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set([anchor]), queue = [anchor];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbors.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  for (const edge of campusNetwork.edges.filter((item) => item.sourceId?.startsWith("review-"))) {
    assert.ok(seen.has(edge.from) && seen.has(edge.to), edge.sourceId!);
  }
});

test("straightening keeps the drawn shape within four pixels and preserves intentional bends", () => {
  assert.ok(review.maximumShapeOffsetPixels < 4);
  assert.ok(review.normalization.every((entry) => entry.maxShapeOffsetPixels < 4));
  for (const id of ["A004", "A006", "A015", "A016"]) {
    const normalized = review.normalization.find((entry) => entry.annotationId === id)!;
    assert.equal(new Set(normalized.pixels.map(([x]) => x)).size, 1, id);
  }
  assert.deepEqual(review.normalization.find((entry) => entry.annotationId === "A003")!.pixels, [[551, 418], [511, 418]]);
  assert.ok(review.normalization.find((entry) => entry.annotationId === "A007")!.pixels.length >= 5);
  assert.deepEqual(review.normalization.find((entry) => entry.annotationId === "A010")!.pixels[0], [414, 177]);
});

test("near-miss endpoints form actual shared junctions, including the short A011 connector", () => {
  const connector = campusNetwork.edges.find((edge) => edge.sourceId === "review-A011-r1-door")!;
  assert.equal(connector.kind, "door");
  assert.ok([connector.from, connector.to].some((id) => campusNetwork.edges.some((edge) => edge.sourceId === "review-A010-r1" && [edge.from, edge.to].includes(id))));
  assert.ok([connector.from, connector.to].some((id) => campusNetwork.edges.some((edge) => edge.sourceId === "review-A008-walkway" && [edge.from, edge.to].includes(id))));
  const first = additions.find((part) => part.id === "review-A001-walkway")!;
  const westG = additions.find((part) => part.id === "review-A009-walkway")!;
  assert.deepEqual(first.pixels.at(-1), westG.pixels.at(-1));
  const [x, y] = first.pixels.at(-1)!;
  assert.ok(Math.abs(y - (263 + (x - 414) * 18 / 19)) < 1e-8, "Joint lies on the existing J-SUB path");
});

test("new indoor corridors and outdoor crossings participate in shortest routes with their doorway transitions", () => {
  const atrium = findCampusRoute(pixel([383, 400]), pixel([383, 445]));
  assert.ok(atrium?.segments?.some((segment) => segment.label === "B central atrium corridor"));
  assert.ok(atrium?.segments?.every((segment) => segment.kind === "indoor"));
  const courtyard = findCampusRoute(pixel([554, 418]), pixel([511, 400]));
  assert.ok(courtyard?.steps.some((step) => step.instruction === "A / Alumni Lecture Theatre courtyard walkway"));
  assert.ok(courtyard?.segments?.some((segment) => segment.kind === "door"));
  const residence = findCampusRoute(pixel([337, 177]), pixel([389, 160]));
  assert.ok(residence?.steps.some((step) => step.instruction === "Student Centre / R2 Student Road crossing"));
  assert.equal(residence?.source, "campus");
});

test("the cumulative entrance review preserves the first 17 marks and adds only its five new strokes", async () => {
  const originalBytes = await readFile(new URL("../data/navigation/reviews/2026-11-22.json", import.meta.url));
  const updatedBytes = await readFile(new URL("../data/navigation/reviews/2026-11-22-entrances.json", import.meta.url));
  const original = JSON.parse(originalBytes.toString()), updated = JSON.parse(updatedBytes.toString());
  const entranceReview = source.reviews.find((entry) => entry.sourceFile.endsWith("-entrances.json"))!;
  assert.equal(createHash("sha256").update(updatedBytes).digest("hex"), entranceReview.sourceSha256);
  assert.equal(entranceReview.annotationCount, 5);
  assert.equal(entranceReview.connectionCount, 3);
  assert.deepEqual(updated.annotations.slice(0, 17), original.annotations);
  for (const annotation of updated.annotations.slice(17)) {
    const parts = additions.filter((part) => part.reviewAnnotationId === annotation.id);
    assert.ok(parts.length > 0, annotation.id);
    assert.ok(parts.every((part) => campusNetwork.edges.some((edge) => edge.sourceId === part.id)));
  }
  assert.ok(entranceReview.maximumShapeOffsetPixels < 3);
});

test("F and M entrance approaches join imported outdoor paths and route through their indoor doorways", () => {
  assert.equal(compiled.outdoorJoins.length, 2);
  for (const join of compiled.outdoorJoins) {
    const touching = campusNetwork.edges.filter((edge) => [edge.from, edge.to].includes(join.nodeId));
    assert.ok(touching.some((edge) => edge.sourceId === `osm-way:${join.osmWayId}`));
    assert.ok(touching.some((edge) => edge.sourceId?.startsWith(join.id.includes("A018") ? "review-A018" : "review-A019")));
  }
  for (const [start, end, doorway] of [
    [[547, 279.4809542504145], [531, 300], "Pass through F main entrance"],
    [[663, 215], [639, 215], "Pass through the M east doorway"],
  ] as const) {
    const route = findCampusRoute(pixel(start), pixel(end));
    assert.ok(route);
    assert.ok(route.steps.some((step) => step.instruction === doorway));
    assert.ok(route.segments?.some((segment) => segment.kind === "outdoor"));
    assert.ok(route.segments?.some((segment) => segment.kind === "indoor"));
    assert.ok(route.distanceMetres < 45, "Use the short entrance link rather than a campus detour");
  }
});

test("the T-B hallway retains its curve, joins all three drawing strokes, and stays indoors", () => {
  const west = additions.find((part) => part.id === "review-A020-t-b-west-curve")!;
  const branch = additions.find((part) => part.id === "review-A021-t-b-branch")!;
  const east = additions.find((part) => part.id === "review-A022-t-b-east-curve")!;
  assert.ok(west.pixels.length >= 6 && east.pixels.length >= 5);
  assert.deepEqual(west.pixels.at(-1), branch.pixels[0]);
  assert.deepEqual(west.pixels.at(-2), east.pixels[0]);
  assert.deepEqual(branch.pixels.at(-1), [317, 451]);
  for (const [start, end] of [[[280, 458], [317, 459.5]], [[331, 464], [364.3, 451]], [[317, 462], [317, 445]]] as const) {
    const route = findCampusRoute(pixel(start), pixel(end));
    assert.ok(route?.steps.some((step) => step.instruction.includes("curved")));
    assert.ok(route?.segments?.every((segment) => segment.kind === "indoor"));
  }
});

test("B's public entrance routes into its corridor and its complete entrance link is visible in review", async () => {
  const { places } = await readPlaceState();
  const entrance = places.find((place) => place.properties.id === "place-886b658a-c24c-41d7-a235-f2c9036d3246")!;
  assert.ok(entrance.geometry);
  const route = findCampusRoute(entrance.geometry.coordinates as [number, number], pixel([383, 425]));
  assert.ok(route);
  assert.equal(route.source, "campus");
  assert.ok(route.steps.some((step) => step.instruction === "Pass through B south entrance"));
  assert.ok(route.steps.some((step) => step.instruction === "B south entrance passage"));
  assert.ok(route.distanceMetres < 80);
  const approach = referencePassages.features.filter((feature) => feature.properties?.id === "approach-10739091793");
  const doorway = referencePassages.features.filter((feature) => feature.properties?.id === "door-10739091793");
  assert.ok(approach.length > 0 && doorway.length > 0, "Review must show the generated approach and doorway");
  assert.ok(approach.some((feature) => feature.geometry.coordinates.some((coordinate) => distanceMetres(coordinate, pixel([364.3, 451])) < 0.1)));
  assert.ok(doorway.some((feature) => feature.geometry.coordinates.some((coordinate) => distanceMetres(coordinate, entrance.geometry!.coordinates) < 1)));
});
