"use client";

import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";

type FeatureProperties = {
  id: string;
  category: Category;
  name: string;
  description: string;
  availability?: string;
  hours?: string;
  studyId?: string;
  stop?: string;
};

type LocationFeature = GeoJSON.Feature<GeoJSON.Point, FeatureProperties>;
type Category =
  | "building"
  | "entrance"
  | "room"
  | "parking"
  | "food"
  | "retail"
  | "service"
  | "bus";

type Route = {
  route: string;
  name: string;
  stop: string;
  arrivals: string[];
};

const categories: { id: Category; label: string; symbol: string }[] = [
  { id: "building", label: "Buildings", symbol: "⌂" },
  { id: "entrance", label: "Entrances", symbol: "↗" },
  { id: "room", label: "Study rooms", symbol: "▣" },
  { id: "parking", label: "Parking", symbol: "P" },
  { id: "food", label: "Food", symbol: "●" },
  { id: "retail", label: "Retail", symbol: "◇" },
  { id: "service", label: "Services", symbol: "+" },
  { id: "bus", label: "Bus stops", symbol: "▰" },
];

const categoryColors: Record<Category, string> = {
  building: "#3859a7",
  entrance: "#526e30",
  room: "#7958a8",
  parking: "#357c8e",
  food: "#c85c2d",
  retail: "#a24f78",
  service: "#96721f",
  bus: "#227660",
};

const locationData: GeoJSON.FeatureCollection<
  GeoJSON.Point,
  FeatureProperties
> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        id: "f-building",
        category: "building",
        name: "F Building",
        description: "Main academic building.",
        availability: "Study rooms available in the building.",
      },
      geometry: { type: "Point", coordinates: [-81.1994, 43.013] },
    },
    {
      type: "Feature",
      properties: {
        id: "main-entrance",
        category: "entrance",
        name: "Main Entrance",
        description: "Primary entrance to F Building.",
      },
      geometry: { type: "Point", coordinates: [-81.19891, 43.01281] },
    },
    {
      type: "Feature",
      properties: {
        id: "study-27743",
        category: "room",
        name: "Study Room 27743",
        description: "Bookable study room in F Building.",
        availability: "Check the booking calendar for availability.",
        studyId: "27743",
      },
      geometry: { type: "Point", coordinates: [-81.19917, 43.01319] },
    },
    {
      type: "Feature",
      properties: {
        id: "lot-5",
        category: "parking",
        name: "Parking Lot 5",
        description: "Visitor and student parking area.",
      },
      geometry: { type: "Point", coordinates: [-81.20106, 43.01277] },
    },
    {
      type: "Feature",
      properties: {
        id: "cafeteria",
        category: "food",
        name: "Campus Cafeteria",
        description: "Food and beverage service.",
        hours: "Mon–Fri: 7:30 AM–4:00 PM",
      },
      geometry: { type: "Point", coordinates: [-81.19874, 43.01335] },
    },
    {
      type: "Feature",
      properties: {
        id: "bookstore",
        category: "retail",
        name: "Campus Store",
        description: "Books, supplies, and Fanshawe merchandise.",
        hours: "Mon–Fri: 9:00 AM–4:00 PM",
      },
      geometry: { type: "Point", coordinates: [-81.19976, 43.01345] },
    },
    {
      type: "Feature",
      properties: {
        id: "student-services",
        category: "service",
        name: "Student Services",
        description: "Student support and campus services.",
      },
      geometry: { type: "Point", coordinates: [-81.19993, 43.01259] },
    },
    {
      type: "Feature",
      properties: {
        id: "north-stop",
        category: "bus",
        name: "Fanshawe College Main Entrance",
        description: "Bus stop at the main entrance.",
        stop: "Fanshawe College Main Entrance",
      },
      geometry: { type: "Point", coordinates: [-81.19854, 43.01262] },
    },
    {
      type: "Feature",
      properties: {
        id: "south-stop",
        category: "bus",
        name: "Fanshawe College South Stop",
        description: "Bus stop on the south side of campus.",
        stop: "Fanshawe College South Stop",
      },
      geometry: { type: "Point", coordinates: [-81.20012, 43.01196] },
    },
  ],
};

function iconSvg(color: string, symbol: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54"><circle cx="27" cy="27" r="24" fill="${color}" stroke="white" stroke-width="4"/><text x="27" y="35" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="white">${symbol}</text></svg>`)}`;
}

function haversineMeters(a: mapboxgl.LngLat, b: number[]) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRadians(b[1] - a.lat);
  const dLng = toRadians(b[0] - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const value =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b[1])) * sinLng * sinLng;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    categories.map(({ id }) => id),
  );
  const [selectedLocation, setSelectedLocation] =
    useState<LocationFeature | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [userPosition, setUserPosition] = useState<mapboxgl.LngLat | null>(
    null,
  );
  const [gpsStatus, setGpsStatus] = useState<"ready" | "disabled" | "active">(
    "ready",
  );

  useEffect(() => {
    fetch("/api/routes")
      .then((response) => response.json())
      .then((data: Route[]) => setRoutes(data))
      .catch(() => setRoutes([]));
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;

    mapboxgl.accessToken = token;
    const instance = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/standard",
      center: [-81.1994, 43.013],
      zoom: 16.2,
      pitch: 58,
      bearing: -22,
      antialias: true,
    });
    map.current = instance;
    instance.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    const loadSvgImage = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image(54, 54);
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });

    instance.on("load", async () => {
      await Promise.all(
        categories.map(async ({ id, symbol }) => {
          if (instance.hasImage(id)) return;
          const img = await loadSvgImage(iconSvg(categoryColors[id], symbol));
          instance.addImage(id, img, { pixelRatio: 2 });
        }),
      );
      instance.addSource("locations", { type: "geojson", data: locationData });
      instance.addLayer({
        id: "locations-layer",
        type: "symbol",
        source: "locations",
        layout: {
          "icon-image": ["get", "category"],
          "icon-size": 0.62,
          "icon-allow-overlap": true,
        },
      });
      instance.addSource("route-line", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "route-line-layer",
        type: "line",
        source: "route-line",
        paint: {
          "line-color": "#1b4d95",
          "line-width": 5,
          "line-opacity": 0.85,
        },
      });
      instance.on("click", "locations-layer", (event) => {
        const feature = event.features?.[0] as LocationFeature | undefined;
        if (feature) setSelectedLocation(feature);
      });
      instance.on("mouseenter", "locations-layer", () => {
        instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", "locations-layer", () => {
        instance.getCanvas().style.cursor = "";
      });
    });

    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (instance?.isStyleLoaded() && instance.getLayer("locations-layer")) {
      instance.setFilter("locations-layer", [
        "in",
        ["get", "category"],
        ["literal", selectedCategories],
      ]);
    }
  }, [selectedCategories]);

  useEffect(() => {
    const instance = map.current;
    if (!instance?.isStyleLoaded() || !instance.getSource("route-line")) return;
    const coordinates = selectedLocation?.geometry.coordinates;
    const line: GeoJSON.FeatureCollection<GeoJSON.LineString> =
      userPosition && coordinates
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [userPosition.lng, userPosition.lat],
                    coordinates,
                  ],
                },
              },
            ],
          }
        : { type: "FeatureCollection", features: [] };
    (instance.getSource("route-line") as mapboxgl.GeoJSONSource).setData(line);
  }, [selectedLocation, userPosition]);

  const toggleCategory = (category: Category) => {
    setSelectedCategories((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  };

  const showMyLocation = () => {
    if (document.cookie.includes("gps_consent=denied")) {
      setGpsStatus("disabled");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = new mapboxgl.LngLat(
          position.coords.longitude,
          position.coords.latitude,
        );
        document.cookie =
          "gps_consent=granted; max-age=86400; path=/; samesite=lax";
        setUserPosition(point);
        setGpsStatus("active");
        if (map.current) {
          if (!userMarker.current)
            userMarker.current = new mapboxgl.Marker({
              color: "#14213d",
            }).addTo(map.current);
          userMarker.current.setLngLat(point);
          map.current.flyTo({ center: point, zoom: 16.5 });
        }
      },
      () => {
        document.cookie =
          "gps_consent=denied; max-age=86400; path=/; samesite=lax";
        setGpsStatus("disabled");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const stopRoutes = selectedLocation?.properties.stop
    ? routes.filter((route) => route.stop === selectedLocation.properties.stop)
    : [];
  const distance =
    userPosition && selectedLocation
      ? haversineMeters(userPosition, selectedLocation.geometry.coordinates)
      : null;
  const tokenMissing = !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  return (
    <main className="fanmap-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FANSHAWE COLLEGE</p>
          <h1>FanMap</h1>
        </div>
        <button
          className="location-button"
          onClick={showMyLocation}
          disabled={gpsStatus === "disabled"}
        >
          {gpsStatus === "active"
            ? "Location active"
            : gpsStatus === "disabled"
              ? "Location unavailable"
              : "Show my location"}
        </button>
      </header>
      <section className="content-grid">
        <aside className="sidebar">
          <h2>Explore campus</h2>
          <p className="sidebar-intro">
            Choose what you want to see on the map.
          </p>
          <fieldset>
            <legend>Location types</legend>
            {categories.map(({ id, label, symbol }) => (
              <label className="filter" key={id}>
                <input
                  type="checkbox"
                  checked={selectedCategories.includes(id)}
                  onChange={() => toggleCategory(id)}
                />
                <span
                  className="filter-icon"
                  style={{ backgroundColor: categoryColors[id] }}
                >
                  {symbol}
                </span>
                {label}
              </label>
            ))}
          </fieldset>
        </aside>
        <section
          className="map-panel"
          aria-label="Interactive Fanshawe campus map"
        >
          <div className="map" ref={mapContainer} />
          {tokenMissing && (
            <div className="map-message">
              <h2>Mapbox token needed</h2>
              <p>
                Add <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> to{" "}
                <code>frontend/.env.local</code> to load the 3D map.
              </p>
            </div>
          )}
          <div className="map-caption">
            <span className="map-dot" /> Fanshawe College campus · 43.0130° N,
            81.1994° W
          </div>
        </section>
        <aside className="details-panel">
          {selectedLocation ? (
            <>
              <p className="eyebrow">{selectedLocation.properties.category}</p>
              <h2>{selectedLocation.properties.name}</h2>
              <p>{selectedLocation.properties.description}</p>
              {selectedLocation.properties.availability && (
                <div className="info-row">
                  <span>Availability</span>
                  <strong>{selectedLocation.properties.availability}</strong>
                </div>
              )}
              {selectedLocation.properties.hours && (
                <div className="info-row">
                  <span>Hours</span>
                  <strong>{selectedLocation.properties.hours}</strong>
                </div>
              )}
              {distance !== null && (
                <div className="info-row">
                  <span>Distance</span>
                  <strong>
                    {distance < 1000
                      ? `${Math.round(distance)} m away`
                      : `${(distance / 1000).toFixed(1)} km away`}
                  </strong>
                </div>
              )}
              {selectedLocation.properties.studyId && (
                <a
                  className="booking-link"
                  href={`/api/study_room/${selectedLocation.properties.studyId}`}
                >
                  Book this study room
                </a>
              )}
              {stopRoutes.length > 0 && (
                <div className="bus-details">
                  <h3>Upcoming buses</h3>
                  {stopRoutes.map((route) => (
                    <div className="route" key={route.route}>
                      <span>{route.route}</span>
                      <div>
                        <strong>{route.name}</strong>
                        <p>{route.arrivals.join(" · ")}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="sidebar-intro">
              Click a location on the map to see more details.
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
