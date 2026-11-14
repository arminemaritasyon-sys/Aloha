import { timingSafeEqual, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

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

async function discoverDistrict(body, apiKey, res) {
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
  const result = geo.results[0], viewport = result.geometry?.viewport || result.geometry?.bounds;
  if (!viewport?.northeast || !viewport?.southwest) return res.status(502).json({ ok: false, error: "district_bounds_missing", message: "Google ilçe sınır alanını döndürmedi." });
  const rectangle = {
    low: { latitude: Number(viewport.southwest.lat), longitude: Number(viewport.southwest.lng) },
    high: { latitude: Number(viewport.northeast.lat), longitude: Number(viewport.northeast.lng) }
  };
  const queries = [`işletmeler in ${district}, ${province}`, `businesses in ${district}, ${province}`];
  const byId = new Map();
  const queryPages = await Promise.all(queries.map(async textQuery => {
    const pages = []; let pageToken = null;
    for (let page = 0; page < 3; page++) {
      const response = await googleJson("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": ["places.id","places.displayName","places.formattedAddress","places.location","places.nationalPhoneNumber","places.rating","places.userRatingCount","places.primaryTypeDisplayName","places.types","places.googleMapsUri","places.websiteUri","places.businessStatus","nextPageToken"].join(",")
        },
        body: JSON.stringify({ textQuery, languageCode:"tr", regionCode:"TR", pageSize:20, rankPreference:"RELEVANCE", locationRestriction:{rectangle}, ...(pageToken?{pageToken}:{}) })
      });
      pages.push(response.places || []);
      pageToken=response.nextPageToken||null;if(!pageToken)break;
    }
    return pages;
  }));
  const pagesChecked = queryPages.reduce((count,pages)=>count+pages.length,0);
  for (const place of queryPages.flat(2)) {
    if (!place.id) continue;
    const loc=place.location||{};
    byId.set(place.id,{
      id:place.id,name:place.displayName?.text||"İsimsiz işletme",address:place.formattedAddress||null,
      phone:place.nationalPhoneNumber||null,rating:Number.isFinite(place.rating)?place.rating:null,
      user_rating_count:Number.isFinite(place.userRatingCount)?place.userRatingCount:0,
      primary_type:place.primaryTypeDisplayName?.text||(place.types||[])[0]||null,types:place.types||[],
      latitude:Number.isFinite(loc.latitude)?loc.latitude:null,longitude:Number.isFinite(loc.longitude)?loc.longitude:null,
      maps_url:place.googleMapsUri||null,website:place.websiteUri||null,business_status:place.businessStatus||null
    });
  }
  const businesses=[...byId.values()].sort((a,b)=>a.name.localeCompare(b.name,"tr"));
  if(!process.env.DATABASE_URL)return res.status(503).json({ok:false,error:"database_unavailable",message:"İşletmeleri rehbere kaydetmek için DATABASE_URL gerekli."});
  let saved=0,duplicates=0;
  if(businesses.length){
    const sql=neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_workspace_items (
      id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,due_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS aloha_workspace_type_updated_idx ON aloha_workspace_items(type,updated_at DESC)`;
    const rows=businesses.map(b=>({
      id:randomUUID(),title:b.name,data:{
        phone:b.phone,category:b.primary_type||"Google işletmesi",address:b.address,
        latitude:b.latitude,longitude:b.longitude,source:"Google Places",google_place_id:b.id,
        rating:b.rating,user_rating_count:b.user_rating_count,business_status:b.business_status,
        maps_url:b.maps_url,website:b.website,types:b.types,province,district,call_status:"not_started"
      }
    }));
    const inserted=await sql`INSERT INTO aloha_workspace_items(id,type,title,status,data)
      SELECT item.id,'business',item.title,'open',item.data
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS item(id text,title text,data jsonb)
      WHERE NOT EXISTS (
        SELECT 1 FROM aloha_workspace_items existing
        WHERE existing.type='business'
        AND existing.data->>'google_place_id'=item.data->>'google_place_id'
      )
      RETURNING data->>'google_place_id' AS google_place_id`;
    saved=inserted.length;duplicates=businesses.length-saved;
  }
  return res.status(200).json({ok:true,province,district,resolved_address:result.formatted_address,total:businesses.length,saved,duplicates,pages_checked:pagesChecked,businesses,
    warning:"Google Places sonuçları sektör filtresi olmadan aranmıştır; Google sıralama ve görünürlük nedeniyle ilçedeki tüm işletmeleri eksiksiz döndürmeyi garanti etmez."});
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
    if (body.mode === "district_discovery") return await discoverDistrict(body, apiKey, res);
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
