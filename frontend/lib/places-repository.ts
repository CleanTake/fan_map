import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocationFeature, PlaceInput } from "@/lib/place-types";

const dataDirectory = path.join(process.cwd(), "data");
const placesFile = path.join(dataDirectory, "places.json");

export async function readPlaces(): Promise<LocationFeature[]> {
  try {
    const contents = await readFile(placesFile, "utf8");
    return JSON.parse(contents) as LocationFeature[];
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
