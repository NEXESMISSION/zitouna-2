/**
 * Google Maps embed (satellite) — no API key; same pattern as existing Tunis URLs.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [zoom=14]
 */
export function googleMapsEmbed(lat, lng, zoom = 14) {
  return `https://maps.google.com/maps?q=${lat},${lng}&t=k&z=${zoom}&ie=UTF8&iwloc=&output=embed`
}

/**
 * Google My Maps embed (use Map ID from the map’s URL: …&mid=…).
 * Viewer/embed only — /edit links cannot be used in iframes.
 */
export function googleMyMapsEmbed(mid) {
  return `https://www.google.com/maps/d/embed?mid=${encodeURIComponent(mid)}&hl=fr`
}

/** Tunisia overview for browse page */
export const GOOGLE_MAP_TUNISIA_OVERVIEW = googleMapsEmbed(34.45, 9.85, 7)
