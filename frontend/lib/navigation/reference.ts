import registration from "../../data/navigation/reference-registration.json" with { type: "json" };
import draft from "../../data/navigation/reference-passages.json" with { type: "json" };
import network from "../../data/navigation/campus-network.json" with { type: "json" };
import type { Coordinate } from "./directions.ts";

const radius = 6378137;
export const referenceRegistration = registration;
export const referenceReviewSummary = {
  annotationCount: draft.reviews.reduce((total, review) => total + review.annotationCount, 0),
  connectionCount: draft.reviews.reduce((total, review) => total + review.connectionCount, 0),
  latestDate: draft.reviews.at(-1)?.date,
};

export function pixelToCoordinate(pixel: readonly number[]): Coordinate {
  if (pixel.length !== 2 || !pixel.every(Number.isFinite)) throw new Error("Invalid reference pixel.");
  const projected = registration.pixelToMercator.map(([a, b, c], axis) => registration.mercatorOrigin[axis] + a * pixel[0] + b * pixel[1] + c);
  return [projected[0] / radius * 180 / Math.PI, Math.atan(Math.sinh(projected[1] / radius)) * 180 / Math.PI];
}

export function coordinateToPixel(coordinate: readonly number[]): [number, number] {
  if (coordinate.length !== 2 || !coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 85.051129) throw new Error("Invalid reference coordinate.");
  const [[a, b, c], [d, e, f]] = registration.pixelToMercator;
  const x = radius * coordinate[0] * Math.PI / 180 - registration.mercatorOrigin[0] - c;
  const y = radius * Math.asinh(Math.tan(coordinate[1] * Math.PI / 180)) - registration.mercatorOrigin[1] - f;
  const determinant = a * e - b * d;
  if (Math.abs(determinant) < 1e-12) throw new Error("Reference registration is singular.");
  return [(e * x - b * y) / determinant, (a * y - d * x) / determinant];
}

export const referenceCorners = [[0, 0], [830, 0], [830, 521], [0, 521]].map(pixelToCoordinate) as [Coordinate, Coordinate, Coordinate, Coordinate];
export const referenceFocusCorners = [[215, 125], [675, 125], [675, 475], [215, 475]].map(pixelToCoordinate);
export const referenceBearing = Math.atan2(-registration.pixelToMercator[0][1], -registration.pixelToMercator[1][1]) * 180 / Math.PI;

export const referenceQuestions = draft.questions.map((question) => ({
  id: question.id, title: question.title, question: question.question,
  status: question.status, answer: question.answer,
  coordinates: "coordinates" in question && question.coordinates ? question.coordinates as Coordinate : pixelToCoordinate(question.pixel!),
}));

const sourcePassages = new Map(draft.passages.map((passage) => [passage.id, passage]));

/** Review the actual campus graph, including generated entrance approaches. */
export const referencePassages: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  type: "FeatureCollection",
  features: network.edges.filter((edge) => !edge.sourceId.startsWith("osm-way:")).map((edge) => {
    const passage = sourcePassages.get(edge.sourceId);
    return {
      type: "Feature", id: edge.id,
      properties: { id: edge.sourceId, edgeId: edge.id, label: edge.label, kind: edge.kind, status: draft.status,
        reviewAnnotationId: passage && "reviewAnnotationId" in passage ? passage.reviewAnnotationId : null },
      geometry: { type: "LineString", coordinates: [network.nodes[edge.from as keyof typeof network.nodes], network.nodes[edge.to as keyof typeof network.nodes]] },
    };
  }),
};

export const referenceQuestionFeatures: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: referenceQuestions.filter((question) => question.status !== "removed").map((question) => ({ type: "Feature", properties: { id: question.id, title: question.title, status: question.status }, geometry: { type: "Point", coordinates: question.coordinates } })),
};
