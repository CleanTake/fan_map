import "server-only";
import { cookies } from "next/headers";
import { getAuthStore, SESSION_COOKIE } from "./database.ts";
import type { AuthUser } from "./types.ts";

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getAuthStore().findSession(token) : null;
}
