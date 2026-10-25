import { requireAdmin } from "./admin-auth.ts";
import { getAuthStore, type AuthStore } from "./auth/database.ts";
import { deletePlace, readPlaceState, savePlace, updatePlace, type PlaceFiles } from "./places-repository.ts";
import type { Category, PlaceInput } from "./place-types.ts";

const categories: Category[] = ["building", "entrance", "room", "parking", "food", "retail", "service", "bus"];
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

class InputError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function readInput(request: Request, allowUnmapped: boolean): Promise<PlaceInput> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError(415, "Submit place details as JSON.");
  }
  if (!request.body) throw new InputError(400, "Enter place details.");
  if (Number(request.headers.get("content-length")) > 4096) throw new InputError(413, "This request is too large.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new InputError(413, "This request is too large."); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InputError(400, "Invalid place details."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError(400, "Invalid place details.");
  const input = body as Record<string, unknown>;
  const point = input.coordinates;
  const validPoint = Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  if (Object.keys(input).some((key) => !["name", "description", "category", "coordinates"].includes(key))
    || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80
    || typeof input.description !== "string" || input.description.length > 500
    || !categories.includes(input.category as Category)
    || !(validPoint || (allowUnmapped && point === null))) {
    throw new InputError(400, "Place details are invalid. Check the name, type and coordinates.");
  }
  return { name: input.name.trim(), description: input.description.trim(), category: input.category as Category, coordinates: point as PlaceInput["coordinates"] };
}

function placeId(request: Request): string {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)) throw new InputError(400, "Invalid place ID.");
  return id;
}

export function createPlaceHandlers(store: () => AuthStore = getAuthStore, files?: PlaceFiles) {
  async function mutate(request: Request, method: "POST" | "PATCH" | "DELETE") {
    try {
      const denied = requireAdmin(request, store);
      if (denied) return denied;
      if (method === "DELETE") {
        return await deletePlace(placeId(request), files)
          ? new Response(null, { status: 204, headers }) : json({ error: "Place not found." }, 404);
      }
      const id = method === "PATCH" ? placeId(request) : null;
      const input = await readInput(request, method === "PATCH");
      const place = id ? await updatePlace(id, input, files) : await savePlace(input, files);
      return place ? json(place, method === "POST" ? 201 : 200) : json({ error: "Place not found." }, 404);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      console.error("Place mutation failed:", error);
      return json({ error: "Could not update this place. Please try again." }, 500);
    }
  }
  return {
    async list() {
      try { return json(await readPlaceState(files)); }
      catch { return json({ error: "Could not load places." }, 500); }
    },
    add: (request: Request) => mutate(request, "POST"),
    update: (request: Request) => mutate(request, "PATCH"),
    remove: (request: Request) => mutate(request, "DELETE"),
  };
}

const handlers = createPlaceHandlers();
export const handleListPlaces = handlers.list;
export const handleAddPlace = handlers.add;
export const handleUpdatePlace = handlers.update;
export const handleDeletePlace = handlers.remove;
