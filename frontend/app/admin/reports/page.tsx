import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { getAuthStore } from "@/lib/auth/database";
import { listReports } from "@/lib/reports/repository";
import ReportsPanel from "@/components/reports-panel";

export const metadata: Metadata = { title: "Location reports | FanMap" };

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") redirect("/");
  return <main className="reports-page">
    <header className="reports-heading">
      <div><p className="eyebrow">FANMAP ADMIN</p><h1>Location reports</h1></div>
      <Link className="back-to-map" href="/">← Back to map</Link>
    </header>
    <p className="sidebar-intro">Review reported inaccuracies, update the map if needed, then mark the report resolved. Times shown in Toronto time.</p>
    <ReportsPanel initialPage={listReports(getAuthStore(), "open", 1)} />
  </main>;
}
