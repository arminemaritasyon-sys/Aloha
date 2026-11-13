import { timingSafeEqual } from "node:crypto";

function safeEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req) {
  const h = String(req.headers.authorization || "");
  const bearer = h.match(/^Bearer\\s+(.+)$/i)?.[1] || "";
  return safeEqual(process.env.ALOHA_PANEL_KEY, req.headers["x-panel-key"]) ||
    safeEqual(process.env.ALOHA_AGENT_API_KEY, req.headers["x-aloha-agent-key"]) ||
    safeEqual(process.env.LIVEKIT_WEBHOOK_SECRET, bearer);
}
const clean = (v, max = 500) => String(v ?? "").trim().replace(/\\s+/g, " ").slice(0, max);

async function googleJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `google_http_${response.status}`);
  return payload;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "GET") return res.status(200).json({
    ok: true,
    service: "aloha-google-address-geocoding",
    provider: "Google Maps Platform Geocoding API",
    accepts: "POST",
    requiredEnvironment: "GOOGLE_MAPS_API_KEY"
  });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const apiKey = clean(process.env.GOOGLE_MAPS_API_KEY, 300);
  if (!apiKey) return res.status(503).json({ ok: false, error: "google_maps_api_key_missing" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const address = clean(body.address);
    if (address.length < 5) return res.status(400).json({
      ok: false, error: "full_address_required",
      message: "İl, ilçe ve mahalle bilgisi içeren bir adres gerekli."
    });
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", /Türkiye|Turkey/i.test(address) ? address : address + ", Türkiye");
    url.searchParams.set("region", "tr");
    url.searchParams.set("language", "tr");
    url.searchParams.set("key", apiKey);
    const payload = await googleJson(url);
    if (payload.status !== "OK" || !payload.results?.length) {
      return res.status(200).json({
        ok: true, matched: false, provider: "Google Maps Platform Geocoding API",
        results: [], best_match: null, error: "address_not_found",
        message: "Adres Google Haritalar üzerinde bulunamadı. İlçe, mahalle veya cadde bilgisini netleştir."
      });
    }
    const results = payload.results.slice(0, 5).map(item => ({
      latitude: Number(item.geometry.location.lat),
      longitude: Number(item.geometry.location.lng),
      label: item.formatted_address,
      place_id: item.place_id,
      feature_type: item.types?.[0] || null
    })).filter(x => Number.isFinite(x.latitude) && Number.isFinite(x.longitude));
    return res.status(200).json({
      ok: true, matched: results.length > 0,
      provider: "Google Maps Platform Geocoding API",
      results, best_match: results[0],
      warning: "Adres eşleşmesini müşteriye teyit ettir; koordinat tek başına bina/daire doğrulaması değildir."
    });
  } catch (error) {
    console.error("aloha_google_geocode_error", { message: error?.message || String(error) });
    return res.status(502).json({
      ok: false, error: "google_geocoding_failed",
      message: "Google adres arama servisine şu anda ulaşılamıyor."
    });
  }
}
