"use client";

import { useId, useState, type FormEvent } from "react";
import type { LocationFeature } from "@/lib/place-types";

export default function LocationReportForm({ location }: { location: LocationFeature }) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [reportId, setReportId] = useState<number | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !message.trim()) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId: location.properties.id, message }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send your report.");
      setReportId(result.id);
      setOpen(false);
      setMessage("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send your report. Please try again.");
    } finally { setPending(false); }
  }

  return <section className="location-report">
    {reportId ? <p className="favorite-feedback" role="status">report sent for review. Thank you!</p> : <>
      <button className="report-link" type="button" aria-expanded={open} aria-controls={`${fieldId}-form`} onClick={() => setOpen(!open)} disabled={pending}>Report inaccurate location</button>
      {open && <form id={`${fieldId}-form`} onSubmit={submit} aria-busy={pending}>
        <label className="form-field" htmlFor={fieldId}>What is inaccurate?</label>
        <textarea id={fieldId} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} rows={4} required disabled={pending} autoFocus aria-describedby={`${fieldId}-hint`} />
        <p id={`${fieldId}-hint`} className="field-hint">Describe the problem and where this location should be. Up to 1,000 characters.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="report-actions">
          <button className="location-button" type="submit" disabled={pending || !message.trim()}>{pending ? "Sending…" : "Send report"}</button>
          <button className="admin-button" type="button" disabled={pending} onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
        </div>
      </form>}
    </>}
  </section>;
}
