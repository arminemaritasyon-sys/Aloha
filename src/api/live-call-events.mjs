import { neon } from "@neondatabase/serverless";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function equalText(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
function verifyLiveKit(body, authorization) {
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (!apiKey || !apiSecret || !authorization) return false;
  const token = String(authorization).replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (header.alg !== "HS256" || claims.iss !== apiKey) return false;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || Number(claims.exp) < now - 10 || (claims.nbf && Number(claims.nbf) > now + 10)) return false;
    const signature = createHmac("sha256", apiSecret).update(parts[0] + "." + parts[1]).digest("base64url");
    if (!equalText(signature, parts[2])) return false;
    const digest = createHash("sha256").update(body, "utf8").digest("base64");
    return Boolean(claims.sha256) && equalText(digest, claims.sha256);
  } catch { return false; }
}
const first = (...values) => values.find(v => v !== undefined && v !== null && v !== "");
function attributesOf(participant) {
  let attrs = participant?.attributes || {};
  if (typeof attrs === "string") { try { attrs = JSON.parse(attrs); } catch { attrs = {}; } }
  return attrs && typeof attrs === "object" ? attrs : {};
}
function eventTime(event) {
  const n = Number(event?.createdAt || event?.created_at || 0);
  return n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}
function mapEvent(event) {
  const room = event.room || {};
  const participant = event.participant || {};
  const attrs = attributesOf(participant);
  const eventName = String(event.event || "").toLowerCase();
  const roomId = String(first(room.sid, room.id, room.name, participant.sid, participant.identity, event.id) || "");
  if (!roomId) return null;
  let status = null;
  if (eventName === "room_started") status = "ringing";
  if (eventName === "participant_joined") status = "in_progress";
  if (eventName === "participant_left" || eventName === "room_finished") status = "completed";
  if (eventName === "participant_connection_aborted") status = "missed";
  if (!status) return null;
  const phone = first(
    attrs["sip.phoneNumber"], attrs["sip.phone_number"], attrs.phone,
    participant.phoneNumber, participant.phone_number
  );
  const callStatus = String(first(attrs["sip.callStatus"], attrs["sip.call_status"], "")).toLowerCase();
  if (callStatus === "ringing" && eventName !== "participant_left") status = "ringing";
  if (callStatus === "active") status = "in_progress";
  if (callStatus === "hangup") status = "completed";
  const at = eventTime(event);
  return {
    callId: roomId,
    roomId: String(first(room.sid, room.id, "") || roomId),
    roomName: String(first(room.name, participant.name, participant.identity, "") || ""),
    callerPhone: phone ? String(phone) : null,
    callerName: first(participant.name, attrs["sip.displayName"], attrs.display_name) ? String(first(participant.name, attrs["sip.displayName"], attrs.display_name)) : null,
    direction: String(first(attrs["sip.callDirection"], attrs["sip.call_direction"], "inbound") || "inbound"),
    status,
    eventAt: at,
    raw: event
  };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });
  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch { return res.status(400).json({ ok: false, error: "invalid_body" }); }
  if (!verifyLiveKit(rawBody, req.headers.authorization)) {
    console.warn("aloha_live_call_webhook_unauthorized", {
      authorizationHeaderPresent: Boolean(req.headers.authorization),
      livekitApiKeyConfigured: Boolean(process.env.LIVEKIT_API_KEY),
      livekitApiSecretConfigured: Boolean(process.env.LIVEKIT_API_SECRET)
    });
    return res.status(401).json({ ok: false, error: "invalid_livekit_signature" });
  }
  try {
    const event = JSON.parse(rawBody);
    const call = mapEvent(event);
    if (!call) return res.status(200).json({ ok: true, ignored: true, event: event.event || null });
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_live_calls (
      call_id TEXT PRIMARY KEY,
      room_id TEXT,
      room_name TEXT,
      caller_phone TEXT,
      caller_name TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ,
      answered_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      last_event_at TIMESTAMPTZ,
      last_event_id TEXT,
      raw_payload JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`INSERT INTO aloha_live_calls
      (call_id, room_id, room_name, caller_phone, caller_name, direction, status, started_at, answered_at, ended_at, last_event_at, last_event_id, raw_payload, updated_at)
      VALUES (
        ${call.callId}, ${call.roomId}, ${call.roomName}, ${call.callerPhone}, ${call.callerName},
        ${call.direction}, ${call.status},
        CASE WHEN ${call.status} = 'ringing' THEN ${call.eventAt}::timestamptz ELSE NULL END,
        CASE WHEN ${call.status} = 'in_progress' THEN ${call.eventAt}::timestamptz ELSE NULL END,
        CASE WHEN ${call.status} IN ('completed','missed') THEN ${call.eventAt}::timestamptz ELSE NULL END,
        ${call.eventAt}::timestamptz, ${String(event.id || "")}, ${JSON.stringify(call.raw)}::jsonb, NOW()
      )
      ON CONFLICT (call_id) DO UPDATE SET
        room_id = COALESCE(EXCLUDED.room_id, aloha_live_calls.room_id),
        room_name = COALESCE(NULLIF(EXCLUDED.room_name, ''), aloha_live_calls.room_name),
        caller_phone = COALESCE(NULLIF(EXCLUDED.caller_phone, ''), aloha_live_calls.caller_phone),
        caller_name = COALESCE(NULLIF(EXCLUDED.caller_name, ''), aloha_live_calls.caller_name),
        direction = COALESCE(NULLIF(EXCLUDED.direction, ''), aloha_live_calls.direction),
        status = CASE WHEN EXCLUDED.last_event_at >= COALESCE(aloha_live_calls.last_event_at, 'epoch'::timestamptz) THEN EXCLUDED.status ELSE aloha_live_calls.status END,
        started_at = COALESCE(aloha_live_calls.started_at, EXCLUDED.started_at),
        answered_at = COALESCE(aloha_live_calls.answered_at, EXCLUDED.answered_at),
        ended_at = COALESCE(EXCLUDED.ended_at, aloha_live_calls.ended_at),
        last_event_at = GREATEST(COALESCE(aloha_live_calls.last_event_at, 'epoch'::timestamptz), EXCLUDED.last_event_at),
        last_event_id = EXCLUDED.last_event_id,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `;
    await sql`CREATE TABLE IF NOT EXISTS aloha_livekit_webhook_health (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      last_event TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`INSERT INTO aloha_livekit_webhook_health (id, last_event, last_seen_at)
      VALUES (1, ${String(event.event || "unknown")}, NOW())
      ON CONFLICT (id) DO UPDATE SET last_event = EXCLUDED.last_event, last_seen_at = NOW()`;
    return res.status(200).json({ ok: true, received: true, event: event.event, status: call.status, call_id: call.callId });
  } catch (error) {
    console.error("aloha_live_call_webhook_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "live_call_event_save_failed" });
  }
}
