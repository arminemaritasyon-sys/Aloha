import { neon } from "@neondatabase/serverless";
import { timingSafeEqual, randomUUID } from "node:crypto";

function safeEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req) {
  return safeEqual(process.env.ALOHA_PANEL_KEY, req.headers["x-panel-key"]) ||
    safeEqual(process.env.ALOHA_AGENT_API_KEY, req.headers["x-aloha-agent-key"]);
}
const clean = (v, max = 300) => String(v ?? "").trim().slice(0, max);
async function googleJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(18000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `google_http_${response.status}`);
  return payload;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const apiKey = clean(process.env.GOOGLE_MAPS_API_KEY, 300);
  if (!apiKey) return res.status(503).json({ ok: false, error: "google_maps_api_key_missing", message: "Vercel ortam değişkenlerinde GOOGLE_MAPS_API_KEY bulunamadı." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const province = clean(body.province, 80), district = clean(body.district, 100);
    if (!province || !district) return res.status(400).json({ ok: false, error: "province_and_district_required" });
    const address = `${district}, ${province}, Türkiye`;
    const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    geocodeUrl.searchParams.set("address", address);
    geocodeUrl.searchParams.set("region", "tr");
    geocodeUrl.searchParams.set("language", "tr");
    geocodeUrl.searchParams.set("key", apiKey);
    const geo = await googleJson(geocodeUrl);
    if (geo.status !== "OK" || !geo.results?.length) return res.status(404).json({ ok: false, error: "district_not_found", message: "Google seçilen ilçe için konum bulamadı." });
    const result = geo.results[0];
    const viewport = result.geometry?.viewport || result.geometry?.bounds;
    if (!viewport?.northeast || !viewport?.southwest) return res.status(502).json({ ok: false, error: "district_bounds_missing", message: "Google ilçe sınır alanını döndürmedi." });
    const rectangle = {
      low: { latitude: Number(viewport.southwest.lat), longitude: Number(viewport.southwest.lng) },
      high: { latitude: Number(viewport.northeast.lat), longitude: Number(viewport.northeast.lng) }
    };
    const queries = [`işletmeler in ${district}, ${province}`, `businesses in ${district}, ${province}`];
    const byId = new Map();
    let pagesChecked = 0;
    for (const textQuery of queries) {
      let pageToken = null;
      for (let page = 0; page < 3; page++) {
        const response = await googleJson("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": [
              "places.id","places.displayName","places.formattedAddress","places.location",
              "places.nationalPhoneNumber","places.rating","places.userRatingCount",
              "places.primaryTypeDisplayName","places.types","places.googleMapsUri",
              "places.websiteUri","places.businessStatus","nextPageToken"
            ].join(",")
          },
          body: JSON.stringify({
            textQuery,
            languageCode: "tr",
            regionCode: "TR",
            pageSize: 20,
            rankPreference: "RELEVANCE",
            locationRestriction: { rectangle },
            ...(pageToken ? { pageToken } : {})
          })
        });
        pagesChecked++;
        for (const place of response.places || []) {
          if (!place.id) continue;
          const loc = place.location || {};
          byId.set(place.id, {
            id: place.id,
            name: place.displayName?.text || "İsimsiz işletme",
            address: place.formattedAddress || null,
            phone: place.nationalPhoneNumber || null,
            rating: Number.isFinite(place.rating) ? place.rating : null,
            user_rating_count: Number.isFinite(place.userRatingCount) ? place.userRatingCount : 0,
            primary_type: place.primaryTypeDisplayName?.text || (place.types || [])[0] || null,
            types: place.types || [],
            latitude: Number.isFinite(loc.latitude) ? loc.latitude : null,
            longitude: Number.isFinite(loc.longitude) ? loc.longitude : null,
            maps_url: place.googleMapsUri || null,
            website: place.websiteUri || null,
            business_status: place.businessStatus || null
          });
        }
        pageToken = response.nextPageToken || null;
        if (!pageToken) break;
      }
    }
    const businesses = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "tr"));
    let saved = 0, duplicates = 0;
    if (process.env.DATABASE_URL && businesses.length) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`CREATE TABLE IF NOT EXISTS aloha_workspace_items (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', data JSONB NOT NULL DEFAULT '{}'::jsonb,
        due_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS aloha_workspace_type_updated_idx ON aloha_workspace_items(type, updated_at DESC)`;
      for (const business of businesses) {
        const existing = await sql`SELECT id FROM aloha_workspace_items WHERE type='business' AND data->>'google_place_id'=${business.id} LIMIT 1`;
        if (existing.length) { duplicates++; continue; }
        const id = randomUUID();
        const data = {
          phone: business.phone, category: business.primary_type || "Google işletmesi",
          address: business.address, latitude: business.latitude, longitude: business.longitude,
          source: "Google Places", google_place_id: business.id, rating: business.rating,
          user_rating_count: business.user_rating_count, business_status: business.business_status,
          maps_url: business.maps_url, website: business.website, types: business.types,
          province, district, call_status: "not_started"
        };
        await sql`INSERT INTO aloha_workspace_items (id,type,title,status,data)
          VALUES (${id},'business',${business.name},'open',${JSON.stringify(data)}::jsonb)`;
        saved++;
      }
    } else if (!process.env.DATABASE_URL) {
      return res.status(503).json({ ok: false, error: "database_unavailable", message: "İşletmeleri rehbere kaydetmek için DATABASE_URL gerekli." });
    }
    return res.status(200).json({
      ok: true, province, district, resolved_address: result.formatted_address,
      total: businesses.length, saved, duplicates, pages_checked: pagesChecked,
      businesses,
      warning: "Google Places sonuçları sektör filtresi olmadan aranmıştır; Google sıralama ve görünürlük nedeniyle ilçedeki tüm işletmeleri eksiksiz döndürmeyi garanti etmez."
    });
  } catch (error) {
    console.error("aloha_business_discover_error", { message: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: "google_business_discovery_failed", message: "Google işletme keşfi başarısız oldu. Google Places API, Geocoding API ve API anahtarı kısıtlamalarını kontrol edin." });
  }
}
