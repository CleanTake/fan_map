"use client";

import mapboxgl from "mapbox-gl";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Category, LocationFeature } from "@/lib/place-types";
import { isMappedPoint } from "@/lib/place-types";
import type { AuthUser } from "@/lib/auth/types";
import PublishedLocationDetails from "@/components/published-location-details";
import LocationReportForm from "@/components/location-report-form";
import { haversineMeters, iconSvg, roomIconSvg } from "@/lib/map-utils";
import { createPlace, deletePlace, fetchPlaces, updatePlace } from "@/services/place-service";

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

export default function FanMap({ user, initialFavoriteIds = [], initialLocationId }: { user: AuthUser | null; initialFavoriteIds?: string[]; initialLocationId?: string }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRequestInFlight = useRef(false);
  const hasCenteredOnLocation = useRef(false);
  const initialLocationFocused = useRef(false);
  const [requestedLocationMissing, setRequestedLocationMissing] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    categories.map(({ id }) => id),
  );
  const [selectedLocation, setSelectedLocation] =
    useState<LocationFeature | null>(null);
  const [places, setPlaces] = useState<LocationFeature[]>([]);
  const [placesLoaded, setPlacesLoaded] = useState(false);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [locationChoice, setLocationChoice] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState(initialFavoriteIds);
  const [favoritePendingId, setFavoritePendingId] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteFeedback, setFavoriteFeedback] = useState("");
  const [favoriteSignInRequired, setFavoriteSignInRequired] = useState(false);
  const [deletedPlaceIds, setDeletedPlaceIds] = useState<string[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [adminMode, setAdminMode] = useState(false);
  const adminUnlocked = user?.role === "admin" && adminMode;
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [editingPlaceId, setEditingPlaceId] = useState<string | null>(null);
  const [placeLongitude, setPlaceLongitude] = useState("");
  const [placeLatitude, setPlaceLatitude] = useState("");
  const [adminFeedback, setAdminFeedback] = useState("");
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
  const activePlaces = useMemo(() => places.filter((place) => !deletedPlaceIds.includes(place.properties.id)), [places, deletedPlaceIds]);
  const choiceLabels = useMemo(() => {
    const counts = new Map<string, number>();
    const positions = new Map<string, number>();
    const names = new Set(activePlaces.map((place) => place.properties.name));
    const usedLabels = new Set<string>();
    for (const place of activePlaces) {
      const name = place.properties.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Map(activePlaces.map((place) => {
      const { id, name } = place.properties;
      let position = (positions.get(name) ?? 0) + 1;
      let label = name;
      if ((counts.get(name) ?? 0) > 1) {
        label = `${name} (${position})`;
        while (names.has(label) || usedLabels.has(label)) {
          position += 1;
          label = `${name} (${position})`;
        }
      }
      positions.set(name, position);
      usedLabels.add(label);
      return [id, label];
    }));
  }, [activePlaces]);
  const visiblePlaces = useMemo(() => activePlaces.filter((place) => selectedCategories.includes(place.properties.category)), [activePlaces, selectedCategories]);
  const visiblePlacesRef = useRef(visiblePlaces);
  const favoriteFeatures = useMemo(() => favoriteIds.flatMap((id) => {
    const feature = places.find((place) => place.properties.id === id && !deletedPlaceIds.includes(id));
    return feature ? [feature] : [];
  }), [favoriteIds, places, deletedPlaceIds]);
  const selectedIsFavorite = !!selectedLocation && favoriteIds.includes(selectedLocation.properties.id);
  const awaitingCount = activePlaces.filter((place) => !isMappedPoint(place)).length;

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
        setPlacesLoaded(true);
        if (initialLocationId) {
          const location = places.find((place) => place.properties.id === initialLocationId);
          setSelectedLocation(location ?? null);
          setLocationChoice(location?.properties.name ?? "");
          setRequestedLocationMissing(!location);
        }
      })
      .catch(() => {
        setPlaces([]);
        setDeletedPlaceIds([]);
        setPlacesFailed(true);
      });
  }, [initialLocationId]);

  useEffect(() => {
    if (!initialLocationId || !mapReady || initialLocationFocused.current) return;
    const location = places.find((place) => place.properties.id === initialLocationId);
    if (location && isMappedPoint(location)) {
      map.current?.flyTo({ center: location.geometry.coordinates as [number, number], zoom: 17 });
      initialLocationFocused.current = true;
    }
  }, [initialLocationId, mapReady, places]);

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

    let disposed = false;
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
      if (disposed) return;
      try {
      await Promise.all(
        categories.map(async ({ id, symbol }) => {
          if (instance.hasImage(id)) return;
          const image = id === "room"
            ? roomIconSvg()
            : iconSvg(categoryColors[id], symbol);
          const img = await loadSvgImage(image, id);
          if (disposed) return;
          instance.addImage(id, img, { pixelRatio: 2 });
        }),
      );
      if (disposed) return;
      instance.addSource("locations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: visiblePlacesRef.current.filter(isMappedPoint),
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
        const id = event.features?.[0]?.properties?.id;
        const feature = placesRef.current.find((place) => place.properties.id === id);
        if (feature && !deletedPlaceIdsRef.current.includes(feature.properties.id)) {
          setSelectedLocation(feature);
          setLocationChoice(feature.properties.name);
        }
      });
      instance.on("mouseenter", "locations-layer", () => {
        instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", "locations-layer", () => {
        instance.getCanvas().style.cursor = "";
      });
      instance.on("click", (event) => {
        if (!adminUnlockedRef.current) return;
        if (instance.queryRenderedFeatures(event.point, { layers: ["locations-layer"] }).length) return;
        setSelectedLocation(null);
        setLocationChoice("");
        setEditingPlaceId(null);
        setPlaceEditorOpen(true);
        setPlaceLongitude(String(event.lngLat.lng));
        setPlaceLatitude(String(event.lngLat.lat));
        setAdminFeedback("");
        setPlaceName("");
        setPlaceDescription("");
        setPlaceCategory("room");
        setPlaceError("");
      });
      setMapReady(true);
      } catch (error) {
        if (disposed) return;
        console.error("Could not initialize the FanMap layers:", error);
        setMapError(
          error instanceof Error ? error.message : "Could not initialize map layers.",
        );
      }
    });

    return () => {
      disposed = true;
      userMarker.current?.remove();
      userMarker.current = null;
      hasCenteredOnLocation.current = false;
      instance.remove();
      if (map.current === instance) map.current = null;
    };
  }, []);

  useEffect(() => {
    placesRef.current = places;
    deletedPlaceIdsRef.current = deletedPlaceIds;
    visiblePlacesRef.current = visiblePlaces;
    const source = map.current?.getSource("locations") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: visiblePlaces.filter(isMappedPoint),
      });
    }
  }, [places, deletedPlaceIds, visiblePlaces]);

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
    const coordinates = selectedLocation && isMappedPoint(selectedLocation) && visiblePlaces.some((place) => place.properties.id === selectedLocation.properties.id) ? selectedLocation.geometry.coordinates : null;
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
  }, [selectedLocation, userPosition, mapReady, visiblePlaces]);

  const toggleCategory = (category: Category) => {
    setSelectedCategories((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
    if (selectedLocation?.properties.category === category) {
      setSelectedLocation(null);
      setLocationChoice("");
    }
  };

  const selectPlace = (feature: LocationFeature) => {
    setSelectedLocation(feature);
    setLocationChoice(feature.properties.name);
    setSelectedCategories((current) => current.includes(feature.properties.category) ? current : [...current, feature.properties.category]);
    if (mapReady && !mapError && isMappedPoint(feature)) {
      map.current?.flyTo({ center: feature.geometry.coordinates as [number, number], zoom: 17 });
    }
  };

  const updateFavorite = async (feature: LocationFeature, save: boolean) => {
    if (!user || favoritePendingId || favoriteSignInRequired) return;
    const { id, name } = feature.properties;
    setFavoritePendingId(id);
    setFavoriteError("");
    setFavoriteFeedback("");
    try {
      const response = await fetch("/api/favorites", {
        method: save ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId: id }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) setFavoriteSignInRequired(true);
        throw new Error(result.error ?? "Favorites could not be updated. Please try again.");
      }
      if (!Array.isArray(result.locationIds) || !result.locationIds.every((item: unknown) => typeof item === "string")) throw new Error("Favorites could not be updated. Please refresh to try again.");
      setFavoriteIds(result.locationIds);
      setFavoriteFeedback(save ? `${name} saved to favorites.` : `${name} removed from favorites.`);
    } catch (error) {
      setFavoriteError(error instanceof Error ? error.message : "We couldn’t connect. Please try again.");
    } finally {
      setFavoritePendingId(null);
    }
  };

  const editPlace = (place: LocationFeature) => {
    setEditingPlaceId(place.properties.id);
    setPlaceName(place.properties.name);
    setPlaceCategory(place.properties.category);
    setPlaceDescription(place.properties.description);
    setPlaceLongitude(isMappedPoint(place) ? String(place.geometry.coordinates[0]) : "");
    setPlaceLatitude(isMappedPoint(place) ? String(place.geometry.coordinates[1]) : "");
    setPlaceError("");
    setAdminFeedback("");
    setPlaceEditorOpen(true);
  };

  const savePlace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminUnlocked || savingPlace) return;
    setSavingPlace(true);
    setPlaceError("");
    try {
      const input = {
        name: placeName,
        category: placeCategory,
        description: placeDescription,
        coordinates: placeLongitude === "" && placeLatitude === "" ? null : [Number(placeLongitude), Number(placeLatitude)] as [number, number],
      };
      const place = editingPlaceId ? await updatePlace(editingPlaceId, input) : await createPlace(input);
      setPlaces((current) => editingPlaceId ? current.map((item) => item.properties.id === editingPlaceId ? place : item) : [...current, place]);
      selectPlace(place);
      setPlaceEditorOpen(false);
      setAdminFeedback(`${place.properties.name} ${editingPlaceId ? "updated" : "added"}.`);
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : "Could not save place.");
    } finally {
      setSavingPlace(false);
    }
  };

  const confirmDeletePlace = async () => {
    if (!adminUnlocked || !placeToDelete || deletingPlace) return;
    setDeletingPlace(true);
    setDeleteError("");
    try {
      await deletePlace(placeToDelete.properties.id);
      setPlaces((current) => current.filter((place) => place.properties.id !== placeToDelete.properties.id));
      setDeletedPlaceIds((current) => [...current, placeToDelete.properties.id]);
      setAdminFeedback(`${placeToDelete.properties.name} deleted.`);
      if (selectedLocation?.properties.id === placeToDelete.properties.id) {
        setSelectedLocation(null);
        setLocationChoice("");
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
    if (!navigator.geolocation || document.cookie.includes("gps_consent=denied")) {
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
    userPosition && selectedLocation && isMappedPoint(selectedLocation)
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
          {user?.role === "admin" && <button
            className={adminUnlocked ? "admin-button active" : "admin-button"}
            type="button"
            aria-pressed={adminUnlocked}
            disabled={savingPlace || deletingPlace}
            onClick={() => {
              setAdminMode(!adminMode);
              setPlaceEditorOpen(false);
              setPlaceToDelete(null);
              setAdminFeedback("");
            }}
          >
            {adminUnlocked ? "Exit admin mode" : "Admin"}
          </button>}
          <button
            className="location-button"
            onClick={showMyLocation}
            disabled={!mapReady || !!mapError || gpsStatus === "disabled"}
          >
            {gpsStatus === "active"
              ? "Location active"
              : gpsStatus === "disabled"
                ? "Location unavailable"
                : "Show my location"}
          </button>
          <nav className="account-nav" aria-label="Account">
            {user ? <>
              {user.role === "admin" && <Link className="account-link" href="/admin/reports" prefetch={false}>Reports</Link>}
              <span className="account-email" title={user.username ?? user.email}>{user.username ?? user.email}</span>
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
        <aside className="sidebar">
          <h2>Explore campus</h2>
          <p className="sidebar-intro">
            Choose what you want to see on the map.
          </p>
          {adminUnlocked && <p className="sidebar-intro">Select a location to edit or delete it. Click an empty map spot to add a place.</p>}
          <p className="favorite-feedback" role="status">{adminFeedback}</p>
          {requestedLocationMissing && <p className="favorite-error" role="status">The requested location is no longer available on the map.</p>}
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
          <p className="sidebar-intro" role="status">
            {placesLoaded ? `${visiblePlaces.length} of ${activePlaces.length} locations. ${awaitingCount} awaiting map position checks.` : placesFailed ? "Locations could not be loaded. Please refresh to try again." : "Loading campus locations…"}
          </p>
          <label htmlFor="location-select">Select a location</label>
          <input id="location-select" list="location-options" size={14} value={selectedLocation ? choiceLabels.get(selectedLocation.properties.id) ?? selectedLocation.properties.name : locationChoice} placeholder="Choose a location" disabled={!placesLoaded || !visiblePlaces.length} onChange={(event) => {
            const value = event.target.value;
            setLocationChoice(value);
            const feature = visiblePlaces.find((place) => choiceLabels.get(place.properties.id) === value);
            if (feature) selectPlace(feature);
            else setSelectedLocation(null);
          }} />
          <datalist id="location-options">
            {visiblePlaces.map((place) => <option key={place.properties.id} value={choiceLabels.get(place.properties.id)} />)}
          </datalist>
          <section className="favorites-section" aria-labelledby="favorites-heading">
            <h3 id="favorites-heading">Favorites {user && <span className="favorites-count">{favoriteFeatures.length}</span>}</h3>
            {user ? <>
              {!placesLoaded && !placesFailed ? <p className="favorites-hint">Loading favorites…</p> : favoriteFeatures.length ? <ul className="favorites-list">
                {favoriteFeatures.map((feature) => <li key={feature.properties.id}>
                  <button className="favorite-open" type="button" onClick={() => selectPlace(feature)} aria-label={`View ${feature.properties.name}`} aria-current={selectedLocation?.properties.id === feature.properties.id ? "true" : undefined}>
                    <span aria-hidden="true">★</span><span>{feature.properties.name}</span>
                  </button>
                  <button className="favorite-remove" type="button" aria-label={`Remove ${feature.properties.name} from favorites`} title="Remove from favorites" onClick={() => updateFavorite(feature, false)} disabled={favoritePendingId !== null || favoriteSignInRequired}>×</button>
                </li>)}
              </ul> : <p className="favorites-hint">{placesFailed ? "Load campus locations to see your favorites." : "No favorites yet. Select a location and save it here."}</p>}
              {favoriteError && <p className="favorite-error" role="alert">{favoriteError}{favoriteSignInRequired && <> <Link href="/sign-in">Sign in again</Link></>}</p>}
              <p className="favorite-feedback" role="status">{favoriteFeedback}</p>
            </> : <p className="favorites-hint"><Link href="/sign-in">Sign in</Link> to save your favorite campus locations.</p>}
          </section>
        </aside>
        <section
          className="map-panel"
          aria-label="Interactive Fanshawe campus map"
        >
          <div className="map" ref={mapContainer} />
          {adminUnlocked && (
            <div className="admin-map-hint">Admin mode · select a location to edit, or click an empty spot to add</div>
          )}
          {adminUnlocked && placeEditorOpen && (
            <div className="map-modal-backdrop">
              <form className="map-modal" onSubmit={savePlace} role="dialog" aria-modal="true" aria-labelledby="place-editor-title" aria-busy={savingPlace}>
                <button
                  className="modal-close"
                  type="button"
                  aria-label="Cancel place changes"
                  disabled={savingPlace}
                  onClick={() => setPlaceEditorOpen(false)}
                >
                  ×
                </button>
                <p className="eyebrow">{editingPlaceId ? "EDIT MAP PLACE" : "NEW MAP PLACE"}</p>
                <h2 id="place-editor-title">{editingPlaceId ? "Edit place" : "Add a place"}</h2>
                <fieldset className="place-editor-fields" disabled={savingPlace}>
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
                <div className="coordinate-fields">
                  <label className="form-field">Latitude
                    <input type="number" step="any" min={-90} max={90} required={!editingPlaceId || placeLongitude !== ""} value={placeLatitude} onChange={(event) => setPlaceLatitude(event.target.value)} />
                  </label>
                  <label className="form-field">Longitude
                    <input type="number" step="any" min={-180} max={180} required={!editingPlaceId || placeLatitude !== ""} value={placeLongitude} onChange={(event) => setPlaceLongitude(event.target.value)} />
                  </label>
                </div>
                {editingPlaceId && <p className="coordinate-note">Leave both coordinates empty if the map position is unknown.</p>}
                </fieldset>
                {placeError && <p className="form-error" role="alert">{placeError}</p>}
                <button className="location-button" type="submit" disabled={savingPlace}>
                  {savingPlace ? "Saving…" : editingPlaceId ? "Save changes" : "Save place"}
                </button>
              </form>
            </div>
          )}
          {adminUnlocked && placeToDelete && (
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
                {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
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
              <h2>Campus map unavailable in this preview</h2>
              <p>Select a location to explore its details.</p>
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
        <aside className="details-panel" aria-label="Location details" aria-live="polite">
          {selectedLocation ? (
            <>
              <p className="eyebrow">{selectedLocation.properties.category}</p>
              <h2>{selectedLocation.properties.name}</h2>
              <p>{selectedLocation.properties.description}</p>
              {user ? <button type="button" className={`favorite-toggle${selectedIsFavorite ? " is-saved" : ""}`} aria-pressed={selectedIsFavorite} disabled={favoritePendingId !== null || favoriteSignInRequired} onClick={() => updateFavorite(selectedLocation, !selectedIsFavorite)}>
                <span aria-hidden="true">{selectedIsFavorite ? "★" : "☆"}</span>
                {favoritePendingId === selectedLocation.properties.id ? selectedIsFavorite ? "Removing…" : "Saving…" : selectedIsFavorite ? "Saved to favorites" : "Save to favorites"}
              </button> : <Link href="/sign-in" className="favorite-sign-in">☆ Sign in to save this location</Link>}
              {user?.role !== "admin" && <LocationReportForm key={selectedLocation.properties.id} location={selectedLocation} />}
              <PublishedLocationDetails feature={selectedLocation} />
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
                  <p>This is a straight-line distance.</p>
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
                <div className="details-admin-actions">
                  <button className="admin-button" type="button" onClick={() => editPlace(selectedLocation)} disabled={savingPlace || deletingPlace}>Edit this place</button>
                  <button
                    className="delete-place-button"
                    type="button"
                    disabled={savingPlace || deletingPlace}
                    onClick={() => {
                      setDeleteError("");
                      setPlaceToDelete(selectedLocation);
                    }}
                  >
                    Delete this place
                  </button>
                </div>
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
              Click a location on the map or select one from the list to see more details.
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
