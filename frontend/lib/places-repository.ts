import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocationFeature, PlaceInput } from "./place-types.ts";

const dataDirectory = path.join(process.cwd(), "data");
export type PlaceFiles = {
  placesFile: string;
  deletedPlaceIdsFile: string;
  launchFile: string;
};
const defaultFiles: PlaceFiles = {
  placesFile: path.join(dataDirectory, "places.json"),
  deletedPlaceIdsFile: path.join(dataDirectory, "deleted-place-ids.json"),
  launchFile: path.resolve(process.cwd(), "..", "data", "launch-locations.geojson"),
};

export async function readPlaces(files = defaultFiles): Promise<LocationFeature[]> {
  try {
    const contents = await readFile(files.placesFile, "utf8");
    return JSON.parse(contents) as LocationFeature[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function readDeletedPlaceIds(files = defaultFiles): Promise<string[]> {
  try {
    const contents = await readFile(files.deletedPlaceIdsFile, "utf8");
    return JSON.parse(contents) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function readPlaceState(files = defaultFiles): Promise<{
  places: LocationFeature[];
  deletedIds: string[];
}> {
  const [launchContents, stored, deletedIds] = await Promise.all([
    readFile(files.launchFile, "utf8"),
    readPlaces(files),
    readDeletedPlaceIds(files),
  ]);
  const launch = JSON.parse(launchContents) as GeoJSON.FeatureCollection<GeoJSON.Point | null, LocationFeature["properties"]>;
  if (launch.type !== "FeatureCollection" || !Array.isArray(launch.features)) {
    throw new Error("Invalid launch locations.");
  }
  // Keep both upstream places and curated locations. Catalog anchors take
  // precedence for shared IDs, so a pending point never borrows an estimate.
  const combined = new Map([...stored, ...launch.features].map((place) => [place.properties.id, place]));
  return {
    places: [...combined.values()].filter((place) => !deletedIds.includes(place.properties.id)),
    deletedIds,
  };
}

export async function savePlace(input: PlaceInput, files = defaultFiles): Promise<LocationFeature> {
  await mkdir(path.dirname(files.placesFile), { recursive: true });
  const places = await readPlaces(files);
  const place: LocationFeature = {
    type: "Feature",
    properties: {
      id: `place-${crypto.randomUUID()}`,
      name: input.name,
      category: input.category,
      description: input.description,
    },
    geometry: { type: "Point", coordinates: input.coordinates },
  };
  await writeFile(files.placesFile, JSON.stringify([...places, place], null, 2));
  return place;
}

export async function deletePlace(id: string, files = defaultFiles): Promise<boolean> {
  const places = await readPlaces(files);
  const remaining = places.filter((place) => place.properties.id !== id);
  const removedStored = remaining.length !== places.length;
  if (removedStored) {
    await writeFile(files.placesFile, JSON.stringify(remaining, null, 2));
  }
  const deletedIds = await readDeletedPlaceIds(files);
  if (deletedIds.includes(id)) return removedStored;
  await mkdir(path.dirname(files.deletedPlaceIdsFile), { recursive: true });
  await writeFile(
    files.deletedPlaceIdsFile,
    JSON.stringify([...deletedIds, id], null, 2),
  );
  return true;
}
