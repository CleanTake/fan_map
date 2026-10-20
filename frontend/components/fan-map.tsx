"use client";

import mapboxgl from "mapbox-gl";
import { Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Category, LocationFeature } from "@/lib/place-types";
import { haversineMeters, iconSvg, roomIconSvg } from "@/lib/map-utils";
import { createPlace, deletePlace, fetchPlaces, verifyAdminKey } from "@/services/place-service";

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
  room: "#c8102e",
  parking: "#357c8e",
  food: "#c85c2d",
  retail: "#a24f78",
  service: "#96721f",
  bus: "#227660",
};

function createUserLocationMarker() {
  const element = document.createElement("div");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Your location");
  element.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="16" fill="#4285f4" fill-opacity="0.2"/>
      <circle cx="18" cy="18" r="8" fill="#4285f4" stroke="white" stroke-width="2.5"/>
    </svg>`;
  return new mapboxgl.Marker({ element, anchor: "center" });
}

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRequestInFlight = useRef(false);
  const hasCenteredOnLocation = useRef(false);
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    categories.map(({ id }) => id),
  );
  const [selectedLocation, setSelectedLocation] =
    useState<LocationFeature | null>(null);
  const [places, setPlaces] = useState<LocationFeature[]>([]);
  const [deletedPlaceIds, setDeletedPlaceIds] = useState<string[]>([]);
  const [adminKey, setAdminKey] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPromptOpen, setAdminPromptOpen] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [draftCoordinates, setDraftCoordinates] = useState<[number, number] | null>(null);
  const [placeName, setPlaceName] = useState("");
  const [placeCategory, setPlaceCategory] = useState<Category>("room");
  const [placeDescription, setPlaceDescription] = useState("");
  const [savingPlace, setSavingPlace] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [placeToDelete, setPlaceToDelete] = useState<LocationFeature | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletingPlace, setDeletingPlace] = useState(false);
  const [mapError, setMapError] = useState("");
  const [routes, setRoutes] = useState<Route[]>([]);
  const [userPosition, setUserPosition] = useState<mapboxgl.LngLat | null>(
    null,
  );
  const [gpsStatus, setGpsStatus] = useState<"ready" | "disabled" | "active">(
    "ready",
  );
  const adminUnlockedRef = useRef(false);
  const placesRef = useRef(places);
  const deletedPlaceIdsRef = useRef(deletedPlaceIds);

  useEffect(() => {
    const savedTheme = localStorage.getItem("fanmap-theme");
    const initialTheme =
      savedTheme === "light" || savedTheme === "dark"
        ? savedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    // Restore the saved or system theme after hydration to keep server markup stable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;
  }, []);

  useEffect(() => {
    adminUnlockedRef.current = adminUnlocked;
  }, [adminUnlocked]);

  useEffect(() => {
    fetchPlaces()
      .then(({ places, deletedIds }) => {
        setPlaces(places);
        setDeletedPlaceIds(deletedIds);
      })
      .catch(() => {
        setPlaces([]);
        setDeletedPlaceIds([]);
      });
  }, []);

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

    const loadSvgImage = (src: string, label: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load map image: ${label}`));
        img.src = src;
      });

    instance.on("load", async () => {
      try {
      await Promise.all(
        categories.map(async ({ id, symbol }) => {
          if (instance.hasImage(id)) return;
          const image = id === "room"
            ? roomIconSvg()
            : iconSvg(categoryColors[id], symbol);
          const img = await loadSvgImage(image, id);
          instance.addImage(id, img, { pixelRatio: 2 });
        }),
      );
      instance.addSource("locations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: placesRef.current.filter(
            (feature) =>
              !deletedPlaceIdsRef.current.includes(feature.properties.id),
          ),
        },
      });
      instance.addLayer({
        id: "locations-layer",
        type: "symbol",
        source: "locations",
        layout: {
          "icon-image": ["get", "category"],
          "icon-size": ["match", ["get", "category"], "room", 1.05, 0.62],
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
          "line-color": "#c8102e",
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
      instance.on("click", (event) => {
        if (!adminUnlockedRef.current) return;
        setSelectedLocation(null);
        setDraftCoordinates([event.lngLat.lng, event.lngLat.lat]);
        setPlaceName("");
        setPlaceDescription("");
        setPlaceCategory("room");
        setPlaceError("");
      });
      } catch (error) {
        console.error("Could not initialize the FanMap layers:", error);
        setMapError(
          error instanceof Error ? error.message : "Could not initialize map layers.",
        );
      }
    });

    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    placesRef.current = places;
    deletedPlaceIdsRef.current = deletedPlaceIds;
    const source = map.current?.getSource("locations") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: places.filter(
          (feature) => !deletedPlaceIds.includes(feature.properties.id),
        ),
      });
    }
  }, [places, deletedPlaceIds]);

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
    if (!instance) return;
    const applyMapTheme = () => {
      instance.setConfigProperty(
        "basemap",
        "lightPreset",
        theme === "dark" ? "night" : "day",
      );
    };
    if (instance.isStyleLoaded()) {
      applyMapTheme();
      return;
    }
    instance.once("style.load", applyMapTheme);
    return () => {
      instance.off("style.load", applyMapTheme);
    };
  }, [theme]);

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

  const unlockAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAdminError("");
    try {
      await verifyAdminKey(adminKey);
      setAdminUnlocked(true);
      setAdminPromptOpen(false);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Could not sign in.");
    }
  };

  const saveNewPlace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftCoordinates) return;
    setSavingPlace(true);
    setPlaceError("");
    try {
      const place = await createPlace(adminKey, {
        name: placeName,
        category: placeCategory,
        description: placeDescription,
        coordinates: draftCoordinates,
      });
      setPlaces((current) => [...current, place]);
      setSelectedLocation(place);
      setDraftCoordinates(null);
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : "Could not save place.");
    } finally {
      setSavingPlace(false);
    }
  };

  const confirmDeletePlace = async () => {
    if (!placeToDelete) return;
    setDeletingPlace(true);
    setDeleteError("");
    try {
      await deletePlace(adminKey, placeToDelete.properties.id);
      if (placeToDelete.properties.id.startsWith("place-")) {
        setPlaces((current) =>
          current.filter(
            (place) => place.properties.id !== placeToDelete.properties.id,
          ),
        );
      } else {
        setDeletedPlaceIds((current) => [
          ...current,
          placeToDelete.properties.id,
        ]);
      }
      if (selectedLocation?.properties.id === placeToDelete.properties.id) {
        setSelectedLocation(null);
      }
      setPlaceToDelete(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete this place.",
      );
    } finally {
      setDeletingPlace(false);
    }
  };

  const showMyLocation = () => {
    if (document.cookie.includes("gps_consent=denied")) {
      setGpsStatus("disabled");
      return;
    }

    if (locationInterval.current !== null) return;

    const updateLocation = () => {
      if (locationRequestInFlight.current) return;
      locationRequestInFlight.current = true;

      navigator.geolocation.getCurrentPosition(
        (position) => {
          locationRequestInFlight.current = false;
          const point = new mapboxgl.LngLat(
            position.coords.longitude,
            position.coords.latitude,
          );
          document.cookie =
            "gps_consent=granted; max-age=86400; path=/; samesite=lax";
          setUserPosition(point);
          setGpsStatus("active");
          if (map.current) {
            if (!userMarker.current) {
              userMarker.current = createUserLocationMarker();
            }
            userMarker.current.setLngLat(point).addTo(map.current);
            if (!hasCenteredOnLocation.current) {
              map.current.flyTo({ center: point, zoom: 16.5 });
              hasCenteredOnLocation.current = true;
            }
          }
        },
        () => {
          locationRequestInFlight.current = false;
          if (locationInterval.current !== null) {
            clearInterval(locationInterval.current);
            locationInterval.current = null;
          }
          document.cookie =
            "gps_consent=denied; max-age=86400; path=/; samesite=lax";
          setGpsStatus("disabled");
        },
        { enableHighAccuracy: true, timeout: 1000, maximumAge: 0 },
      );
    };

    updateLocation();
    locationInterval.current = setInterval(updateLocation, 1000);
  };

  useEffect(() => {
    return () => {
      if (locationInterval.current !== null) {
        clearInterval(locationInterval.current);
      }
    };
  }, []);

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
        <div className="topbar-actions">
          <button
            className="theme-button"
            type="button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => {
              const nextTheme = theme === "dark" ? "light" : "dark";
              setTheme(nextTheme);
              localStorage.setItem("fanmap-theme", nextTheme);
              document.documentElement.dataset.theme = nextTheme;
            }}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button
            className={adminUnlocked ? "admin-button active" : "admin-button"}
            onClick={() => {
              if (adminUnlocked) {
                setAdminUnlocked(false);
                setAdminKey("");
                setDraftCoordinates(null);
              } else {
                setAdminError("");
                setAdminPromptOpen(true);
              }
            }}
          >
            {adminUnlocked ? "Exit admin mode" : "Admin"}
          </button>
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
        </div>
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
          {adminUnlocked && (
            <div className="admin-map-hint">Admin mode · click an empty map spot to add a place</div>
          )}
          {adminPromptOpen && (
            <div className="map-modal-backdrop">
              <form className="map-modal" onSubmit={unlockAdmin}>
                <button
                  className="modal-close"
                  type="button"
                  aria-label="Close admin sign in"
                  onClick={() => setAdminPromptOpen(false)}
                >
                  ×
                </button>
                <p className="eyebrow">ADMIN ACCESS</p>
                <h2>Sign in to edit the map</h2>
                <label className="form-field">
                  Admin key
                  <input
                    type="password"
                    value={adminKey}
                    onChange={(event) => setAdminKey(event.target.value)}
                    autoComplete="current-password"
                    required
                    autoFocus
                  />
                </label>
                {adminError && <p className="form-error">{adminError}</p>}
                <button className="location-button" type="submit">Continue</button>
              </form>
            </div>
          )}
          {draftCoordinates && (
            <div className="map-modal-backdrop">
              <form className="map-modal" onSubmit={saveNewPlace}>
                <button
                  className="modal-close"
                  type="button"
                  aria-label="Cancel adding place"
                  onClick={() => setDraftCoordinates(null)}
                >
                  ×
                </button>
                <p className="eyebrow">NEW MAP PLACE</p>
                <h2>Add a place</h2>
                <p className="coordinate-note">
                  {draftCoordinates[1].toFixed(6)}, {draftCoordinates[0].toFixed(6)}
                </p>
                <label className="form-field">
                  Place name
                  <input
                    value={placeName}
                    onChange={(event) => setPlaceName(event.target.value)}
                    maxLength={80}
                    required
                    autoFocus
                  />
                </label>
                <label className="form-field">
                  Type
                  <select
                    value={placeCategory}
                    onChange={(event) => setPlaceCategory(event.target.value as Category)}
                  >
                    {categories.map(({ id, label }) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  Description
                  <textarea
                    value={placeDescription}
                    onChange={(event) => setPlaceDescription(event.target.value)}
                    maxLength={500}
                    rows={3}
                  />
                </label>
                {placeError && <p className="form-error">{placeError}</p>}
                <button className="location-button" type="submit" disabled={savingPlace}>
                  {savingPlace ? "Saving…" : "Save place"}
                </button>
              </form>
            </div>
          )}
          {placeToDelete && (
            <div className="map-modal-backdrop">
              <section
                className="map-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-place-title"
              >
                <p className="eyebrow">REMOVE MAP PLACE</p>
                <h2 id="delete-place-title">
                  Delete {placeToDelete.properties.name}?
                </h2>
                <p className="sidebar-intro">
                  This removes the place from the map and saved place list.
                </p>
                {deleteError && <p className="form-error">{deleteError}</p>}
                <div className="delete-actions">
                  <button
                    className="admin-button"
                    type="button"
                    onClick={() => setPlaceToDelete(null)}
                    disabled={deletingPlace}
                  >
                    Cancel
                  </button>
                  <button
                    className="delete-place-button"
                    type="button"
                    onClick={confirmDeletePlace}
                    disabled={deletingPlace}
                  >
                    {deletingPlace ? "Deleting…" : "Delete place"}
                  </button>
                </div>
              </section>
            </div>
          )}
          {tokenMissing && (
            <div className="map-message">
              <h2>Mapbox token needed</h2>
              <p>
                Add <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> to{" "}
                <code>frontend/.env.local</code> to load the 3D map.
              </p>
            </div>
          )}
          {mapError && !tokenMissing && (
            <div className="map-message">
              <h2>Map failed to load</h2>
              <p>{mapError}</p>
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
              {adminUnlocked && (
                  <button
                    className="delete-place-button details-delete-button"
                    type="button"
                    onClick={() => {
                      setDeleteError("");
                      setPlaceToDelete(selectedLocation);
                    }}
                  >
                    Delete this place
                  </button>
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
