import { getAuthStore, type AuthStore } from "../auth/database.ts";
import { isSameOrigin, readSessionToken } from "../auth/http.ts";
import { RateLimiter } from "../auth/limiter.ts";
import { readPlaceState } from "../places-repository.ts";
import type { LocationFeature } from "../place-types.ts";
import { createReport, listReports, setReportStatus } from "./repository.ts";
import type { ReportFilter } from "./types.ts";

const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", Vary: "Cookie" },
});

class ReportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function failure(error: unknown): Response {
  if (error instanceof ReportError) {
    const response = json({ error: error.message }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
  console.error("Location report request failed:", error);
  return json({ error: "We could not complete that report request. Please try again." }, 500);
}

function requireOrigin(request: Request) {
  if (!isSameOrigin(request)) throw new ReportError(403, "Please submit reports from FanMap.");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ReportError(415, "Submit report details as JSON.");
  }
  if (!request.body) throw new ReportError(400, "Enter report details.");
  if (Number(request.headers.get("content-length")) > 8192) throw new ReportError(413, "This request is too large.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new ReportError(413, "This request is too large."); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ReportError(400, "Invalid report details."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReportError(400, "Invalid report details.");
  return body as Record<string, unknown>;
}

export function createReportLimits() {
  return { global: new RateLimiter(30, 60000, 1), submitter: new RateLimiter(5, 60000) };
}

export function createReportHandlers(
  store: () => AuthStore = getAuthStore,
  locations: () => Promise<LocationFeature[]> = async () => (await readPlaceState()).places,
  limits = createReportLimits(),
) {
  function administrator(request: Request) {
    const database = store();
    const user = database.findSession(readSessionToken(request));
    if (!user) throw new ReportError(401, "Sign in as an administrator to track reports.");
    if (user.role !== "admin") throw new ReportError(403, "Administrator access is required to track reports.");
    return { database, user };
  }

  return {
    async submit(request: Request): Promise<Response> {
      try {
        requireOrigin(request);
        const database = store();
        const user = database.findSession(readSessionToken(request));
        if (user?.role === "admin") throw new ReportError(403, "Administrators can edit locations directly. Reporting is for guests and registered users.");
        if (!limits.global.consume("reports") || !limits.submitter.consume(user ? `user:${user.id}` : "guests")) {
          throw new ReportError(429, "Too many reports. Please try again in a minute.");
        }
        const body = await readBody(request);
        if (Object.keys(body).length !== 2 || typeof body.locationId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(body.locationId)
          || typeof body.message !== "string" || !body.message.trim() || body.message.length > 1000) {
          throw new ReportError(400, "Choose a location and describe the problem in 1–1,000 characters.");
        }
        const location = (await locations()).find((place) => place.properties.id === body.locationId);
        if (!location) throw new ReportError(404, "This location is no longer available to report. Please refresh the map.");
        const id = createReport(database, location, body.message.trim(), user);
        return json({ id, status: "open" }, 201);
      } catch (error) { return failure(error); }
    },

    async list(request: Request): Promise<Response> {
      try {
        const { database } = administrator(request);
        const params = new URL(request.url).searchParams;
        const status = params.get("status") ?? "open";
        const rawPage = params.get("page") ?? "1";
        if (!["open", "resolved", "all"].includes(status) || !/^[1-9]\d{0,6}$/.test(rawPage)) {
          throw new ReportError(400, "Choose a valid report status and page.");
        }
        return json(listReports(database, status as ReportFilter, Number(rawPage)));
      } catch (error) { return failure(error); }
    },

    async update(request: Request): Promise<Response> {
      try {
        const { database, user } = administrator(request);
        requireOrigin(request);
        const body = await readBody(request);
        if (Object.keys(body).length !== 2 || !Number.isSafeInteger(body.id) || Number(body.id) < 1 || (body.status !== "open" && body.status !== "resolved")) {
          throw new ReportError(400, "Choose a report and an open or resolved status.");
        }
        const report = setReportStatus(database, body.id as number, body.status, user.id);
        return report ? json({ report }) : json({ error: "Report not found." }, 404);
      } catch (error) { return failure(error); }
    },
  };
}

const shared = globalThis as typeof globalThis & { fanmapReportLimits?: ReturnType<typeof createReportLimits> };
const handlers = createReportHandlers(getAuthStore, undefined, shared.fanmapReportLimits ??= createReportLimits());
export const handleSubmitReport = handlers.submit;
export const handleListReports = handlers.list;
export const handleUpdateReport = handlers.update;
