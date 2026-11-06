import type { LocationFeature, PlaceInput } from "@/lib/place-types";

export async function fetchPlaces(): Promise<{ places: LocationFeature[]; deletedIds: string[] }> {
  const response = await fetch("/api/places", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load saved places.");
  return response.json();
}

async function mutatePlace(method: "POST" | "PATCH" | "DELETE", id?: string, place?: PlaceInput) {
  const response = await fetch(`/api/places${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: place ? JSON.stringify(place) : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "Could not update this place.");
  }
  return response;
}

export async function createPlace(place: PlaceInput): Promise<LocationFeature> {
  return (await mutatePlace("POST", undefined, place)).json();
}

export async function updatePlace(id: string, place: PlaceInput): Promise<LocationFeature> {
  return (await mutatePlace("PATCH", id, place)).json();
}

export async function deletePlace(id: string): Promise<void> {
  await mutatePlace("DELETE", id);
}
