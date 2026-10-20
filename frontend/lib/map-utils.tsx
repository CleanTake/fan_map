import { BookOpen } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

export function iconSvg(color: string, symbol: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54"><circle cx="27" cy="27" r="24" fill="${color}" stroke="white" stroke-width="4"/><text x="27" y="35" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="white">${symbol}</text></svg>`)}`;
}

export function roomIconSvg() {
  const icon = renderToStaticMarkup(
    <BookOpen size={36} color="#c62828" strokeWidth={2.5} />,
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`;
}

export function haversineMeters(a: mapboxgl.LngLat, b: number[]) {
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
