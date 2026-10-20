import { isValidAdminKey } from "@/lib/admin-auth";
import {
  deletePlace,
  readPlaceState,
  savePlace,
} from "@/lib/places-repository";
import type { Category, PlaceInput } from "@/lib/place-types";

const categories: Category[] = [
  "building",
  "entrance",
  "room",
  "parking",
  "food",
  "retail",
  "service",
  "bus",
];

export async function GET() {
  try {
    return Response.json(await readPlaceState(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Could not load places." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!isValidAdminKey(key)) {
    return Response.json({ error: "Admin access required." }, { status: 401 });
  }

  let input: Partial<PlaceInput>;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const coordinates = input.coordinates;
  const longitude = Array.isArray(coordinates) ? coordinates[0] : Number.NaN;
  const latitude = Array.isArray(coordinates) ? coordinates[1] : Number.NaN;
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80 ||
    typeof input.description !== "string" ||
    input.description.length > 500 ||
    !categories.includes(input.category as Category) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 || longitude > 180 ||
    latitude < -90 || latitude > 90
  ) {
    return Response.json({ error: "Place details are invalid." }, { status: 400 });
  }

  try {
    const place = await savePlace({
      name: input.name.trim(),
      category: input.category as Category,
      description: input.description.trim(),
      coordinates: [longitude, latitude],
    });
    return Response.json(place, { status: 201 });
  } catch {
    return Response.json({ error: "Could not save this place." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!isValidAdminKey(key)) {
    return Response.json({ error: "Admin access required." }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-z0-9-]{1,100}$/i.test(id)) {
    return Response.json({ error: "Invalid place ID." }, { status: 400 });
  }

  try {
    const removed = await deletePlace(id);
    if (!removed) {
      return Response.json({ error: "Place not found." }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "Could not delete this place." }, { status: 500 });
  }
}
