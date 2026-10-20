import { getCurrentUser } from "@/lib/auth/server";
import { getAuthStore } from "@/lib/auth/database";
import FanMap from "@/components/fan-map";

export default async function Home() {
  const user = await getCurrentUser();
  const initialFavoriteIds = user ? getAuthStore().listFavoriteIds(user.id) : [];
  return <FanMap key={user?.id ?? "guest"} user={user} initialFavoriteIds={initialFavoriteIds} />;
}
