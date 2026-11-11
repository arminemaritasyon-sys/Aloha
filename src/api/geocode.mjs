import { timingSafeEqual } from "node:crypto";
function safeEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected)), b = Buffer.from(String(supplied));
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req) { return safeEqual(process.env.ALOHA_PANEL_KEY, req.headers["x-panel-key"]) || safeEqual(process.env.ALOHA_AGENT_API_KEY, req.headers["x-aloha-agent-key"]); }
const clean = (v, max = 300) => String(v ?? "").trim().replace(/\\s+/g, " ").slice(0, max);
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "aloha-address-geocoding", provider: "Photon / OpenStreetMap", accepts: "POST" });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ ok: false, error: "method_not_allowed" }); }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const address = clean(body.address, 500);
    if (address.length < 8) return res.status(400).json({ ok: false, error: "full_address_required" });
    const query = /Türkiye|Turkey/i.test(address) ? address : address + ", Türkiye";
    const url = new URL(process.env.PHOTON_API_URL || "https://photon.komoot.io/api/");
    url.searchParams.set("q", query); url.searchParams.set("limit", "5"); url.searchParams.set("lang", "tr");
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "AlohaOrderAssistant/1.0" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return res.status(502).json({ ok: false, error: "geocoding_provider_unavailable" });
    const payload = await response.json();
    const results = (payload.features || []).map(feature => {
      const c = feature.geometry?.coordinates || [], p = feature.properties || {};
      const latitude = Number(c[1]), longitude = Number(c[0]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return { latitude, longitude, label: [p.name,p.housenumber,p.street,p.district,p.city,p.state,p.country].filter(Boolean).join(", "), feature_type: p.type || null, osm_type: p.osm_type || null, osm_id: p.osm_id || null };
    }).filter(Boolean);
    return res.status(200).json({ ok: true, provider: "Photon / OpenStreetMap", matched: results.length > 0, results, best_match: results[0] || null, warning: "Koordinat otomatik doğrulama değildir; müşteri adresi ve harita konumu sesli olarak teyit edilmelidir. Ortak Photon servisi hız sınırlarına tabidir." });
  } catch (error) { console.error("aloha_geocode_error", { message: error?.message || String(error) }); return res.status(502).json({ ok: false, error: "geocoding_failed" }); }
}