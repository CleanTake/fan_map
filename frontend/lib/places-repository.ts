import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocationFeature, PlaceInput } from "./place-types.ts";

const dataDirectory = path.join(process.cwd(), "data");
export type PlaceFiles = {
  placesFile: string;
  deletedPlaceIdsFile: string;
  launchFile: string;
  overridesFile: string;
};

async function readOverrides(files: PlaceFiles): Promise<LocationFeature[]> {
  try {
    return JSON.parse(await readFile(files.overridesFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

// Serialize read/modify/write operations in this single-server JSON store.
const shared = globalThis as typeof globalThis & { fanmapPlaceWrites?: Map<string, Promise<unknown>> };
const writes = shared.fanmapPlaceWrites ??= new Map<string, Promise<unknown>>();
function mutate<T>(files: PlaceFiles, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(files.placesFile);
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(key, next);
  void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => {});
  return next;
}
const defaultFiles: PlaceFiles = {
  placesFile: path.join(dataDirectory, "places.json"),
  deletedPlaceIdsFile: path.join(dataDirectory, "deleted-place-ids.json"),
  overridesFile: path.join(dataDirectory, "place-overrides.json"),
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
  const [launchContents, stored, deletedIds, overrides] = await Promise.all([
    readFile(files.launchFile, "utf8"),
    readPlaces(files),
    readDeletedPlaceIds(files),
    readOverrides(files),
  ]);
  const launch = JSON.parse(launchContents) as GeoJSON.FeatureCollection<GeoJSON.Point | null, LocationFeature["properties"]>;
  if (launch.type !== "FeatureCollection" || !Array.isArray(launch.features)) {
    throw new Error("Invalid launch locations.");
  }
  // Keep both upstream places and curated locations. Catalog anchors take
  // precedence for shared IDs, so a pending point never borrows an estimate.
  const combined = new Map([...stored, ...launch.features].map((place) => [place.properties.id, place]));
  // Only explicit admin edits override catalog data, preserving IDs and metadata.
  for (const place of overrides) {
    if (combined.has(place.properties.id)) combined.set(place.properties.id, place);
  }
  return {
    places: [...combined.values()].filter((place) => !deletedIds.includes(place.properties.id)),
    deletedIds,
  };
}

export async function savePlace(input: PlaceInput, files = defaultFiles): Promise<LocationFeature> {
  return mutate(files, async () => {
    const places = await readPlaces(files);
    const place: LocationFeature = {
      type: "Feature",
      properties: {
        id: `place-${crypto.randomUUID()}`,
        name: input.name,
        category: input.category,
        description: input.description,
      },
      geometry: input.coordinates ? { type: "Point", coordinates: input.coordinates } : null,
    };
    await writeJson(files.placesFile, [...places, place]);
    return place;
  });
}

export async function updatePlace(id: string, input: PlaceInput, files = defaultFiles): Promise<LocationFeature | null> {
  return mutate(files, async () => {
    const existing = (await readPlaceState(files)).places.find((place) => place.properties.id === id);
    if (!existing) return null;
    const updated: LocationFeature = {
      ...existing,
      properties: { ...existing.properties, name: input.name, category: input.category, description: input.description },
      geometry: input.coordinates ? { type: "Point", coordinates: input.coordinates } : null,
    };
    const overrides = await readOverrides(files);
    await writeJson(files.overridesFile, [...overrides.filter((place) => place.properties.id !== id), updated]);
    return updated;
  });
}

export async function deletePlace(id: string, files = defaultFiles): Promise<boolean> {
  return mutate(files, async () => {
    const { places, deletedIds } = await readPlaceState(files);
    if (!places.some((place) => place.properties.id === id)) return false;
    await writeJson(files.deletedPlaceIdsFile, [...deletedIds, id]);
    return true;
  });
}
