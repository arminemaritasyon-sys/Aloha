import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";
function validKey(req) {
  const expected = (process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_live_calls (
      call_id TEXT PRIMARY KEY, room_id TEXT, room_name TEXT, caller_phone TEXT, caller_name TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound', status TEXT NOT NULL, started_at TIMESTAMPTZ,
      answered_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, last_event_at TIMESTAMPTZ,
      last_event_id TEXT, raw_payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS aloha_livekit_webhook_health (
      id SMALLINT PRIMARY KEY CHECK (id = 1), last_event TEXT NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS aloha_live_call_controls (
      call_id TEXT PRIMARY KEY,
      is_on_hold BOOLEAN NOT NULL DEFAULT FALSE,
      hold_tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    const [active, recent, health] = await Promise.all([
      sql`SELECT c.call_id, c.room_id, c.room_name, c.caller_phone, c.caller_name, c.direction, c.status, c.started_at, c.answered_at, c.ended_at, c.last_event_at, c.updated_at,
          COALESCE(ctrl.is_on_hold, FALSE) AS on_hold
        FROM aloha_live_calls c LEFT JOIN aloha_live_call_controls ctrl ON ctrl.call_id = c.call_id
        WHERE c.status IN ('ringing','in_progress')
        ORDER BY COALESCE(c.answered_at, c.started_at, c.updated_at) DESC LIMIT 50`,
      sql`SELECT c.call_id, c.room_id, c.room_name, c.caller_phone, c.caller_name, c.direction, c.status, c.started_at, c.answered_at, c.ended_at, c.last_event_at, c.updated_at,
          COALESCE(ctrl.is_on_hold, FALSE) AS on_hold
        FROM aloha_live_calls c LEFT JOIN aloha_live_call_controls ctrl ON ctrl.call_id = c.call_id
        WHERE c.updated_at > NOW() - INTERVAL '24 hours'
        ORDER BY c.updated_at DESC LIMIT 50`,
      sql`SELECT last_event, last_seen_at FROM aloha_livekit_webhook_health WHERE id = 1 LIMIT 1`
    ]);
    return res.status(200).json({ ok: true, active, recent, webhook: health[0] || null, pollAfterMs: 2000 });
  } catch (error) {
    console.error("aloha_live_calls_list_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "live_calls_unavailable" });
  }
}
