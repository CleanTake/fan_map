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
