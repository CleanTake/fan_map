import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function GET() {
  try {
    const path = resolve(process.cwd(), "..", "data", "launch-locations.geojson");
    const collection = JSON.parse(await readFile(path, "utf-8"));
    return Response.json(collection, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Campus locations could not be loaded." },
      { status: 500 },
    );
  }
}
