import { isValidAdminKey } from "@/lib/admin-auth";

export async function POST(request: Request) {
  let body: { key?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!isValidAdminKey(body.key)) {
    return Response.json({ error: "Invalid admin key." }, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
