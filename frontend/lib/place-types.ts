export type Category =
  | "building"
  | "entrance"
  | "room"
  | "parking"
  | "food"
  | "retail"
  | "service"
  | "bus";

export type FeatureProperties = {
  id: string;
  category: Category;
  name: string;
  description: string;
  availability?: string;
  hours?: string;
  studyId?: string;
  stop?: string;
  groups?: string[];
  aliases?: string[];
  launchLabels?: string[];
  childIds?: string[];
  status?: "open" | "unknown" | "closed_temporarily" | "closed_permanently";
  resolutionStatus?: string;
  catalogCategory?: string;
  roomCode?: string | null;
  buildingCode?: string | null;
  floor?: number | null;
  sourceIds?: string[];
};

export type LocationFeature = GeoJSON.Feature<GeoJSON.Point | null, FeatureProperties>;
export type MappedLocationFeature = GeoJSON.Feature<GeoJSON.Point, FeatureProperties>;

export function isMappedPoint(feature: LocationFeature): feature is MappedLocationFeature {
  const coordinates = feature.geometry?.coordinates;
  return feature.geometry?.type === "Point" && Array.isArray(coordinates) &&
    coordinates.length === 2 && coordinates.every(Number.isFinite) &&
    Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
}

export type PlaceInput = {
  name: string;
  category: Category;
  description: string;
  coordinates: [number, number];
};
