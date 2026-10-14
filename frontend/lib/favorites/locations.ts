import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function getLaunchLocationIds(): Promise<ReadonlySet<string>> {
  const path = resolve(process.cwd(), "..", "data", "launch-locations.geojson");
  const collection = JSON.parse(await readFile(path, "utf8")) as {
    features: { properties?: { id?: unknown } }[];
  };
  // Save any catalog location, including entries whose coordinates are pending.
  return new Set(collection.features.flatMap((feature) =>
    typeof feature.properties?.id === "string" ? [feature.properties.id] : [],
  ));
}
