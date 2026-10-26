import { AuthStore, getAuthStore } from "../auth/database.ts";
import { isSameOrigin, readSessionToken } from "../auth/http.ts";
import { RateLimiter } from "../auth/limiter.ts";
import { getLaunchLocationIds } from "./locations.ts";

const MAX_BODY_BYTES = 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: { locationIds: string[] } | { error: string }, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

function failure(error: unknown): Response {
  if (error instanceof HttpError) {
    const response = json({ error: error.message }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
  console.error("Favorite request failed:", error);
  return json({ error: "We could not update your saved locations. Please try again." }, 500);
}

async function readLocationId(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Submit a location as JSON.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new HttpError(413, "This request is too large.");
  }
  if (!request.body) throw new HttpError(400, "Choose a location to save.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "This request is too large.");
    }
    chunks.push(value);
  }

  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Choose a valid location.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Choose a valid location.");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.locationId !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(body.locationId)) {
    throw new HttpError(400, "Only a valid location ID is accepted.");
  }
  return body.locationId;
}

type LocationIdsProvider = () => ReadonlySet<string> | Promise<ReadonlySet<string>>;

export function createFavoriteHandlers(
  store: () => AuthStore,
  locationIds: LocationIdsProvider,
  limits = new RateLimiter(60, 60 * 1000),
) {
  function currentUser(request: Request) {
    const database = store();
    const user = database.findSession(readSessionToken(request));
    if (!user) throw new HttpError(401, "Sign in to save locations.");
    return { database, user };
  }

  async function mutate(request: Request, save: boolean): Promise<Response> {
    try {
      const { database, user } = currentUser(request);
      if (!isSameOrigin(request)) throw new HttpError(403, "Please save locations from FanMap.");
      if (!limits.consume(user.id)) throw new HttpError(429, "Too many changes. Please try again in a minute.");
      const locationId = await readLocationId(request);
      if (save && !(await locationIds()).has(locationId)) {
        throw new HttpError(400, "This location is not available to save.");
      }
      // Removing an old saved entry remains possible after it leaves the catalog.
      if (save) database.addFavorite(user.id, locationId);
      else database.removeFavorite(user.id, locationId);
      return json({ locationIds: database.listFavoriteIds(user.id) });
    } catch (error) {
      return failure(error);
    }
  }

  return {
    async list(request: Request): Promise<Response> {
      try {
        const { database, user } = currentUser(request);
        return json({ locationIds: database.listFavoriteIds(user.id) });
      } catch (error) {
        return failure(error);
      }
    },
    add: (request: Request) => mutate(request, true),
    remove: (request: Request) => mutate(request, false),
  };
}

const shared = globalThis as typeof globalThis & { fanmapFavoriteLimits?: RateLimiter };
const limits = shared.fanmapFavoriteLimits ??= new RateLimiter(60, 60 * 1000);
const handlers = createFavoriteHandlers(getAuthStore, getLaunchLocationIds, limits);

export const handleListFavorites = handlers.list;
export const handleAddFavorite = handlers.add;
export const handleRemoveFavorite = handlers.remove;
