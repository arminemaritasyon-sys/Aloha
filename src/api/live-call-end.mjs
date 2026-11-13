import { neon } from "@neondatabase/serverless";
import { RoomServiceClient } from "livekit-server-sdk";
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const callId = String(req.body?.callId || "").trim();
  if (!callId || callId.length > 256) return res.status(400).json({ ok: false, error: "invalid_call_id" });
  const livekitUrl = (process.env.LIVEKIT_URL || "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (!livekitUrl || !apiKey || !apiSecret) return res.status(503).json({ ok: false, error: "livekit_server_credentials_missing" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT call_id, room_name, status, raw_payload FROM aloha_live_calls WHERE call_id = ${callId} LIMIT 1`;
    const call = rows[0];
    if (!call) return res.status(404).json({ ok: false, error: "call_not_found" });
    if (!["ringing", "in_progress"].includes(String(call.status || "").toLowerCase())) {
      return res.status(409).json({ ok: false, error: "call_not_active" });
    }
    const raw = call.raw_payload || {};
    const roomName = String(raw.room?.name || call.room_name || "").trim();
    if (!roomName) return res.status(409).json({ ok: false, error: "livekit_room_name_missing" });
    const rooms = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    const participants = await rooms.listParticipants(roomName);
    if (!participants.length) {
      await sql`UPDATE aloha_live_calls SET status = 'completed', ended_at = NOW(), updated_at = NOW() WHERE call_id = ${callId}`;
      return res.status(200).json({ ok: true, ended: true, alreadyDisconnected: true });
    }
    // Remove every participant in this dedicated phone-call room so the SIP leg is hung up too.
    for (const participant of participants) {
      await rooms.removeParticipant(roomName, participant.identity);
    }
    await sql`UPDATE aloha_live_calls SET status = 'completed', ended_at = NOW(), updated_at = NOW() WHERE call_id = ${callId}`;
    return res.status(200).json({ ok: true, ended: true, callId });
  } catch (error) {
    console.error("aloha_live_call_end_error", { message: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: "livekit_call_end_failed" });
  }
}
