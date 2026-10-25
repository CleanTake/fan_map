import type { AuthStore } from "../auth/database.ts";
import type { AuthUser } from "../auth/types.ts";
import type { LocationFeature } from "../place-types.ts";
import type { LocationReport, ReportFilter, ReportPage, ReportStatus } from "./types.ts";

const PAGE_SIZE = 25;
const columns = `id, location_id AS locationId, location_name AS locationName, message,
  reporter_type AS reporterType, status, created_at AS createdAt, updated_at AS updatedAt`;

export function createReport(store: AuthStore, location: LocationFeature, message: string, user: AuthUser | null): number {
  const now = Date.now();
  const result = store.database.prepare(`
    INSERT INTO location_reports (location_id, location_name, message, reporter_type, reporter_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(location.properties.id, location.properties.name, message, user ? "registered" : "guest", user?.id ?? null, now, now);
  return Number(result.lastInsertRowid);
}

export function listReports(store: AuthStore, filter: ReportFilter, requestedPage: number): ReportPage {
  const counts = { open: 0, resolved: 0 };
  const rows = store.database.prepare("SELECT status, COUNT(*) AS count FROM location_reports GROUP BY status").all() as { status: ReportStatus; count: number }[];
  for (const row of rows) counts[row.status] = row.count;
  const total = filter === "all" ? counts.open + counts.resolved : counts[filter];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const query = `SELECT ${columns} FROM location_reports ${filter === "all" ? "" : "WHERE status = ?"} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const params = filter === "all" ? [PAGE_SIZE, (page - 1) * PAGE_SIZE] : [filter, PAGE_SIZE, (page - 1) * PAGE_SIZE];
  // SQLite returns null-prototype rows; Server Component props need plain objects.
  const reports = (store.database.prepare(query).all(...params) as LocationReport[]).map((row) => ({ ...row }));
  return { reports, page, pageCount, total, counts };
}

export function setReportStatus(store: AuthStore, id: number, status: ReportStatus, adminId: string): LocationReport | null {
  store.database.prepare("UPDATE location_reports SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status != ?")
    .run(status, adminId, Date.now(), id, status);
  const row = store.database.prepare(`SELECT ${columns} FROM location_reports WHERE id = ?`).get(id) as LocationReport | undefined;
  return row ? { ...row } : null;
}
