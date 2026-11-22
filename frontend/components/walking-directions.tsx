"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocationFeature } from "@/lib/place-types";
import { isMappedPoint } from "@/lib/place-types";
import { type Coordinate, type WalkingDirections as Directions } from "@/lib/navigation/directions";
import { requestWalkingDirections } from "@/lib/navigation/campus-router";

import LiveWalk from "@/components/live-walk";
import type { WalkDisplay } from "@/lib/navigation/walk-guidance";
import { getWalkLocation } from "@/lib/navigation/walk-sensors";

export default function WalkingDirections({ places, labels, initialDestination, mapStart, mapEnd, onPickPoint, onClearPoint, onRoute, onDisplay, onLocated, onViewMap, onClose }: {
  places: LocationFeature[];
  labels: Map<string, string>;
  initialDestination?: string;
  mapStart: Coordinate | null;
  mapEnd: Coordinate | null;
  onPickPoint: (target: "start" | "end") => void;
  onClearPoint: (target: "start" | "end") => void;
  onRoute: (route: Directions | null) => void;
  onDisplay: (value: WalkDisplay | null) => void;
  onLocated: (coordinates: Coordinate) => void;
  onViewMap: () => void;
  onClose: () => void;
}) {
  const [startId, setStartId] = useState("my-location");
  const [endId, setEndId] = useState(initialDestination ?? "");
  const [route, setRoute] = useState<Directions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeWalk, setActiveWalk] = useState(false);
  const [walkKey, resetWalk] = useState(0);
  const request = useRef<AbortController | null>(null);
  const mappedPlaces = places.filter(isMappedPoint).filter((place) => place.properties.floor == null || [0, 1].includes(place.properties.floor)).sort((a, b) => (labels.get(a.properties.id) ?? a.properties.name).localeCompare(labels.get(b.properties.id) ?? b.properties.name));
  useEffect(() => () => request.current?.abort(), []);

  function clear() {
    resetWalk(key => key + 1);
    request.current?.abort();
    request.current = null;
    setBusy(false); setRoute(null); setError(""); onRoute(null);
  }

  async function calculate(event: FormEvent) {
    event.preventDefault();
    clear();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    // Bound both GPS acquisition and the network request; stale results are ignored.
    const timeout = setTimeout(() => controller.abort("timeout"), 25000);
    try {
      const destination = mappedPlaces.find((place) => place.properties.id === endId);
      const originPlace = mappedPlaces.find((place) => place.properties.id === startId);
      for (const place of [originPlace, destination]) {
        if (place?.properties.navigationStatus === "pending-access-review") {
          throw new Error(`Walking access for ${place.properties.name} is awaiting review. Pick a nearby mapped pedestrian path instead.`);
        }
      }
      const end = endId === "map-end" ? mapEnd : destination?.properties.navigationCoordinates ?? destination?.geometry.coordinates as Coordinate | undefined;
      if (!end) throw new Error("Choose a destination or pick its position on the map.");
      let start: Coordinate;
      if (startId === "my-location") {
        if (!window.isSecureContext || !navigator.geolocation) throw new Error("Live location needs HTTPS on your phone. Choose a starting location from the list to test on this connection.");
        const fix = await getWalkLocation(controller.signal);
        if (controller.signal.aborted) return;
        start = fix.coordinate;
        onLocated(start);
      } else if (startId === "map-start") {
        if (!mapStart) throw new Error("Pick your starting position on the map.");
        start = mapStart;
      } else {
        const origin = mappedPlaces.find((place) => place.properties.id === startId);
        if (!origin) throw new Error("Choose a starting location with a known map position.");
        start = origin.properties.navigationCoordinates ?? origin.geometry.coordinates as Coordinate;
      }
      const result = await requestWalkingDirections(start, end, process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "", { signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      setRoute(result); onRoute(result);
    } catch (error) {
      if (request.current !== controller) return;
      if (controller.signal.aborted) setError("The route request timed out. Please try again.");
      else if (error && typeof error === "object" && "code" in error && typeof error.code === "number") setError("Could not get your location. Allow location access or choose a starting place from the list.");
      else setError(error instanceof Error ? error.message : "Could not calculate a walking route.");
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  const choices = mappedPlaces.map((place) => <option key={place.properties.id} value={place.properties.id}>{labels.get(place.properties.id) ?? place.properties.name}</option>);
  return <section className="walking-directions" aria-label="Walking directions">
    <div className="walking-heading"><h2>Walking directions</h2><button className="admin-button" type="button" onClick={onClose} aria-label="Close directions">×</button></div>
    <div hidden={activeWalk}>
    <form onSubmit={calculate} aria-busy={busy}>
      <label className="form-field">From<select aria-label="From" value={startId} onChange={(event) => { clear(); setStartId(event.target.value); if (event.target.value === "map-start") onPickPoint("start"); else onClearPoint("start"); }}><option value="my-location">My location</option><option value="map-start">{mapStart ? "Selected start on map" : "Choose start on map"}</option>{choices}</select></label>
      <label className="form-field">To<select aria-label="To" value={endId} onChange={(event) => { clear(); setEndId(event.target.value); if (event.target.value === "map-end") onPickPoint("end"); else onClearPoint("end"); }}><option value="">Choose a destination</option><option value="map-end">{mapEnd ? "Selected destination on map" : "Choose destination on map"}</option>{choices}</select></label>
      <div className="walking-actions">
        <button className="location-button" type="submit" disabled={busy || !endId || startId === endId}>{busy ? "Finding route…" : "Get walking route"}</button>
        {startId !== "my-location" && startId !== "map-start" && endId && endId !== "map-end" && <button className="admin-button" type="button" onClick={() => { clear(); setStartId(endId); setEndId(startId); }}>Swap</button>}
        {(route || busy) && <button className="admin-button" type="button" onClick={clear}>{busy ? "Cancel" : "Clear"}</button>}
      </div>
    </form>
    <div className="walking-actions"><button className="admin-button" type="button" onClick={() => { clear(); setStartId("map-start"); onPickPoint("start"); }}>Pick start on map</button><button className="admin-button" type="button" onClick={() => { clear(); setEndId("map-end"); onPickPoint("end"); }}>Pick destination on map</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div role="status" className="walking-summary">{route ? <strong>{Math.max(1, Math.ceil(route.durationSeconds / 60))} min walk · {route.approximate ? "approx. " : ""}{route.distanceMetres < 1000 ? `${Math.round(route.distanceMetres)} m` : `${(route.distanceMetres / 1000).toFixed(1)} km`}</strong> : busy ? "Calculating a route along mapped walking paths…" : "Choose two locations to calculate a walking route."}</div>
    {route && <>
      <button className="admin-button" type="button" onClick={onViewMap}>View route on map</button>
      {route.endpointOffsets.some((distance) => distance > 25) && <p className="walking-note">The route starts or ends at a nearby mapped path, up to {Math.ceil(Math.max(...route.endpointOffsets))} m from your chosen point. Check the entrance on arrival.</p>}
      {route.steps.length > 0 && <details><summary>Step-by-step directions</summary><ol className="walking-steps">{route.steps.map((step, index) => <li key={index}>{step.instruction}{step.distanceMetres > 0 && <span> · {Math.round(step.distanceMetres)} m</span>}</li>)}</ol></details>}
    </>}
    <p className="walking-note">{route?.source === "campus" ? "Ground-floor campus network. Connections follow your confirmations; corridor and doorway positions are approximate. Purple: indoors · red: outdoors · green: doors." : "Campus routes include mapped ground-floor passages. Routes outside the connected campus network use Mapbox outdoor directions."}</p>
    </div>
    <LiveWalk key={walkKey} plan={route} busy={busy} originLabel={labels.get(startId) ?? "your chosen location"} places={mappedPlaces} onActive={setActiveWalk} onRoute={onRoute} onDisplay={onDisplay} />
    {activeWalk && <button type="button" className="admin-button" onClick={onViewMap}>View walk on map</button>}
  </section>;
}
