import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";
function validKey(req) {
  const expected = process.env.ALOHA_PANEL_KEY || "";
  const supplied = req.headers["x-panel-key"] || "";
  if (!expected || typeof supplied !== "string") return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); return res.status(405).json({ok:false,error:"method_not_allowed"}); }
  if (!validKey(req)) return res.status(401).json({ok:false,error:"unauthorized"});
  try {
    const sql = neon(process.env.DATABASE_URL);
    const calls = await sql`SELECT job_id, room_id, room_name, started_at, ended_at, duration_seconds, summary, results, created_at FROM aloha_call_logs ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ok:true,calls});
  } catch (error) {
    console.error("aloha_calls_list_error", error);
    return res.status(500).json({ok:false,error:"database_error"});
  }
}