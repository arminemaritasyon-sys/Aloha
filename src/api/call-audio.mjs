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
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!validKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const sessionId = String(req.query?.sessionId || "").trim();
  if (!/^RM_[A-Za-z0-9_-]{6,100}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, error: "invalid_session_id" });
  }

  const projectId = (process.env.LIVEKIT_PROJECT_ID || "").trim();
  const sessionToken = (process.env.LIVEKIT_SESSION_TOKEN || "").trim();
  if (!projectId || !sessionToken) {
    return res.status(503).json({ ok: false, error: "livekit_session_token_not_configured" });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT room_id FROM aloha_call_logs WHERE room_id = ${sessionId} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ ok: false, error: "call_not_found" });

    const endpoint = new URL(
      "https://beta-api.livekit.cloud/v0/projects/" +
      encodeURIComponent(projectId) + "/sessions/" +
      encodeURIComponent(sessionId) + "/recording-url"
    );
    endpoint.searchParams.set("fileType", "RECORDING_FILE_TYPE_AUDIO");
    endpoint.searchParams.set("expirySeconds", "900");

    const upstream = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: "Bearer " + sessionToken, Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    const data = await upstream.json().catch(() => ({}));

    if (upstream.status === 404) {
      return res.status(404).json({ ok: false, error: "recording_not_found" });
    }
    if (upstream.status === 401) {
      return res.status(503).json({ ok: false, error: "livekit_session_token_expired" });
    }
    if (upstream.status === 403) {
      return res.status(503).json({ ok: false, error: "livekit_admin_permission_required" });
    }
    if (!upstream.ok) {
      console.error("aloha_call_audio_livekit_error", {
        status: upstream.status,
        requestId: upstream.headers.get("x-request-id")
      });
      return res.status(502).json({ ok: false, error: "livekit_recording_request_failed" });
    }

    if (!data.url) {
      return res.status(202).json({
        ok: false,
        error: "recording_not_ready",
        retryAfterSeconds: Number(data.dataStatus?.retryAfterSeconds) || 10
      });
    }

    return res.status(200).json({
      ok: true,
      url: data.url,
      expiresAt: data.expiresAt || null
    });
  } catch (error) {
    console.error("aloha_call_audio_error", { message: error?.message || String(error) });
    return res.status(500).json({ ok: false, error: "audio_request_failed" });
  }
}
