import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocationFeature, PlaceInput } from "@/lib/place-types";

const dataDirectory = path.join(process.cwd(), "data");
const placesFile = path.join(dataDirectory, "places.json");
const deletedPlaceIdsFile = path.join(dataDirectory, "deleted-place-ids.json");

export async function readPlaces(): Promise<LocationFeature[]> {
  try {
    const contents = await readFile(placesFile, "utf8");
    return JSON.parse(contents) as LocationFeature[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function readDeletedPlaceIds(): Promise<string[]> {
  try {
    const contents = await readFile(deletedPlaceIdsFile, "utf8");
    return JSON.parse(contents) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function savePlace(input: PlaceInput): Promise<LocationFeature> {
  await mkdir(dataDirectory, { recursive: true });
  const places = await readPlaces();
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
  await writeFile(placesFile, JSON.stringify([...places, place], null, 2));
  return place;
}

export async function deletePlace(id: string): Promise<boolean> {
  const places = await readPlaces();
  const remaining = places.filter((place) => place.properties.id !== id);
  if (remaining.length !== places.length) {
    await writeFile(placesFile, JSON.stringify(remaining, null, 2));
    return true;
  }
  const deletedIds = await readDeletedPlaceIds();
  if (deletedIds.includes(id)) return false;
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    deletedPlaceIdsFile,
    JSON.stringify([...deletedIds, id], null, 2),
  );
  return true;
}
