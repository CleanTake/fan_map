"use client";

import { referenceQuestions, referenceRegistration, referenceReviewSummary } from "@/lib/navigation/reference";

export default function CampusReferenceReview({ opacity, showPassages, selectedQuestion, onOpacity, onShowPassages, onSelectQuestion, onFit, onClose }: {
  opacity: number;
  showPassages: boolean;
  selectedQuestion: string;
  onOpacity: (value: number) => void;
  onShowPassages: (value: boolean) => void;
  onSelectQuestion: (id: string) => void;
  onFit: () => void;
  onClose: () => void;
}) {
  const selected = referenceQuestions.find((question) => question.id === selectedQuestion);
  return <section className="reference-review" aria-label="Campus reference review">
    <div className="walking-heading"><h2>Campus map overlay</h2><button className="admin-button" type="button" aria-label="Close campus overlay" onClick={onClose}>×</button></div>
    <p>Your map is overlaid on the existing building outlines. Purple lines show ground-floor passages, red lines show outdoor links, and green lines show doorways. Green Q markers record your confirmed connections.</p>
    <p>{referenceReviewSummary.connectionCount} paths from your {referenceReviewSummary.latestDate} reviews are included. Small drawing wobbles have been straightened and intended junctions connected.</p>
    <div className="reference-controls">
      <label htmlFor="reference-opacity">Image opacity · {Math.round(opacity * 100)}%</label>
      <input id="reference-opacity" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(event) => onOpacity(Number(event.target.value))} />
      <label className="reference-check"><input type="checkbox" checked={showPassages} onChange={(event) => onShowPassages(event.target.checked)} />Show passages and reviewed additions</label>
      <button className="admin-button" type="button" onClick={onFit}>View overlay on map</button>
      <a href={referenceRegistration.imageUrl} target="_blank" rel="noreferrer">Open original image</a>
      <a href="/navigation/annotate-parking-connections.html" target="_blank" rel="noreferrer">Annotate parking connections</a>
    </div>
    <p className="reference-note">Connections have been updated from your answers. The image is still a schematic: comparison points differ from the building outlines by up to {Math.ceil(referenceRegistration.checkMaxMetres)} m. Route distances and precise doorway positions are approximate.</p>
    <div className="reference-questions" role="group" aria-label="Reviewed connections">{referenceQuestions.map((question) => <button className="admin-button" type="button" key={question.id} aria-pressed={selectedQuestion === question.id} onClick={() => onSelectQuestion(question.id)}>{question.id} · {question.status === "removed" ? "Student Services removed" : question.title}</button>)}</div>
    {selected && <div className="reference-question" role="status"><strong>{selected.id}: {selected.title}</strong><p>{selected.answer}</p></div>}
  </section>;
}
