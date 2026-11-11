import { timingSafeEqual } from "node:crypto";

function safeEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected)), b = Buffer.from(String(supplied));
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

function photonResult(feature) {
  const c = feature.geometry?.coordinates || [], p = feature.properties || {};
  const latitude = Number(c[1]), longitude = Number(c[0]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude, longitude,
    label: [p.name, p.housenumber, p.street, p.district, p.city, p.state, p.country].filter(Boolean).join(", "),
    feature_type: p.type || null, osm_type: p.osm_type || null, osm_id: p.osm_id || null
  };
}
function nominatimResult(item) {
  const latitude = Number(item.lat), longitude = Number(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude, longitude, label: item.display_name || "",
    feature_type: item.type || item.class || null,
    osm_type: item.osm_type || null, osm_id: item.osm_id || null
  };
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "AlohaOrderAssistant/1.1 (address lookup)" },
    signal: AbortSignal.timeout(12000), ...options
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "GET") return res.status(200).json({
    ok: true, service: "aloha-address-geocoding", providers: ["Photon / OpenStreetMap", "Nominatim / OpenStreetMap"], accepts: "POST"
  });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ ok: false, error: "method_not_allowed" }); }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const address = clean(body.address);
    if (address.length < 8) return res.status(400).json({
      ok: false, error: "full_address_required",
      message: "İl, ilçe, mahalle ve mümkünse sokak/bina numarası içeren tam adres gerekli."
    });

    const query = /Türkiye|Turkey/i.test(address) ? address : `${address}, Türkiye`;
    let results = [], provider = null, providerErrors = [];

    // Primary: Photon. Keep the complete address intact; do not guess missing city/district details.
    try {
      const url = new URL(process.env.PHOTON_API_URL || "https://photon.komoot.io/api/");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "5");
      url.searchParams.set("lang", "tr");
      url.searchParams.set("lat", "39.0");
      url.searchParams.set("lon", "35.0");
      url.searchParams.set("location_bias_scale", "0.2");
      const payload = await fetchJson(url);
      results = (payload.features || []).map(photonResult).filter(Boolean);
      if (results.length) provider = "Photon / OpenStreetMap";
    } catch (error) {
      providerErrors.push("photon_unavailable");
      console.error("aloha_geocode_photon_error", { message: error?.message || String(error) });
    }

    // Fallback: Nominatim when Photon has no match or is unavailable.
    if (!results.length) {
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", query);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", "5");
        url.searchParams.set("countrycodes", "tr");
        url.searchParams.set("accept-language", "tr");
        const payload = await fetchJson(url);
        results = (Array.isArray(payload) ? payload : []).map(nominatimResult).filter(Boolean);
        if (results.length) provider = "Nominatim / OpenStreetMap";
      } catch (error) {
        providerErrors.push("nominatim_unavailable");
        console.error("aloha_geocode_nominatim_error", { message: error?.message || String(error) });
      }
    }

    if (!results.length) {
      return res.status(200).json({
        ok: true, matched: false, provider: provider || null, results: [], best_match: null,
        error: "address_not_found",
        message: "Adres harita servislerinde bulunamadı. Müşteriden il, ilçe, mahalle, sokak/cadde ve bina numarasını ayrı ayrı tekrar al; kısmi adresle koordinat uydurma.",
        provider_errors: providerErrors
      });
    }

    return res.status(200).json({
      ok: true, matched: true, provider, results,
      best_match: results[0],
      warning: "Sonuç otomatik adres doğrulaması değildir. En iyi eşleşmenin mahalle, ilçe ve il bilgilerini müşteriye okuyup teyit et. Bina/daire düzeyinde kesinlik garanti edilmez."
    });
  } catch (error) {
    console.error("aloha_geocode_error", { message: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: "geocoding_failed", message: "Adres arama servisine şu anda ulaşılamıyor. Biraz sonra tekrar dene." });
  }
}
