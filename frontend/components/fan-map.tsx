"use client";

import mapboxgl from "mapbox-gl";
import NextImage from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Category, LocationFeature } from "@/lib/place-types";
import { isMappedPoint } from "@/lib/place-types";
import type { AuthUser } from "@/lib/auth/types";
import PublishedLocationDetails from "@/components/published-location-details";
import LocationReportForm from "@/components/location-report-form";
import WalkingDirections from "@/components/walking-directions";
import CampusReferenceReview from "@/components/campus-reference-review";
import { referenceRegistration, referenceCorners, referenceFocusCorners, referenceBearing, referencePassages, referenceQuestionFeatures, referenceQuestions } from "@/lib/navigation/reference";
import type { Coordinate, WalkingDirections as WalkingRoute } from "@/lib/navigation/directions";
import { campusCorridorFeatures, campusDoorFeatures } from "@/lib/navigation/campus-router";
import { watchWalkLocation, type LocationSensorStatus } from "@/lib/navigation/walk-sensors";
import type { WalkDisplay } from "@/lib/navigation/walk-guidance";
import { haversineMeters } from "@/lib/map-utils";
import { createPlace, deletePlace, fetchPlaces, updatePlace } from "@/services/place-service";
import { SlidersHorizontal, Star } from "lucide-react";

type Route = {
  route: string;
  name: string;
  stop: string;
  arrivals: string[];
};

const categories: { id: Category; label: string }[] = [
  { id: "building", label: "Buildings" },
  { id: "entrance", label: "Entrances" },
  { id: "room", label: "Study rooms" },
  { id: "parking", label: "Parking" },
  { id: "food", label: "Food" },
  { id: "retail", label: "Retail" },
  { id: "service", label: "Services" },
  { id: "bus", label: "Bus stops" },
  { id: "court", label: "Courts" },
  { id: "gym", label: "Gyms" },
];

const markerAssetVersion = "2";

const markerAssetPath = (name: string) =>
  `/markers/${name}.png?v=${markerAssetVersion}`;

const categoryIconPath = (category: Category) => {
  if (category === "gym") return markerAssetPath("gym-dumbbell");
  if (category === "entrance") return markerAssetPath("entrance-door");
  return markerAssetPath(category);
};

const categoryIconImage = (category: Category) => {
  if (category === "gym") return "gym-dumbbell";
  if (category === "entrance") return "entrance-door";
  return category;
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

function fitCampusReference(instance: mapboxgl.Map) {
  const bounds = new mapboxgl.LngLatBounds();
  referenceFocusCorners.forEach((point) => bounds.extend(point));
  instance.fitBounds(bounds, { bearing: referenceBearing, pitch: 0, padding: 45, duration: 700 });
}

export default function FanMap({ user, initialFavoriteIds = [], initialLocationId }: { user: AuthUser | null; initialFavoriteIds?: string[]; initialLocationId?: string }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const referenceCamera = useRef<{ center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const referencePopup = useRef<mapboxgl.Popup | null>(null);
  const pickPointRef = useRef<"start" | "end" | null>(null);
  const stopLocation = useRef<(() => void) | null>(null);
  const [walkDisplay, setWalkDisplay] = useState<WalkDisplay | null>(null);
  const walkMarker = useRef<mapboxgl.Marker | null>(null);
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
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [directionsTarget, setDirectionsTarget] = useState("");
  const [directionsSession, setDirectionsSession] = useState(0);
  const [walkingRoute, setWalkingRoute] = useState<WalkingRoute | null>(null);
  const [pickPoint, setPickPoint] = useState<"start" | "end" | null>(null);
  const [mapStart, setMapStart] = useState<Coordinate | null>(null);
  const [mapEnd, setMapEnd] = useState<Coordinate | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceOpacity, setReferenceOpacity] = useState(0.6);
  const [referenceShowPassages, setReferenceShowPassages] = useState(true);
  const [referenceQuestion, setReferenceQuestion] = useState("Q1");
  const [favoriteIds, setFavoriteIds] = useState(initialFavoriteIds);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoritePendingId, setFavoritePendingId] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteFeedback, setFavoriteFeedback] = useState("");
  const [favoriteSignInRequired, setFavoriteSignInRequired] = useState(false);
  const [deletedPlaceIds, setDeletedPlaceIds] = useState<string[]>([]);
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
  const [gpsStatus, setGpsStatus] = useState<LocationSensorStatus | "ready">("ready");
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
      config: {
        basemap: {
          showPointOfInterestLabels: false,
          show3dBuildings: false,
          lightPreset: "day",
        },
      },
      center: [-81.1989, 43.0134],
      zoom: 16.8,
      pitch: 58,
      bearing: 225,
      antialias: true,
    });
    map.current = instance;
    instance.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    const loadMapImage = (src: string, label: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load map image: ${label}`));
        img.src = src;
      });

    instance.on("load", async () => {
      if (disposed) return;
      try {
      await Promise.all(
        categories.filter(({ id }) => id !== "building").map(async ({ id }) => {
          const imageId = categoryIconImage(id);
          if (instance.hasImage(imageId)) return;
          const img = await loadMapImage(categoryIconPath(id), id);
          if (disposed) return;
          instance.addImage(imageId, img, { pixelRatio: 2 });
        }),
      );
      if (disposed) return;
      instance.addSource("campus-boundary", {
        type: "geojson",
        data: "/campus-boundary.geojson",
        attribution: "© OpenStreetMap contributors",
      });
      instance.addLayer({
        id: "campus-boundary-fill",
        type: "fill",
        source: "campus-boundary",
        slot: "bottom",
        paint: {
          "fill-color": "#78a95b",
          "fill-opacity": 0.2,
        },
      });
      instance.addLayer({
        id: "campus-boundary-outline",
        type: "line",
        source: "campus-boundary",
        slot: "middle",
        paint: {
          "line-color": "#557c3b",
          "line-width": 3,
          "line-opacity": 0.85,
        },
      });
      instance.addSource("building-outlines", {
        type: "geojson",
        data: "/api/building-outlines",
      });
      const outlineColors: Record<string, string> = {
        A: "#DEB4D0",
        B: "#96B6DD",
        C: "#EDAEA9",
        D: "#D2BFA4",
        E: "#BCD6EE",
        F: "#E9E19E",
        G: "#D18B88",
        H: "#BCC19F",
        J: "#C6D99C",
        K: "#BA909D",
        L: "#BDBDB2",
        M: "#B8BFDE",
        N: "#75C6DE",
        falcon_house: "#F4C282",
        preg_house: "#F4C282",
        merlin_house: "#F4C282",
        student_center: "#FADFAE",
        Student_union: "#9ECED3",
        T: "#ECA56C",
      };
      const colorMatch = Object.entries(outlineColors).flatMap(([key, color]) => [key, color]);
      instance.addLayer({
        id: "building-outlines-extrusion",
        type: "fill-extrusion",
        source: "building-outlines",
        slot: "middle",
        paint: {
          "fill-extrusion-color": ["match", ["get", "outlineKey"], ...colorMatch, "#999999"],
          "fill-extrusion-height": ["get", "extrusionHeight"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 1,
        },
      });
      instance.addSource("campus-reference-image", { type: "image", url: referenceRegistration.imageUrl, coordinates: referenceCorners });
      instance.addLayer({ id: "campus-reference-layer", type: "raster", source: "campus-reference-image", slot: "top", layout: { visibility: "none" }, paint: { "raster-opacity": 0.6, "raster-fade-duration": 0 } });
      instance.addLayer({ id: "reference-footprints", type: "line", source: "building-outlines", slot: "top", layout: { visibility: "none" }, paint: { "line-color": "#047d91", "line-width": 1.8 } });
      instance.addSource("reference-passages", { type: "geojson", data: referencePassages });
      instance.addLayer({ id: "reference-passages-layer", type: "line", source: "reference-passages", slot: "top", layout: { visibility: "none" }, paint: { "line-color": ["match", ["get", "kind"], "outdoor", "#c8102e", "door", "#147d57", "#aa20bb"], "line-width": 4 } });
      instance.addSource("reference-questions", { type: "geojson", data: referenceQuestionFeatures });
      instance.addLayer({ id: "reference-question-circles", type: "circle", source: "reference-questions", slot: "top", layout: { visibility: "none" }, paint: { "circle-radius": 15, "circle-color": "#45b183", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "reference-question-labels", type: "symbol", source: "reference-questions", slot: "top", layout: { visibility: "none", "text-field": ["get", "id"], "text-size": 11, "text-font": ["Open Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": "#26191c" } });
      instance.on("click", "reference-question-circles", (event) => {
        const question = referenceQuestions.find((item) => item.id === event.features?.[0]?.properties?.id);
        if (!question) return;
        setReferenceQuestion(question.id);
        referencePopup.current?.remove();
        referencePopup.current = new mapboxgl.Popup().setLngLat(question.coordinates).setText(`${question.id}: ${question.answer}`).addTo(instance);
      });
      instance.addSource("campus-ground-corridors", { type: "geojson", data: campusCorridorFeatures });
      instance.addLayer({ id: "campus-ground-corridors-layer", type: "line", source: "campus-ground-corridors", slot: "top", layout: { visibility: "none" }, paint: { "line-color": "#7f2bbd", "line-width": 2.5, "line-opacity": 0.35 } });
      instance.addSource("campus-ground-doors", { type: "geojson", data: campusDoorFeatures });
      instance.addLayer({ id: "campus-ground-doors-layer", type: "circle", source: "campus-ground-doors", slot: "top", layout: { visibility: "none" }, paint: { "circle-color": "#147d57", "circle-radius": 4, "circle-stroke-color": "white", "circle-stroke-width": 1 } });
      instance.addSource("locations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: visiblePlacesRef.current.filter(isMappedPoint),
        },
      });
      instance.addLayer({
        id: "building-locations-layer",
        type: "circle",
        source: "locations",
        filter: ["==", ["get", "category"], "building"],
        paint: {
          "circle-radius": 10,
          "circle-color": "#526678",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 14.8, 0, 16, 1],
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 14.8, 0, 16, 1],
        },
      });
      instance.addLayer({
        id: "locations-layer",
        type: "symbol",
        source: "locations",
        filter: ["!=", ["get", "category"], "building"],
        layout: {
          "icon-image": [
            "match",
            ["get", "category"],
            "entrance", "entrance-door",
            "gym", "gym-dumbbell",
            ["get", "category"],
          ],
          "icon-size": [
            "match",
            ["get", "category"],
            "service", 0.8,
            "bus", 0.8,
            "court", 0.96,
            0.078,
          ],
          "icon-allow-overlap": true,
        },
        paint: {
          "icon-opacity": ["interpolate", ["linear"], ["zoom"], 14.8, 0, 16, 1],
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
          "line-color": ["match", ["get", "kind"], "indoor", "#7f2bbd", "door", "#147d57", "#c8102e"],
          "line-width": 5,
          "line-opacity": 0.85,
        },
      });
      instance.addSource("route-endpoints", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addLayer({
        id: "route-endpoints-layer", type: "circle", source: "route-endpoints",
        paint: { "circle-radius": 7, "circle-color": ["match", ["get", "role"], "start", "#157655", "#c8102e"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
      });
      instance.on("click", "locations-layer", (event) => {
        if (pickPointRef.current) return;
        const id = event.features?.[0]?.properties?.id;
        const feature = placesRef.current.find((place) => place.properties.id === id);
        if (feature && !deletedPlaceIdsRef.current.includes(feature.properties.id)) {
          setSelectedLocation(feature);
          setLocationChoice(feature.properties.name);
        }
      });
      instance.on("click", "building-locations-layer", (event) => {
        if (pickPointRef.current) return;
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
      instance.on("mouseenter", "building-locations-layer", () => {
        instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", "locations-layer", () => {
        instance.getCanvas().style.cursor = "";
      });
      instance.on("mouseleave", "building-locations-layer", () => {
        instance.getCanvas().style.cursor = "";
      });
      instance.on("click", (event) => {
        if (pickPointRef.current) {
          const coordinates: Coordinate = [event.lngLat.lng, event.lngLat.lat];
          if (pickPointRef.current === "start") setMapStart(coordinates); else setMapEnd(coordinates);
          pickPointRef.current = null;
          setPickPoint(null);
          requestAnimationFrame(() => document.querySelector(".walking-directions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
          return;
        }
        if (!adminUnlockedRef.current) return;
        if (instance.queryRenderedFeatures(event.point, { layers: ["locations-layer", "building-locations-layer"] }).length) return;
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
      referencePopup.current?.remove();
      userMarker.current = null;
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
        "all",
        ["!=", ["get", "category"], "building"],
        ["in", ["get", "category"], ["literal", selectedCategories]],
      ]);
    }
  }, [selectedCategories]);

  useEffect(() => {
    const instance = map.current;
    if (!instance?.getSource("route-line")) return;
    const line: GeoJSON.FeatureCollection<GeoJSON.LineString> =
      walkingRoute
        ? {
            type: "FeatureCollection",
            features: walkingRoute.segments?.length ? walkingRoute.segments.map((segment) => ({ type: "Feature", properties: { kind: segment.kind }, geometry: { type: "LineString", coordinates: segment.coordinates } })) : [{ type: "Feature", properties: { kind: "outdoor" }, geometry: walkingRoute.geometry }],
          }
        : { type: "FeatureCollection", features: [] };
    (instance.getSource("route-line") as mapboxgl.GeoJSONSource).setData(line);
    (instance.getSource("route-endpoints") as mapboxgl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: walkingRoute ? walkingRoute.endpoints.map((coordinates, index) => ({ type: "Feature", properties: { role: index === 0 ? "start" : "end" }, geometry: { type: "Point", coordinates } })) : [],
    });
    if (walkingRoute) {
      const bounds = new mapboxgl.LngLatBounds();
      walkingRoute.geometry.coordinates.forEach((point) => bounds.extend(point as [number, number]));
      instance.fitBounds(bounds, { maxZoom: 18, padding: { top: 60, bottom: 70, left: 40, right: 40 }, duration: 800, ...(walkingRoute.indoorDistanceMetres ? { pitch: 0, bearing: referenceBearing } : {}) });
    }
  }, [walkingRoute, mapReady]);

  useEffect(() => {
    const instance = map.current;
    if (!instance?.getLayer("campus-reference-layer")) return;
    for (const id of ["campus-reference-layer", "reference-footprints", "reference-question-circles", "reference-question-labels"]) {
      instance.setLayoutProperty(id, "visibility", referenceOpen ? "visible" : "none");
    }
    instance.setLayoutProperty("locations-layer", "visibility", referenceOpen ? "none" : "visible");
    instance.setLayoutProperty("building-locations-layer", "visibility", referenceOpen ? "none" : "visible");
    if (referenceOpen) {
      referenceCamera.current ??= { center: instance.getCenter().toArray(), zoom: instance.getZoom(), bearing: instance.getBearing(), pitch: instance.getPitch() };
      fitCampusReference(instance);
    } else {
      referencePopup.current?.remove();
      if (referenceCamera.current) { instance.easeTo({ ...referenceCamera.current, duration: 700 }); referenceCamera.current = null; }
    }
  }, [referenceOpen, mapReady]);

  useEffect(() => {
    const instance = map.current;
    if (!instance?.getLayer("campus-reference-layer")) return;
    instance.setPaintProperty("campus-reference-layer", "raster-opacity", referenceOpacity);
    instance.setLayoutProperty("reference-passages-layer", "visibility", referenceOpen && referenceShowPassages ? "visible" : "none");
  }, [referenceOpen, referenceOpacity, referenceShowPassages, mapReady]);

  useEffect(() => {
    pickPointRef.current = pickPoint;
    if (map.current) map.current.getCanvas().style.cursor = pickPoint ? "crosshair" : "";
  }, [pickPoint]);

  useEffect(() => {
    if (!map.current || !directionsOpen) return;
    const markers = [mapStart, mapEnd].flatMap((point, index) => {
      if (!point) return [];
      const element = document.createElement("span");
      element.className = `navigation-picked-point ${index === 0 ? "navigation-start" : "navigation-end"}`;
      element.textContent = index === 0 ? "Start" : "Destination";
      return [new mapboxgl.Marker({ element, anchor: "bottom" }).setLngLat(point).addTo(map.current!)];
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [mapStart, mapEnd, directionsOpen, mapReady]);

  useEffect(() => {
    const instance = map.current;
    if (!instance?.getLayer("campus-ground-corridors-layer")) return;
    const groundView = directionsOpen || (walkingRoute?.indoorDistanceMetres ?? 0) > 0;
    instance.setLayoutProperty("building-outlines-extrusion", "visibility", referenceOpen || groundView ? "none" : "visible");
    instance.setLayoutProperty("reference-footprints", "visibility", referenceOpen || groundView ? "visible" : "none");
    instance.setLayoutProperty("campus-ground-corridors-layer", "visibility", groundView && !referenceOpen ? "visible" : "none");
    instance.setLayoutProperty("campus-ground-doors-layer", "visibility", groundView && !referenceOpen ? "visible" : "none");
  }, [walkingRoute, referenceOpen, mapReady, directionsOpen]);

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

  useEffect(() => {
    if (!map.current || !mapReady) return;
    if (!walkDisplay) {
      walkMarker.current?.remove();
      walkMarker.current = null;
      if (userMarker.current) userMarker.current.getElement().hidden = false;
      return;
    }
    if (userMarker.current) userMarker.current.getElement().hidden = true;
    if (!walkMarker.current) {
      const element = document.createElement("div");
      element.setAttribute("role", "img");
      walkMarker.current = new mapboxgl.Marker({ element });
    }
    const element = walkMarker.current.getElement();
    element.classList.add("walk-marker");
    element.classList.toggle("uncertain", walkDisplay.uncertain);
    element.classList.toggle("replay", walkDisplay.replay);
    element.setAttribute("aria-label", walkDisplay.replay ? "Simulated walking position" : "Estimated walking position");
    walkMarker.current.setLngLat(walkDisplay.coordinate).addTo(map.current);
  }, [walkDisplay, mapReady]);

  const showMyLocation = () => {
    stopLocation.current?.();
    let centered = false;
    stopLocation.current = watchWalkLocation(fix => {
      const point = new mapboxgl.LngLat(...fix.coordinate);
      setUserPosition(point);
      if (!centered) {
        map.current?.flyTo({ center: point, zoom: 16.5 });
        centered = true;
      }
      if (map.current) {
        userMarker.current ??= createUserLocationMarker();
        userMarker.current.setLngLat(point).addTo(map.current);
      }
    }, setGpsStatus);
  };

  useEffect(() => () => { stopLocation.current?.(); walkMarker.current?.remove(); }, []);

  const stopRoutes = selectedLocation?.properties.stop
    ? routes.filter((route) => route.stop === selectedLocation.properties.stop)
    : [];
  const distance =
    userPosition && selectedLocation && isMappedPoint(selectedLocation)
      ? haversineMeters(userPosition, selectedLocation.geometry.coordinates)
      : null;
  const tokenMissing = !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const [isFilterOpen, setIsFilterOpen] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
        const target = event.target as HTMLElement;

        if (!target.closest(".fab-container")) {
          setIsFilterOpen(false);
        }

        if (!target.closest(".favorites-container")) {
          setFavoritesOpen(false);
        }
    }

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
        document.removeEventListener("mousedown", handleClickOutside);
    };
}, []);

  

  return (
    <main className="fanmap-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FANSHAWE COLLEGE</p>
          <h1>FanMap</h1>
        </div>
        <div className="topbar-actions">
          <button className="admin-button" type="button" aria-expanded={directionsOpen} onClick={() => {
            setPickPoint(null); pickPointRef.current = null;
            setMapStart(null); setMapEnd(null);
            map.current?.easeTo({ pitch: 0, duration: 300 });
            setReferenceOpen(false);
            setWalkingRoute(null);
            setDirectionsTarget(selectedLocation?.properties.id ?? "");
            setDirectionsSession((session) => session + 1);
            setDirectionsOpen(!directionsOpen);
          }}>Directions</button>
          <button className="admin-button" type="button" aria-expanded={referenceOpen} onClick={() => {
            setPickPoint(null); pickPointRef.current = null;
            setReferenceOpen(!referenceOpen);
            if (!referenceOpen) { setDirectionsOpen(false); setWalkingRoute(null); setAdminMode(false); }
          }}>Review campus map</button>
          <button
            className="location-button"
            onClick={showMyLocation}
            disabled={!mapReady || !!mapError || !!walkDisplay}
          >
            {gpsStatus === "active" ? "Location active" : gpsStatus === "denied" ? "Location permission denied · retry"
              : gpsStatus === "insecure" ? "Location needs HTTPS" : gpsStatus === "unavailable" ? "Location unavailable · retry"
              : gpsStatus === "waiting" ? "Finding location…" : "Show my location"}
          </button>
          <nav className="account-nav" aria-label="Account">
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
            {user ? <>
              {user.role === "admin" && <Link className="account-link" href="/admin/reports" prefetch={false}>Reports</Link>}
              <span className="account-email" title={user.username ?? user.email}>{user.username ?? user.email}</span>
              <Link className="account-link" href="/sign-out" prefetch={false}>Sign out</Link>
            </> : <>
              <Link className="account-link" href="/sign-in">Sign in</Link>
              <Link className="account-create" href="/sign-up">Create account</Link>
            </>}
          </nav>
        </div>
      </header>
      {referenceOpen && <CampusReferenceReview opacity={referenceOpacity} showPassages={referenceShowPassages} selectedQuestion={referenceQuestion}
        onOpacity={setReferenceOpacity} onShowPassages={setReferenceShowPassages}
        onFit={() => { if (map.current) fitCampusReference(map.current); mapContainer.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
        onSelectQuestion={(id) => {
          const question = referenceQuestions.find((item) => item.id === id);
          if (!question) return;
          setReferenceQuestion(id);
          if (question.status === "removed") { referencePopup.current?.remove(); return; }
          if (map.current) {
            map.current.flyTo({ center: question.coordinates, zoom: 18, pitch: 0, bearing: referenceBearing });
            referencePopup.current?.remove();
            referencePopup.current = new mapboxgl.Popup().setLngLat(question.coordinates).setText(`${question.id}: ${question.answer}`).addTo(map.current);
          }
          mapContainer.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }} onClose={() => setReferenceOpen(false)} />}
      {directionsOpen && <WalkingDirections key={directionsSession} places={activePlaces} labels={choiceLabels} initialDestination={directionsTarget}
        mapStart={mapStart} mapEnd={mapEnd}
        onClearPoint={(target) => { if (target === "start") setMapStart(null); else setMapEnd(null); }}
        onPickPoint={(target) => {
          setPickPoint(target); pickPointRef.current = target; setAdminMode(false);
          if (target === "start") setMapStart(null); else setMapEnd(null);
          map.current?.easeTo({ pitch: 0, bearing: referenceBearing, duration: 500 });
          mapContainer.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        onRoute={setWalkingRoute} onDisplay={setWalkDisplay}
        onViewMap={() => mapContainer.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
        onLocated={(coordinates) => {
          const point = new mapboxgl.LngLat(...coordinates);
          setUserPosition(point);
          setGpsStatus("active");
          if (map.current) {
            userMarker.current ??= createUserLocationMarker();
            userMarker.current.setLngLat(point).addTo(map.current);
          }
        }}
        onClose={() => { setDirectionsOpen(false); setWalkingRoute(null); setPickPoint(null); pickPointRef.current = null; }} />}
      <section className="content-grid">
        <aside className="sidebar" aria-label="Location filters">
          <div className="fab-container">
            <div className="favorites-container">
                <button
                  className={`favorites-fab ${favoritesOpen ? "active" : ""}`}
                  onClick={() => setFavoritesOpen((current) => !current)}
                  aria-label="Toggle favorites"
                  aria-expanded={favoritesOpen}
                >
                  <Star size={20} />
                </button>
                {favoritesOpen && (
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
                )}
              </div>
            <button
                className="filter-fab"
                type="button"
                onClick={() => setIsFilterOpen(prev => !prev)}
                aria-expanded={isFilterOpen}
                aria-label="Toggle location filters"
            >
                <SlidersHorizontal size={20} />
                <span className="filter-count">
                    {selectedCategories.length}
                </span>
            </button>
            {isFilterOpen && (
                <div className="filter-popup">
                    <fieldset>
                        <legend>Location types</legend>
                        <div className="category-filter-grid">
                          {categories.map(({ id, label }) => (
                            <label className={selectedCategories.includes(id) ? "filter active" : "filter"} key={id}>
                              <input
                                type="checkbox"
                                checked={selectedCategories.includes(id)}
                                onChange={() => toggleCategory(id)}
                              />
                              {id === "building" ? (
                                <span className="filter-icon-placeholder" aria-hidden="true" />
                              ) : (
                                <NextImage className="filter-icon" src={categoryIconPath(id)} alt="" width={24} height={24} unoptimized />
                              )}
                              <span className="filter-label">{label}</span>
                            </label>
                          ))}
                        </div>
                    </fieldset>
                </div>
            )}
            <div className="location-search">
              <input
                id="location-select"
                list="location-options"
                value={
                  selectedLocation
                    ? choiceLabels.get(selectedLocation.properties.id) ??
                      selectedLocation.properties.name
                    : locationChoice
                }
                placeholder="Search locations..."
                disabled={!placesLoaded || !visiblePlaces.length}
                onChange={(event) => {
                  const value = event.target.value;
                  setLocationChoice(value);

                  const feature = visiblePlaces.find(
                    (place) => choiceLabels.get(place.properties.id) === value
                  );
                  if (feature) selectPlace(feature);
                  else setSelectedLocation(null);
                }}
              />
              <datalist id="location-options">
                {visiblePlaces.map((place) => (
                  <option
                    key={place.properties.id}
                    value={choiceLabels.get(place.properties.id)}
                  />
                ))}
              </datalist>
            </div>
        </div>
        </aside>
        <section
          className="map-panel"
          aria-label="Interactive Fanshawe campus map"
        >
          <div className="map" ref={mapContainer} />
          {walkDisplay && <div className="walk-map-cue"><strong>{walkDisplay.replay ? "Practice walk" : "Live walk"}</strong>{walkDisplay.instruction}</div>}
          {pickPoint && <div className="navigation-pick-hint" role="status">Tap the ground-floor map to set {pickPoint === "start" ? "your start" : "your destination"}. <button type="button" onClick={() => { setPickPoint(null); pickPointRef.current = null; }}>Cancel</button></div>}
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
            <span className="map-dot" />
            {selectedLocation && isMappedPoint(selectedLocation) ? (
              <>
                {selectedLocation.properties.name} ·{" "}
                {Math.abs(selectedLocation.geometry.coordinates[1]).toFixed(4)}°{" "}
                {selectedLocation.geometry.coordinates[1] >= 0 ? "N" : "S"},{" "}
                {Math.abs(selectedLocation.geometry.coordinates[0]).toFixed(4)}°{" "}
                {selectedLocation.geometry.coordinates[0] >= 0 ? "E" : "W"}
              </>
            ) : (
              <>Fanshawe College campus · 43.0135° N, 81.2008° W</>
            )}
          </div>
        </section>
        <aside className="details-panel" aria-label="Location details" aria-live="polite">
          {selectedLocation ? (
            <>
              <p className="eyebrow">{selectedLocation.properties.category}</p>
              <h2>{selectedLocation.properties.name}</h2>
              <p>{selectedLocation.properties.description}</p>
              {selectedLocation.properties.resolutionStatus === "reference-map-landmark" && <p className="walking-note">Map-area position from the supplied campus plan. Walking directions use a mapped ground-floor approach where available.</p>}
              {isMappedPoint(selectedLocation) && <button className="location-button" type="button" onClick={() => {
                setReferenceOpen(false); setPickPoint(null); pickPointRef.current = null; setMapStart(null); setMapEnd(null); setWalkingRoute(null); setDirectionsTarget(selectedLocation.properties.id); setDirectionsSession((session) => session + 1); setDirectionsOpen(true);
                map.current?.easeTo({ pitch: 0, duration: 300 });
                requestAnimationFrame(() => document.querySelector(".walking-directions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
              }}>Directions here</button>}
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
