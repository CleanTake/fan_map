"use client";

import mapboxgl from "mapbox-gl";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import catalogJson from "../../../data/campus-places.json";
import type { AuthUser } from "@/lib/auth/types";

type Category = "food" | "retail" | "service";
type OperatingStatus = "open" | "unknown" | "closed_temporarily" | "closed_permanently";
type Hours = { notes?: string; periods: { label: string; from: string | null; to: string | null; rawText?: string; weekly: Record<string, string[][]> }[] };
type Destination = { id: string; name: string; roomId?: string; buildingCode?: string | null; parentId?: string; aliases?: string[]; status?: OperatingStatus; hours?: Hours; notes?: string };
type Room = { id: string; code: string; buildingCode: string; floor: number };
type Catalog = { buildingNames: Record<string, string>; rooms: Room[]; destinations: Destination[]; launchGroups: { id: string; label: string }[] };
type LocationProperties = { id: string; category: Category; name: string; description: string; groups: string[]; launchLabels?: string[]; aliases?: string[]; childIds?: string[]; status?: OperatingStatus };
type LocationFeature = GeoJSON.Feature<GeoJSON.Point | null, LocationProperties>;
type MappedFeature = GeoJSON.Feature<GeoJSON.Point, LocationProperties>;
type Locations = GeoJSON.FeatureCollection<GeoJSON.Point | null, LocationProperties>;

const catalog = catalogJson as unknown as Catalog;
const destinations = new Map(catalog.destinations.map((destination) => [destination.id, destination]));
const rooms = new Map(catalog.rooms.map((room) => [room.id, room]));
const categories: { id: Category; label: string; symbol: string; color: string }[] = [
  { id: "food", label: "Food", symbol: "●", color: "#c85c2d" },
  { id: "retail", label: "Retail", symbol: "◇", color: "#a24f78" },
  { id: "service", label: "Services", symbol: "+", color: "#96721f" },
];

function isMappedPoint(feature: LocationFeature): feature is MappedFeature {
  const coordinates = feature.geometry?.coordinates;
  return feature.geometry?.type === "Point" && Array.isArray(coordinates) && coordinates.length === 2 &&
    coordinates.every(Number.isFinite) && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
}
function destinationRoom(destination?: Destination): Room | undefined {
  if (!destination) return undefined;
  return destination.roomId ? rooms.get(destination.roomId) : destinationRoom(destinations.get(destination.parentId ?? ""));
}
function statusLabel(status?: OperatingStatus) {
  if (status === "closed_permanently") return "Permanently closed";
  if (status === "closed_temporarily") return "Temporarily closed";
  if (status === "unknown") return "Service status awaiting confirmation";
  return "Operating · check published hours";
}
function getCampusDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function subscribeDate(callback: () => void) {
  const timer = window.setInterval(callback, 60000);
  return () => window.clearInterval(timer);
}
function serverDate() { return ""; }
function PublishedHours({ destination, date, showNotice = true }: { destination: Destination; date: string; showNotice?: boolean }) {
  const hours = destination.hours;
  const periods = date ? hours?.periods.filter((period) => (!period.from || period.from <= date) && (!period.to || date <= period.to)) : [];
  if (!periods?.length) return <><strong>Current hours are awaiting confirmation.</strong>{showNotice && <p>Toronto time. Unlisted days and special closures need confirmation.</p>}</>;
  const dayLabels: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return <div>
    {periods.map((period, index) => <div key={`${period.label}-${index}`}>
      <p>{period.label}</p>
      <strong>{(period.rawText ? period.rawText.split(/\r?\n/) : Object.entries(period.weekly).map(([day, intervals]) => `${dayLabels[day] ?? day}: ${intervals.length ? intervals.map((interval) => interval.join("–")).join(", ") : "Closed"}`)).map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</Fragment>)}</strong>
    </div>)}
    {showNotice && <p>Toronto time. Unlisted days and special closures need confirmation.</p>}
  </div>;
}
function iconSvg(color: string, symbol: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54"><circle cx="27" cy="27" r="24" fill="${color}" stroke="white" stroke-width="4"/><text x="27" y="35" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="white">${symbol}</text></svg>`)}`;
}
function haversineMeters(a: mapboxgl.LngLat, b: number[]) {
  const radians = (value: number) => value * Math.PI / 180;
  const value = Math.sin(radians(b[1] - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a.lng) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - Math.min(1, value)));
}

export default function CampusMap({ user }: { user: AuthUser | null }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const [locationData, setLocationData] = useState<Locations | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(categories.map(({ id }) => id));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locationChoice, setLocationChoice] = useState("");
  const [userPosition, setUserPosition] = useState<mapboxgl.LngLat | null>(null);
  const [gpsStatus, setGpsStatus] = useState<"ready" | "disabled" | "active">("ready");
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const campusDate = useSyncExternalStore(subscribeDate, getCampusDate, serverDate);
  const tokenMissing = !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const selectedFeature = locationData?.features.find((feature) => feature.properties.id === selectedId && selectedCategories.includes(feature.properties.category));
  const selectedDestination = selectedId ? destinations.get(selectedId) : undefined;
  const selectedRoom = destinationRoom(selectedDestination);
  const selectedBuildingCode = selectedRoom?.buildingCode ?? selectedDestination?.buildingCode;
  const selectedGroupsLabel = selectedFeature?.properties.groups.map((id) => catalog.launchGroups.find((group) => group.id === id)?.label).filter(Boolean).join(" · ");
  const children = selectedDestination ? catalog.destinations.filter((destination) => destination.parentId === selectedDestination.id) : [];
  const awaitingCount = locationData?.features.filter((feature) => !isMappedPoint(feature)).length ?? 0;
  const visibleFeatures = useMemo(() => (locationData?.features ?? []).filter((feature) => selectedCategories.includes(feature.properties.category)), [locationData, selectedCategories]);
  const mappedVisible = useMemo(() => visibleFeatures.filter(isMappedPoint), [visibleFeatures]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/locations", { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error("Location list unavailable");
      return response.json();
    }).then((data: Locations) => {
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("Location list unavailable");
      setLocationData(data);
    }).catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current || !process.env.NEXT_PUBLIC_MAPBOX_TOKEN) return;
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    let disposed = false;
    const instance = new mapboxgl.Map({
      container: mapContainer.current, style: "mapbox://styles/mapbox/standard",
      // This frames the campus basemap; it is never used as a destination point.
      center: [-81.1994, 43.013], zoom: 16.2, pitch: 58, bearing: -22, antialias: true,
    });
    map.current = instance;
    instance.addControl(new mapboxgl.NavigationControl(), "bottom-right");
    instance.on("error", () => { if (!disposed) setMapFailed(true); });
    instance.on("load", async () => {
      try {
        const images = await Promise.all(categories.map(({ id, color, symbol }) => new Promise<{ id: string; image: HTMLImageElement }>((resolve, reject) => {
          const image = new Image(54, 54);
          image.onload = () => resolve({ id, image });
          image.onerror = reject;
          image.src = iconSvg(color, symbol);
        })));
        if (disposed) return;
        images.forEach(({ id, image }) => instance.addImage(id, image, { pixelRatio: 2 }));
        instance.addSource("locations", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "locations-layer", type: "symbol", source: "locations", layout: { "icon-image": ["get", "category"], "icon-size": 0.62, "icon-allow-overlap": true } });
        instance.addSource("route-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "route-line-layer", type: "line", source: "route-line", paint: { "line-color": "#1b4d95", "line-width": 5, "line-opacity": 0.85 } });
        instance.on("click", "locations-layer", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string" && destinations.has(id)) {
            setSelectedId(id);
            setLocationChoice(destinations.get(id)!.name);
          }
        });
        instance.on("mouseenter", "locations-layer", () => { instance.getCanvas().style.cursor = "pointer"; });
        instance.on("mouseleave", "locations-layer", () => { instance.getCanvas().style.cursor = ""; });
        setMapReady(true);
        setMapFailed(false);
      } catch { if (!disposed) setMapFailed(true); }
    });
    return () => { disposed = true; userMarker.current = null; instance.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!mapReady || !map.current) return;
    const source = map.current.getSource("locations") as mapboxgl.GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: mappedVisible });
  }, [mapReady, mappedVisible]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const source = map.current.getSource("route-line") as mapboxgl.GeoJSONSource | undefined;
    const mappedSelection = selectedFeature && isMappedPoint(selectedFeature) && mappedVisible.some((feature) => feature.properties.id === selectedId);
    const line: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: "FeatureCollection", features: [] };
    if (userPosition && mappedSelection && selectedFeature?.geometry) line.features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[userPosition.lng, userPosition.lat], selectedFeature.geometry.coordinates] } });
    source?.setData(line);
  }, [mapReady, selectedFeature, selectedId, userPosition, mappedVisible]);

  const toggleCategory = (category: Category) => {
    setSelectedCategories((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category]);
    if (selectedFeature?.properties.category === category) {
      setSelectedId(null);
      setLocationChoice("");
    }
  };
  const showMyLocation = () => {
    if (!navigator.geolocation || document.cookie.split("; ").includes("gps_consent=denied")) { setGpsStatus("disabled"); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const point = new mapboxgl.LngLat(position.coords.longitude, position.coords.latitude);
      document.cookie = "gps_consent=granted; max-age=86400; path=/; samesite=lax";
      setUserPosition(point);
      setGpsStatus("active");
      if (map.current) {
        if (!userMarker.current) userMarker.current = new mapboxgl.Marker({ color: "#14213d" }).setLngLat(point).addTo(map.current);
        else userMarker.current.setLngLat(point);
        map.current.flyTo({ center: point, zoom: 16.5 });
      }
    }, () => { document.cookie = "gps_consent=denied; max-age=86400; path=/; samesite=lax"; setGpsStatus("disabled"); }, { enableHighAccuracy: true, timeout: 10000 });
  };
  const distance = userPosition && selectedFeature && isMappedPoint(selectedFeature) ? haversineMeters(userPosition, selectedFeature.geometry.coordinates) : null;

  return <main className="fanmap-shell">
    <header className="topbar"><div><p className="eyebrow">FANSHAWE COLLEGE</p><h1>FanMap</h1></div>
      <div className="topbar-actions">
        <button className="location-button" onClick={showMyLocation} disabled={!mapReady || mapFailed || gpsStatus === "disabled"}>{gpsStatus === "active" ? "Location active" : gpsStatus === "disabled" ? "Location unavailable" : "Show my location"}</button>
        <nav className="account-nav" aria-label="Account">
          {user ? <>
            <span className="account-email" title={user.email}>{user.email}</span>
            <span className="account-role">{user.role === "admin" ? "Admin" : "Registered"}</span>
            <Link className="account-link" href="/sign-out" prefetch={false}>Sign out</Link>
          </> : <>
            <span className="account-role">Guest</span>
            <Link className="account-link" href="/sign-in">Sign in</Link>
            <Link className="account-create" href="/sign-up">Create account</Link>
          </>}
        </nav>
      </div>
    </header>
    <section className="content-grid">
      <aside className="sidebar"><h2>Explore campus</h2><p className="sidebar-intro">Choose what you want to see on the map.</p>
        <fieldset><legend>Location types</legend>{categories.map(({ id, label, symbol, color }) =>
          <label className="filter" key={id}><input type="checkbox" checked={selectedCategories.includes(id)} onChange={() => toggleCategory(id)} /><span className="filter-icon" style={{ backgroundColor: color }}>{symbol}</span>{label}</label>
        )}</fieldset>
        <p className="sidebar-intro" role="status">{locationData ? `${visibleFeatures.length} of ${locationData.features.length} locations. ${awaitingCount} awaiting map position checks.` : loadFailed ? "Locations could not be loaded. Please refresh to try again." : "Loading campus locations…"}</p>
        <label htmlFor="location-select">Select a location</label>
        <input id="location-select" list="location-options" size={14} value={locationChoice} placeholder="Choose a location" onChange={(event) => {
          setLocationChoice(event.target.value);
          setSelectedId(visibleFeatures.find((feature) => feature.properties.name === event.target.value)?.properties.id ?? null);
        }} disabled={!locationData || !visibleFeatures.length} />
        <datalist id="location-options">
          {visibleFeatures.map((feature) => <option key={feature.properties.id} value={feature.properties.name} />)}
        </datalist>
      </aside>
      <section className="map-panel" aria-label="Interactive Fanshawe campus map"><div className="map" ref={mapContainer} />
        {tokenMissing && <div className="map-message"><h2>Mapbox token needed</h2><p>Add <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> to <code>frontend/.env.local</code> to load the 3D map.</p></div>}
        {!tokenMissing && mapFailed && <div className="map-message"><h2>Campus map unavailable</h2><p>Select a location to explore its details.</p></div>}
        <div className="map-caption"><span className="map-dot" /> Fanshawe College campus · 43.0130° N, 81.1994° W</div>
      </section>
      <aside className="details-panel" aria-label="Location details" aria-live="polite">
        {selectedFeature && selectedDestination ? <><p className="eyebrow">{selectedGroupsLabel}</p><h2>{selectedDestination.name}</h2><p>{selectedFeature.properties.description}</p>
          <div className="info-row"><span>Campus location</span><strong>{selectedRoom ? `Room ${selectedRoom.code}` : "Room awaiting confirmation"}</strong>{selectedBuildingCode && <p>{catalog.buildingNames[selectedBuildingCode] ?? `${selectedBuildingCode} Building`}{selectedRoom ? ` · Floor ${selectedRoom.floor}` : ""}</p>}</div>
          <div className="info-row"><span>Service status</span><strong>{statusLabel(selectedDestination.status)}</strong></div>
          {!isMappedPoint(selectedFeature) && <div className="info-row"><span>Map position</span><strong>Awaiting confirmation</strong></div>}
          {selectedDestination.aliases?.length && <div className="info-row"><span>Also find this service as</span><strong>{selectedDestination.aliases.join(" · ")}</strong></div>}
          <div className="info-row"><span>Published hours</span><PublishedHours destination={selectedDestination} date={campusDate} /></div>
          {children.map((child) => <div className="info-row" key={child.id}><span>{child.name}</span><strong>{statusLabel(child.status ?? selectedDestination.status)}</strong><PublishedHours destination={child} date={campusDate} showNotice={false} /></div>)}
          {distance !== null && <div className="info-row"><span>Distance</span><strong>{distance < 1000 ? `${Math.round(distance)} m away` : `${(distance / 1000).toFixed(1)} km away`}</strong><p>This is a straight-line distance.</p></div>}
        </> : <p className="sidebar-intro">Click a location on the map or select one from the list to see more details.</p>}
      </aside>
    </section>
  </main>;
}
