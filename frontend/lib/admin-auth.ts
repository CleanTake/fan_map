import { getAuthStore, type AuthStore } from "./auth/database.ts";
import { isSameOrigin, readSessionToken } from "./auth/http.ts";

export function requireAdmin(request: Request, store: () => AuthStore = getAuthStore): Response | null {
  const user = store().findSession(readSessionToken(request));
  const status = !user ? 401 : user.role !== "admin" || !isSameOrigin(request) ? 403 : null;
  if (!status) return null;
  return Response.json({ error: status === 401 ? "Sign in as an administrator to edit the map." : "Administrator access from FanMap is required." }, {
    status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}
