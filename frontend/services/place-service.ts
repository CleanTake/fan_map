import type { LocationFeature, PlaceInput } from "@/lib/place-types";

export async function fetchPlaces(): Promise<LocationFeature[]> {
  const response = await fetch("/api/places");
  if (!response.ok) throw new Error("Could not load saved places.");
  return response.json();
}

export async function verifyAdminKey(key: string): Promise<void> {
  const response = await fetch("/api/admin/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!response.ok) throw new Error("That admin key is not valid.");
}

export async function createPlace(
  key: string,
  place: PlaceInput,
): Promise<LocationFeature> {
  const response = await fetch("/api/places", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(place),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error ?? "Could not save this place.");
  }
  return response.json();
}
