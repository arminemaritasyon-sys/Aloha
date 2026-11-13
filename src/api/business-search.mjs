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

const clean = (value, max = 300) => String(value ?? "").trim().slice(0, max);
const distanceMeters = (a, b) => {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
};

async function googleJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `google_http_${response.status}`);
  return payload;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "aloha-google-local-search",
      provider: "Google Maps Platform Places API (New)",
      accepts: "POST",
      requiredEnvironment: "GOOGLE_MAPS_API_KEY",
      input: { address: "string", query: "free text", open_now: "boolean (optional)", radius_m: "number (optional)" }
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const apiKey = clean(process.env.GOOGLE_MAPS_API_KEY, 300);
  if (!apiKey) return res.status(503).json({
    ok: false,
    error: "google_maps_api_key_missing",
    message: "Vercel ortam değişkenlerine GOOGLE_MAPS_API_KEY eklenmeli."
  });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const address = clean(body.address, 500);
    const query = clean(body.query || body.search_query || body.category, 180);
    const openNow = body.open_now === true || body.openNow === true;
    const radius = Math.max(300, Math.min(50000, Number(body.radius_m) || 5000));
    let origin = null;
    let resolvedAddress = null;

    if (Number.isFinite(Number(body.latitude)) && Number.isFinite(Number(body.longitude))) {
      origin = { latitude: Number(body.latitude), longitude: Number(body.longitude) };
      if (origin.latitude < -90 || origin.latitude > 90 || origin.longitude < -180 || origin.longitude > 180) {
        return res.status(400).json({ ok: false, error: "invalid_coordinates" });
      }
      resolvedAddress = address || null;
    } else {
      if (address.length < 5) return res.status(400).json({
        ok: false, error: "address_required",
        message: "Müşterinin söylediği açık adres veya mahalle/ilçe bilgisi gerekli."
      });
      const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      geocodeUrl.searchParams.set("address", address);
      geocodeUrl.searchParams.set("region", "tr");
      geocodeUrl.searchParams.set("language", "tr");
      geocodeUrl.searchParams.set("key", apiKey);
      const geocode = await googleJson(geocodeUrl);
      if (geocode.status !== "OK" || !geocode.results?.length) {
        return res.status(200).json({
          ok: true, matched: false, businesses: [],
          message: "Adres Google Haritalar üzerinde doğrulanamadı. Müşteriden mahalle, ilçe veya cadde bilgisini netleştirmesini iste."
        });
      }
      const best = geocode.results[0];
      origin = {
        latitude: Number(best.geometry.location.lat),
        longitude: Number(best.geometry.location.lng)
      };
      resolvedAddress = best.formatted_address || address;
    }

    if (!query) return res.status(400).json({
      ok: false, error: "search_query_required",
      message: "Müşterinin istediği işletme veya hizmeti doğal dille belirt."
    });

    const places = await googleJson("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.location",
          "places.nationalPhoneNumber",
          "places.rating",
          "places.userRatingCount",
          "places.currentOpeningHours",
          "places.googleMapsUri",
          "places.businessStatus"
        ].join(",")
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: "tr",
        regionCode: "TR",
        pageSize: 10,
        rankPreference: "DISTANCE",
        openNow,
        locationBias: {
          circle: {
            center: origin,
            radius
          }
        }
      })
    });

    const businesses = (places.places || []).map(place => {
      const location = place.location || {};
      const point = {
        latitude: Number(location.latitude),
        longitude: Number(location.longitude)
      };
      const validPoint = Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
      return {
        id: place.id || null,
        name: place.displayName?.text || "İsimsiz işletme",
        address: place.formattedAddress || null,
        phone: place.nationalPhoneNumber || null,
        rating: Number.isFinite(place.rating) ? place.rating : null,
        user_rating_count: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
        open_now: typeof place.currentOpeningHours?.openNow === "boolean"
          ? place.currentOpeningHours.openNow : null,
        business_status: place.businessStatus || null,
        distance_m: validPoint ? distanceMeters(origin, point) : null,
        latitude: validPoint ? point.latitude : null,
        longitude: validPoint ? point.longitude : null,
        maps_url: place.googleMapsUri || null
      };
    }).sort((a, b) => (a.distance_m ?? Number.MAX_SAFE_INTEGER) - (b.distance_m ?? Number.MAX_SAFE_INTEGER));

    return res.status(200).json({
      ok: true,
      provider: "Google Maps Platform Places API (New)",
      origin,
      resolved_address: resolvedAddress,
      query,
      open_now_filter: openNow,
      radius_m: radius,
      businesses,
      warnings: [
        "Açık olma bilgisi Google kaydında mevcutsa döndürülür; saat bilgisi olmayan işletmeler açık olarak varsayılmaz.",
        "Mesafe kuş uçuşu tahmindir; araç/yürüme mesafesi değildir."
      ]
    });
  } catch (error) {
    console.error("aloha_google_local_search_error", { message: error?.message || String(error) });
    return res.status(502).json({
      ok: false,
      error: "google_local_search_failed",
      message: "Google işletme arama servisine şu anda ulaşılamıyor."
    });
  }
}
