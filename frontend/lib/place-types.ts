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
};

export type LocationFeature = GeoJSON.Feature<GeoJSON.Point, FeatureProperties>;

export type PlaceInput = {
  name: string;
  category: Category;
  description: string;
  coordinates: [number, number];
};
