import { timingSafeEqual } from "node:crypto";

function safeEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const panelKey = String(req.headers["x-panel-key"] || "").trim();
  const agentKey = String(req.headers["x-aloha-agent-key"] || "").trim();
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return safeEqual(process.env.ALOHA_PANEL_KEY, panelKey) ||
    safeEqual(process.env.ALOHA_AGENT_API_KEY, agentKey) ||
    safeEqual(process.env.LIVEKIT_WEBHOOK_SECRET, bearer);
}

const clean = (value, max = 120) => String(value ?? "").trim().slice(0, max);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : NaN;

function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function classify(tags = {}) {
  const value = tags.cuisine || tags.amenity || tags.shop || "business";
  const cuisine = String(tags.cuisine || "").toLowerCase();
  if (cuisine.includes("kebab") || cuisine.includes("doner") || cuisine.includes("shawarma")) return "Döner / kebap";
  if (tags.amenity === "fast_food") return "Fast food";
  if (tags.amenity === "restaurant") return "Restoran";
  if (tags.amenity === "cafe") return "Kafe";
  return value;
}

function mapElement(element, origin) {
  const tags = element.tags || {};
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = clean(tags.name || tags.brand || tags.operator, 180);
  if (!name) return null;

  const delivery = tags.delivery === "yes" ? "tag_confirmed" :
    tags.delivery === "no" ? "not_available_by_tag" : "unknown";
  const hours = clean(tags.opening_hours, 240) || null;

  return {
    osm_type: element.type,
    osm_id: element.id,
    name,
    category: classify(tags),
    phone: clean(tags.phone || tags["contact:phone"], 60) || null,
    address: [
      tags["addr:street"],
      tags["addr:housenumber"],
      tags["addr:suburb"] || tags["addr:neighbourhood"],
      tags["addr:city"] || tags["addr:town"]
    ].filter(Boolean).join(", ") || null,
    latitude: lat,
    longitude: lon,
    straight_line_distance_m: Math.round(distanceMeters(origin.lat, origin.lon, lat, lon)),
    opening_hours: hours,
    open_status: "unknown",
    delivery_status: delivery,
    takeaway_status: tags.takeaway === "yes" ? "tag_confirmed" : "unknown",
    cuisine: clean(tags.cuisine, 160) || null,
    website: clean(tags.website || tags["contact:website"], 300) || null,
    maps_url: `https://www.openstreetmap.org/${element.type}/${element.id}`
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, max-age=60");
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "aloha-open-business-search",
      requires: ["latitude", "longitude"],
      attribution: "© OpenStreetMap contributors"
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const lat = number(body.latitude);
    const lon = number(body.longitude);
    const radius = Math.max(300, Math.min(5000, Math.round(number(body.radius_m) || 2500)));
    const category = clean(body.category || "all", 30).toLowerCase();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ ok: false, error: "valid_coordinates_required" });
    }

    const foodTypes = ['node["amenity"~"^(restaurant|fast_food)$"]', 'way["amenity"~"^(restaurant|fast_food)$"]', 'relation["amenity"~"^(restaurant|fast_food)$"]'];
    const filters = category === "cafe"
      ? ['node["amenity"="cafe"]', 'way["amenity"="cafe"]', 'relation["amenity"="cafe"]']
      : category === "doner"
        ? ['node["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kebab|doner|shawarma",i]', 'way["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kebab|doner|shawarma",i]', 'relation["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kebab|doner|shawarma",i]']
        : category === "kofte"
          ? [
              'node["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kofte|köfte|meat|grill|turkish",i]',
              'way["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kofte|köfte|meat|grill|turkish",i]',
              'relation["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"kofte|köfte|meat|grill|turkish",i]',
              'node["amenity"~"^(restaurant|fast_food)$"]["name"~"köfte|kofte|köfteci|kofteci",i]',
              'way["amenity"~"^(restaurant|fast_food)$"]["name"~"köfte|kofte|köfteci|kofteci",i]',
              'relation["amenity"~"^(restaurant|fast_food)$"]["name"~"köfte|kofte|köfteci|kofteci",i]'
            ]
          : foodTypes;

    const query = `[out:json][timeout:20];( ${filters.map((filter) => `${filter}(around:${radius},${lat},${lon});`).join(" ")} );out center tags;`;
    const endpoint = clean(process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter", 300);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": `AlohaOrderAssistant/1.0 (${clean(process.env.ALOHA_CONTACT_EMAIL, 120) || "contact-configure-in-vercel"})`
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      return res.status(response.status === 429 ? 503 : 502).json({
        ok: false,
        error: response.status === 429 ? "business_search_rate_limited" : "business_search_provider_unavailable"
      });
    }

    const payload = await response.json();
    const businesses = (payload.elements || [])
      .map((element) => mapElement(element, { lat, lon }))
      .filter(Boolean)
      .sort((a, b) => a.straight_line_distance_m - b.straight_line_distance_m)
      .slice(0, 30);

    return res.status(200).json({
      ok: true,
      provider: "OpenStreetMap / Overpass API",
      attribution: "© OpenStreetMap contributors",
      origin: { latitude: lat, longitude: lon },
      radius_m: radius,
      distance_method: "straight_line_estimate",
      businesses,
      warnings: [
        "Harita verileri eksik veya güncel olmayabilir.",
        "Açık olma durumu doğrulanmadı; opening_hours bilgisi tek başına canlı açık bilgisi değildir.",
        "Paket servis durumu yalnızca OSM kaydında delivery=yes ise etiketle doğrulanmış sayılır; aksi halde işletmeden teyit edilmelidir.",
        "Mesafeler kuş uçuşudur; yol mesafesi değildir."
      ]
    });
  } catch (error) {
    console.error("aloha_business_search_error", { message: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: "business_search_failed" });
  }
}
