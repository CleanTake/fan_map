import { getCurrentUser } from "@/lib/auth/server";
import { getAuthStore } from "@/lib/auth/database";
import CampusMap from "./components/campus-map";

export default async function Home() {
  const user = await getCurrentUser();
  const initialFavoriteIds = user ? getAuthStore().listFavoriteIds(user.id) : [];
  return <CampusMap key={user?.id ?? "guest"} user={user} initialFavoriteIds={initialFavoriteIds} />;
}
