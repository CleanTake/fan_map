import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return requireAdmin(request) ?? new Response(null, { status: 204, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}
