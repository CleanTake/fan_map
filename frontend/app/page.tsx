import { getCurrentUser } from "@/lib/auth/server";
import { getAuthStore } from "@/lib/auth/database";
import FanMap from "@/components/fan-map";

export default async function Home({ searchParams }: { searchParams: Promise<{ location?: string | string[] }> }) {
  const user = await getCurrentUser();
  const { location } = await searchParams;
  const initialLocationId = typeof location === "string" ? location : undefined;
  const initialFavoriteIds = user ? getAuthStore().listFavoriteIds(user.id) : [];
  return <FanMap key={`${user?.id ?? "guest"}:${initialLocationId ?? ""}`} user={user} initialFavoriteIds={initialFavoriteIds} initialLocationId={initialLocationId} />;
}
