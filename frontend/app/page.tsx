import { getCurrentUser } from "@/lib/auth/server";
import CampusMap from "./components/campus-map";

export default async function Home() {
  const user = await getCurrentUser();
  return <CampusMap user={user} />;
}
