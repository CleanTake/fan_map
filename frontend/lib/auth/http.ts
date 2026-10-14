import { createHash } from "node:crypto";
import { AuthStore, getAuthStore, SESSION_COOKIE, SESSION_MAX_AGE } from "./database.ts";
import { authLimits, type AuthLimits } from "./limiter.ts";
import { DUMMY_PASSWORD_HASH, hashPassword, PasswordWorkBusyError, verifyPassword } from "./password.ts";
import type { AuthUser } from "./types.ts";

const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const url = new URL(request.url);
    // Next may use its listening hostname in Request.url (localhost) while the
    // browser used 127.0.0.1. Host is the browser's actual destination; a browser
    // cannot change it independently of the destination URL. Do not trust a
    // forwarded-host header. Deployments can pin their public HTTPS origin.
    const host = request.headers.get("host");
    const expected = process.env.FANMAP_AUTH_ORIGIN
      ? new URL(process.env.FANMAP_AUTH_ORIGIN).origin
      : new URL(host ? `${url.protocol}//${host}` : request.url).origin;
    // Require a serialized origin, not an arbitrary URL whose origin matches.
    return origin === expected;
  } catch {
    return false;
  }
}

function requireSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) throw new HttpError(403, "Please submit this form from FanMap.");
}

async function readCredentials(request: Request): Promise<{ email: string; password: string }> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Submit an email and password as JSON.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, "This request is too large.");
  if (!request.body) throw new HttpError(400, "Enter your email and password.");

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
    throw new HttpError(400, "Enter a valid email and password.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Enter your email and password.");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "email" && key !== "password")) {
    throw new HttpError(400, "Only email and password are accepted.");
  }
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    throw new HttpError(400, "Enter your email and password.");
  }
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (body.password.length < 15 || body.password.length > 128) {
    throw new HttpError(400, "Use a password between 15 and 128 characters.");
  }
  return { email, password: body.password };
}

export function readSessionToken(request: Request): string | undefined {
  const cookie = request.headers.get("cookie")?.split(";").find(
    (part) => part.trim().startsWith(`${SESSION_COOKIE}=`),
  );
  return cookie?.trim().slice(SESSION_COOKIE.length + 1);
}

function cookieValue(token: string, expires?: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const age = expires ? SESSION_MAX_AGE : 0;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}; Expires=${(expires ?? new Date(0)).toUTCString()}${secure}`;
}

function json(body: { user: AuthUser | null } | { ok: true } | { error: string }, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

function failure(error: unknown): Response {
  if (error instanceof HttpError) {
    const response = json({ error: error.message }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "600");
    return response;
  }
  if (error instanceof PasswordWorkBusyError) {
    const response = json({ error: error.message }, 503);
    response.headers.set("Retry-After", "5");
    return response;
  }
  console.error("Authentication request failed:", error);
  return json({ error: "We could not complete that request. Please try again." }, 500);
}

export function createAuthHandlers(store: () => AuthStore, limits: AuthLimits) {
  async function credentials(request: Request) {
    requireSameOrigin(request);
    if (!limits.global.consume("auth")) throw new HttpError(429, "Too many attempts. Please try again in a few minutes.");
    const input = await readCredentials(request);
    const emailKey = createHash("sha256").update(input.email).digest("hex");
    if (!limits.email.consume(emailKey)) throw new HttpError(429, "Too many attempts. Please try again in a few minutes.");
    return input;
  }

  function signedIn(request: Request, database: AuthStore, user: AuthUser, status = 200): Response {
    const session = database.createSession(user.id);
    database.revokeSession(readSessionToken(request));
    const response = json({ user }, status);
    response.headers.set("Set-Cookie", cookieValue(session.token, session.expires));
    return response;
  }

  return {
    async signup(request: Request): Promise<Response> {
      try {
        const { email, password } = await credentials(request);
        const database = store();
        if (database.findUser(email)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
        const passwordHash = await hashPassword(password);
        let user: AuthUser;
        try {
          user = database.createUser(email, passwordHash);
        } catch (error) {
          // Another request may have created the same normalized address while
          // scrypt was running. The database's unique constraint is authoritative.
          if (database.findUser(email)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
          throw error;
        }
        return signedIn(request, database, user, 201);
      } catch (error) {
        return failure(error);
      }
    },

    async login(request: Request): Promise<Response> {
      try {
        const { email, password } = await credentials(request);
        const database = store();
        const account = database.findUser(email);
        const valid = await verifyPassword(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
        if (!account || !valid) throw new HttpError(401, "Email or password is incorrect.");
        const user: AuthUser = { id: account.id, email: account.email, role: account.role };
        return signedIn(request, database, user);
      } catch (error) {
        return failure(error);
      }
    },

    async logout(request: Request): Promise<Response> {
      try {
        requireSameOrigin(request);
        const token = readSessionToken(request);
        if (token) store().revokeSession(token);
        const response = json({ ok: true });
        response.headers.set("Set-Cookie", cookieValue(""));
        return response;
      } catch (error) {
        return failure(error);
      }
    },

    async session(request: Request): Promise<Response> {
      try {
        const token = readSessionToken(request);
        return json({ user: token ? store().findSession(token) : null });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const handlers = createAuthHandlers(getAuthStore, authLimits);
export const handleSignup = handlers.signup;
export const handleLogin = handlers.login;
export const handleLogout = handlers.logout;
export const handleSession = handlers.session;
