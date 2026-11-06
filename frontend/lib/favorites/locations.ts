import { readPlaceState } from "../places-repository.ts";
import type { PlaceFiles } from "../places-repository.ts";

export async function getLaunchLocationIds(files?: PlaceFiles): Promise<ReadonlySet<string>> {
  // Favorites use the same active catalog and stored places as the map,
  // including curated entries whose coordinates are still pending.
  const { places } = await readPlaceState(files);
  return new Set(places.map((place) => place.properties.id));
}
