import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

function validKey(req) {
  const expected = (process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const priorities = new Set(["normal", "important", "follow_up", "resolved"]);

export default async function handler(req, res) {
  if (!["GET", "POST", "OPTIONS"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(204).end();
  }
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_call_annotations (
      job_id TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    if (req.method === "GET") {
      const rows = await sql`SELECT job_id, note, priority, updated_at FROM aloha_call_annotations ORDER BY updated_at DESC`;
      return res.status(200).json({ ok: true, annotations: rows });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const jobId = clean(body.job_id, 180);
    const note = clean(body.note, 5000);
    const priority = clean(body.priority || "normal", 30);
    if (!jobId || !priorities.has(priority)) {
      return res.status(400).json({ ok: false, error: "invalid_annotation" });
    }
    const [annotation] = await sql`
      INSERT INTO aloha_call_annotations (job_id, note, priority, updated_at)
      VALUES (${jobId}, ${note}, ${priority}, NOW())
      ON CONFLICT (job_id) DO UPDATE SET
        note = EXCLUDED.note,
        priority = EXCLUDED.priority,
        updated_at = NOW()
      RETURNING job_id, note, priority, updated_at
    `;
    return res.status(200).json({ ok: true, annotation });
  } catch (error) {
    console.error("aloha_call_annotations_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "annotations_database_error" });
  }
}
