"use client";

import Link from "next/link";
import { useState } from "react";
import type { LocationReport, ReportFilter, ReportPage } from "@/lib/reports/types";

const formatDate = (value: number) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export default function ReportsPanel({ initialPage }: { initialPage: ReportPage }) {
  const [data, setData] = useState<ReportPage | null>(initialPage);
  const [filter, setFilter] = useState<ReportFilter>("open");
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);
  const busy = loading || pendingId !== null;

  async function loadReports(nextFilter: ReportFilter, page = 1) {
    setLoading(true);
    setError("");
    setFilter(nextFilter);
    try {
      const response = await fetch(`/api/reports?status=${nextFilter}&page=${page}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) {
        setSignInRequired(response.status === 401);
        throw new Error(result.error ?? "Could not load reports.");
      }
      setData(result);
      setSignInRequired(false);
    } catch (error) {
      setData(null);
      setError(error instanceof Error ? error.message : "Could not load reports. Please try again.");
    } finally { setLoading(false); }
  }

  async function changeStatus(report: LocationReport) {
    if (busy) return;
    setPendingId(report.id);
    setError("");
    setFeedback("");
    const status = report.status === "open" ? "resolved" : "open";
    try {
      const response = await fetch("/api/reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: report.id, status }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setData(null);
        setSignInRequired(response.status === 401);
        throw new Error(result.error ?? "Could not update this report.");
      }
      setFeedback(`Report #${report.id} ${status === "resolved" ? "resolved" : "reopened"}.`);
      await loadReports(filter, data?.page ?? 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update this report. Please try again.");
    } finally { setPendingId(null); }
  }

  return <section className="reports-panel" aria-label="Location reports" aria-busy={busy}>
    <div className="reports-toolbar">
      <div className="report-filters" role="group" aria-label="Filter reports">
        {(["open", "resolved", "all"] as const).map((status) => <button key={status} type="button" className={`admin-button${filter === status ? " active" : ""}`} aria-pressed={filter === status} disabled={busy} onClick={() => { setFeedback(""); void loadReports(status); }}>
          {status === "open" ? "Open" : status === "resolved" ? "Resolved" : "All"}{data && ` (${status === "all" ? data.counts.open + data.counts.resolved : data.counts[status]})`}
        </button>)}
      </div>
      <button className="admin-button" type="button" disabled={busy} onClick={() => void loadReports(filter, data?.page ?? 1)}>Refresh</button>
    </div>
    <p className="favorite-feedback" role="status">{loading ? "Loading reports…" : feedback}</p>
    {error && <p className="form-error" role="alert">{error}{signInRequired && <> <Link href="/sign-in">Sign in again</Link></>}</p>}
    {data && !loading && <>
      {!data.reports.length ? <p className="reports-empty">{filter === "all" ? "No location reports yet." : `No ${filter} reports.`}</p> : <ul className="report-list">
        {data.reports.map((report) => <li key={report.id} className="report-card">
          <div className="report-card-heading">
            <h2>#{report.id} · {report.locationName}</h2>
            <span className="account-role">{report.status === "open" ? "Open" : "Resolved"}</span>
          </div>
          <p className="report-meta">{report.reporterType === "guest" ? "Guest" : "Registered user"} · Reported <time dateTime={new Date(report.createdAt).toISOString()}>{formatDate(report.createdAt)}</time></p>
          <p className="report-message">{report.message}</p>
          <div className="report-actions">
            <Link className="account-link" href={`/?location=${encodeURIComponent(report.locationId)}`} prefetch={false}>View location on map</Link>
            <button className="admin-button" type="button" disabled={busy} onClick={() => void changeStatus(report)}>{pendingId === report.id ? "Saving…" : report.status === "open" ? "Mark resolved" : "Reopen report"}</button>
          </div>
          {report.updatedAt !== report.createdAt && <p className="report-meta">Updated <time dateTime={new Date(report.updatedAt).toISOString()}>{formatDate(report.updatedAt)}</time></p>}
        </li>)}
      </ul>}
      {data.pageCount > 1 && <nav className="report-pagination" aria-label="Report pages">
        <button className="admin-button" type="button" disabled={busy || data.page <= 1} onClick={() => void loadReports(filter, data.page - 1)}>Previous</button>
        <span>Page {data.page} of {data.pageCount}</span>
        <button className="admin-button" type="button" disabled={busy || data.page >= data.pageCount} onClick={() => void loadReports(filter, data.page + 1)}>Next</button>
      </nav>}
    </>}
  </section>;
}
