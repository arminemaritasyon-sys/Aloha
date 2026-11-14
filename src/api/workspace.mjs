import { neon } from "@neondatabase/serverless";
import { timingSafeEqual, randomUUID } from "node:crypto";

function validKey(req) {
  const expected = String(process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
const TYPES = new Set(["task", "business", "product", "followup", "support", "campaign", "inventory", "feedback", "offer", "journey", "brand"]);
const STATUSES = new Set(["open", "in_progress", "done", "archived"]);
const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

export default async function handler(req, res) {
  if (!["GET", "POST", "PATCH", "DELETE", "OPTIONS"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_workspace_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS aloha_workspace_type_updated_idx ON aloha_workspace_items(type, updated_at DESC)`;

    if (req.method === "GET") {
      const rows = await sql`SELECT id, type, title, status, data, due_at, created_at, updated_at FROM aloha_workspace_items ORDER BY updated_at DESC LIMIT 1000`;
      return res.status(200).json({ ok: true, items: rows });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const type = clean(body.type, 30);
    if (!TYPES.has(type)) return res.status(400).json({ ok: false, error: "invalid_type" });

    if (req.method === "POST" && Array.isArray(body.items)) {
      if (type !== "business") return res.status(400).json({ ok: false, error: "bulk_business_only" });
      if (body.items.length > 150) return res.status(400).json({ ok: false, error: "bulk_limit_exceeded" });
      let saved = 0, duplicates = 0;
      const savedPlaceIds = [], duplicatePlaceIds = [];
      for (const entry of body.items) {
        const title = clean(entry?.title, 180);
        const data = entry?.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
        const placeId = clean(data.google_place_id, 220);
        if (!title || !placeId) continue;
        const existing = await sql`SELECT id FROM aloha_workspace_items WHERE type='business' AND data->>'google_place_id'=${placeId} LIMIT 1`;
        if (existing.length) { duplicates++; duplicatePlaceIds.push(placeId); continue; }
        const id = randomUUID();
        await sql`INSERT INTO aloha_workspace_items (id,type,title,status,data)
          VALUES (${id},'business',${title},'open',${JSON.stringify(data)}::jsonb)`;
        saved++; savedPlaceIds.push(placeId);
      }
      return res.status(201).json({ ok: true, saved, duplicates, saved_place_ids: savedPlaceIds, duplicate_place_ids: duplicatePlaceIds });
    }

    if (req.method === "POST") {
      const title = clean(body.title, 180);
      if (!title) return res.status(400).json({ ok: false, error: "title_required" });
      const status = STATUSES.has(body.status) ? body.status : "open";
      const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
      const dueAt = body.due_at ? new Date(body.due_at) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) return res.status(400).json({ ok: false, error: "invalid_due_date" });
      const id = randomUUID();
      const [item] = await sql`INSERT INTO aloha_workspace_items (id,type,title,status,data,due_at)
        VALUES (${id},${type},${title},${status},${JSON.stringify(data)}::jsonb,${dueAt ? dueAt.toISOString() : null})
        RETURNING id,type,title,status,data,due_at,created_at,updated_at`;
      return res.status(201).json({ ok: true, item });
    }

    const id = clean(body.id, 80);
    if (!id) return res.status(400).json({ ok: false, error: "id_required" });
    if (req.method === "DELETE") {
      const rows = await sql`DELETE FROM aloha_workspace_items WHERE id=${id} AND type=${type} RETURNING id`;
      if (!rows.length) return res.status(404).json({ ok: false, error: "item_not_found" });
      return res.status(200).json({ ok: true, id });
    }

    const updates = [];
    const title = body.title === undefined ? null : clean(body.title, 180);
    const status = body.status === undefined ? null : (STATUSES.has(body.status) ? body.status : null);
    const data = body.data === undefined ? null : (body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null);
    const dueAt = body.due_at === undefined ? undefined : (body.due_at ? new Date(body.due_at) : null);
    if (title !== null && !title) return res.status(400).json({ ok: false, error: "title_required" });
    if (body.status !== undefined && !status) return res.status(400).json({ ok: false, error: "invalid_status" });
    if (dueAt && Number.isNaN(dueAt.getTime())) return res.status(400).json({ ok: false, error: "invalid_due_date" });
    const [item] = await sql`UPDATE aloha_workspace_items SET
      title=COALESCE(${title},title),
      status=COALESCE(${status},status),
      data=COALESCE(${data ? JSON.stringify(data) : null}::jsonb,data),
      due_at=CASE WHEN ${body.due_at !== undefined} THEN ${dueAt ? dueAt.toISOString() : null}::timestamptz ELSE due_at END,
      updated_at=NOW()
      WHERE id=${id} AND type=${type}
      RETURNING id,type,title,status,data,due_at,created_at,updated_at`;
    if (!item) return res.status(404).json({ ok: false, error: "item_not_found" });
    return res.status(200).json({ ok: true, item });
  } catch (error) {
    console.error("aloha_workspace_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "workspace_database_error" });
  }
}
