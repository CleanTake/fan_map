import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUTLINES_DIR = resolve(process.cwd(), "..", "data", "building_outlines");

const BUILDING_OUTLINES = [
  ["A", "building_a.geojson"],
  ["B", "building_b.geojson"],
  ["C", "building_c.geojson"],
  ["D", "building_d.geojson"],
  ["E", "building_e.geojson"],
  ["F", "building_f.geojson"],
  ["G", "building_g.geojson"],
  ["H", "building_h.geojson"],
  ["J", "building_j.geojson"],
  ["K", "building_k_.geojson"],
  ["L", "building_L.geojson"],
  ["M", "building_m.geojson"],
  ["N", "building_n_.geojson"],
  ["falcon_house", "building_falcon_house.geojson"],
  ["preg_house", "building_preg_house.geojson"],
  ["merlin_house", "building_merlin_house.geojson"],
  ["student_center", "building_student_center_building.geojson"],
  ["Student_union", "building_student_union.geojson"],
  ["T", "building_t.geojson"],
] as const;

export async function GET() {
  const collections = await Promise.all(
    BUILDING_OUTLINES.map(async ([outlineKey, filename]) => {
      const contents = await readFile(resolve(OUTLINES_DIR, filename), "utf8");
      const collection = JSON.parse(contents) as GeoJSON.FeatureCollection;
      return collection.features.map((feature) => {
        const properties = feature.properties ?? {};
        const taggedHeight = Number(properties.height);
        const levels = Number(properties["building:levels"]);
        const height = Number.isFinite(taggedHeight) && taggedHeight > 0
          ? taggedHeight
          : Number.isFinite(levels) && levels > 0
            ? levels * 3
            : 10;

        return {
          ...feature,
          properties: { ...properties, outlineKey, extrusionHeight: height },
        };
      });
    }),
  );

  return Response.json({ type: "FeatureCollection", features: collections.flat() });
}

export const runtime = "nodejs";
