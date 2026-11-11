import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

function validPanelKey(req) {
  const expected = (process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!validPanelKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_webhook_health (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      detail TEXT,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    const rows = await sql`SELECT status, detail, last_seen_at FROM aloha_webhook_health WHERE id = 1 LIMIT 1`;
    return res.status(200).json({ ok: true, health: rows[0] || null });
  } catch (error) {
    console.error("aloha_webhook_status_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "status_unavailable" });
  }
}
