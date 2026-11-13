import { neon } from "@neondatabase/serverless";
import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { timingSafeEqual } from "node:crypto";

function validKey(req) {
  const expected = (process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
const clean = (v, max = 256) => String(v ?? "").trim().slice(0, max);
function attrsOf(p) {
  let a = p?.attributes || {};
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
  return a && typeof a === "object" ? a : {};
}
function isSip(p) {
  const a = attrsOf(p);
  return Boolean(a["sip.callID"] || a["sip.callId"] || a["sip.phoneNumber"] || a["sip.callStatus"] || String(p?.kind || "").toLowerCase().includes("sip"));
}
function audioTracks(p) {
  return (p?.tracks || []).filter(t =>
    t?.sid && (t.type === 0 || String(t.type).toUpperCase() === "AUDIO" || String(t.mimeType || "").toLowerCase().startsWith("audio/"))
  );
}
function transferTarget(value) {
  const raw = clean(value, 260);
  if (/^sip:[^\s<>]{3,240}$/i.test(raw)) return raw;
  const digits = raw.replace(/[\s().-]/g, "");
  const normalized = digits.startsWith("+") ? digits : digits.startsWith("00") ? "+" + digits.slice(2) : "+" + digits;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return "";
  return "tel:" + normalized;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const callId = clean(body.callId, 256);
  const action = clean(body.action, 24).toLowerCase();
  if (!callId || !["hold", "resume", "transfer"].includes(action)) {
    return res.status(400).json({ ok: false, error: "invalid_call_action" });
  }
  const host = (process.env.LIVEKIT_URL || "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (!host || !apiKey || !apiSecret) return res.status(503).json({ ok: false, error: "livekit_server_credentials_missing" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: "database_unavailable" });

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT call_id, room_name, status, raw_payload FROM aloha_live_calls WHERE call_id = ${callId} LIMIT 1`;
    const call = rows[0];
    if (!call) return res.status(404).json({ ok: false, error: "call_not_found" });
    if (String(call.status || "").toLowerCase() !== "in_progress") {
      return res.status(409).json({ ok: false, error: "call_not_connected" });
    }
    const raw = call.raw_payload || {};
    const roomName = clean(raw.room?.name || call.room_name, 256);
    if (!roomName) return res.status(409).json({ ok: false, error: "livekit_room_name_missing" });
    const rooms = new RoomServiceClient(host, apiKey, apiSecret);
    const participants = await rooms.listParticipants(roomName);
    if (!participants.length) return res.status(409).json({ ok: false, error: "call_participants_not_found" });
    const sipParticipant = participants.find(isSip);
    if (!sipParticipant) return res.status(409).json({ ok: false, error: "sip_participant_not_found" });

    if (action === "transfer") {
      const destination = transferTarget(body.destination);
      if (!destination) return res.status(400).json({ ok: false, error: "invalid_transfer_destination" });
      const sip = new SipClient(host, apiKey, apiSecret);
      await sip.transferSipParticipant(roomName, sipParticipant.identity, destination);
      return res.status(200).json({ ok: true, action: "transfer", destination });
    }

    await sql`CREATE TABLE IF NOT EXISTS aloha_live_call_controls (
      call_id TEXT PRIMARY KEY,
      is_on_hold BOOLEAN NOT NULL DEFAULT FALSE,
      hold_tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    if (action === "hold") {
      const agents = participants.filter(p => p.identity !== sipParticipant.identity);
      const targets = agents.flatMap(p => audioTracks(p).map(t => ({ identity: p.identity, trackSid: t.sid })));
      if (!targets.length) return res.status(409).json({ ok: false, error: "agent_audio_track_not_found", detail: "Aloha ses kanalı bulunamadı; çağrı beklemeye alınmadı." });
      const done = [];
      try {
        for (const track of targets) {
          await rooms.mutePublishedTrack(roomName, track.identity, track.trackSid, true);
          done.push(track);
        }
      } catch (error) {
        await Promise.allSettled(done.map(t => rooms.mutePublishedTrack(roomName, t.identity, t.trackSid, false)));
        throw error;
      }
      await sql`INSERT INTO aloha_live_call_controls (call_id, is_on_hold, hold_tracks, updated_at)
        VALUES (${callId}, TRUE, ${JSON.stringify(done)}::jsonb, NOW())
        ON CONFLICT (call_id) DO UPDATE SET is_on_hold = TRUE, hold_tracks = EXCLUDED.hold_tracks, updated_at = NOW()`;
      return res.status(200).json({ ok: true, action: "hold", onHold: true, mutedTracks: done.length, holdMode: "agent_audio_muted" });
    }

    const states = await sql`SELECT is_on_hold, hold_tracks FROM aloha_live_call_controls WHERE call_id = ${callId} LIMIT 1`;
    const state = states[0];
    if (!state?.is_on_hold) return res.status(409).json({ ok: false, error: "call_not_on_hold" });
    const savedTracks = Array.isArray(state.hold_tracks) ? state.hold_tracks : [];
    const failures = [];
    for (const track of savedTracks) {
      try { await rooms.mutePublishedTrack(roomName, track.identity, track.trackSid, false); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) {
      return res.status(502).json({ ok: false, error: "call_resume_failed", remainingTracks: failures.length });
    }
    await sql`UPDATE aloha_live_call_controls SET is_on_hold = FALSE, hold_tracks = '[]'::jsonb, updated_at = NOW() WHERE call_id = ${callId}`;
    return res.status(200).json({ ok: true, action: "resume", onHold: false });
  } catch (error) {
    console.error("aloha_live_call_control_error", { action, message: error?.message || String(error) });
    const message = String(error?.message || "");
    if (action === "transfer" && /transfer|refer|unsupported|not allowed/i.test(message)) {
      return res.status(502).json({ ok: false, error: "sip_transfer_not_supported", detail: "Telefon operatörünün SIP REFER çağrı aktarımını etkinleştirmesi gerekiyor." });
    }
    return res.status(502).json({ ok: false, error: action === "transfer" ? "call_transfer_failed" : "livekit_call_control_failed" });
  }
}
