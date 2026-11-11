import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";

function authorized(req) {
  const expected = process.env.LIVEKIT_WEBHOOK_SECRET || "";
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalize(body) {
  const root = body && typeof body === "object" ? body : {};
  const data = root.data && typeof root.data === "object" ? root.data : {};
  const call = root.call && typeof root.call === "object" ? root.call : {};
  const job = root.job && typeof root.job === "object" ? root.job : {};
  const room = root.room && typeof root.room === "object" ? root.room : {};
  const metadata = first(root.metadata, data.metadata, call.metadata, {}) || {};

  const summary = first(
    root.summary, data.summary, call.summary, job.summary,
    root.call_summary, data.call_summary, root.report?.summary,
    root.analysis?.summary, data.analysis?.summary
  );

  const jobId = first(
    root.job_id, root.jobId, job.id, job.job_id,
    data.job_id, data.jobId, call.job_id, call.id,
    root.id, root.event_id
  );

  const stableId = jobId || createHash("sha256").update(JSON.stringify(root)).digest("hex");
  const startedAt = asDate(first(
    root.started_at, root.startedAt, data.started_at, data.startedAt,
    call.started_at, call.startedAt, job.started_at, job.startedAt
  ));
  const endedAt = asDate(first(
    root.ended_at, root.endedAt, data.ended_at, data.endedAt,
    call.ended_at, call.endedAt, job.ended_at, job.endedAt,
    root.timestamp, data.timestamp
  ));

  let duration = first(
    root.duration_seconds, root.durationSeconds,
    data.duration_seconds, data.durationSeconds,
    call.duration_seconds, call.durationSeconds,
    job.duration_seconds, job.durationSeconds
  );
  if (duration === undefined && startedAt && endedAt) {
    duration = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  }
  const numericDuration = Number(duration);

  return {
    jobId: String(stableId),
    roomId: first(root.room_id, root.roomId, data.room_id, data.roomId, call.room_id, room.id, metadata.room_id),
    roomName: first(root.room_name, root.roomName, data.room_name, data.roomName, call.room_name, room.name, metadata.room_name),
    startedAt,
    endedAt,
    durationSeconds: Number.isFinite(numericDuration) && numericDuration >= 0 ? Math.round(numericDuration) : null,
    summary: typeof summary === "string" ? summary : summary == null ? null : JSON.stringify(summary),
    results: first(root.results, data.results, call.results, root.analysis, data.analysis, root),
    rawPayload: root
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "aloha-summary", accepts: "POST" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: "invalid_payload" });
    }

    const call = normalize(body);
    const sql = neon(process.env.DATABASE_URL);

    await sql`
      CREATE TABLE IF NOT EXISTS aloha_call_logs (
        job_id TEXT PRIMARY KEY,
        room_id TEXT,
        room_name TEXT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        summary TEXT,
        results JSONB,
        raw_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      INSERT INTO aloha_call_logs
        (job_id, room_id, room_name, started_at, ended_at, duration_seconds, summary, results, raw_payload, created_at)
      VALUES
        (${call.jobId}, ${call.roomId ?? null}, ${call.roomName ?? null},
         ${call.startedAt}, ${call.endedAt}, ${call.durationSeconds},
         ${call.summary}, ${JSON.stringify(call.results)}, ${JSON.stringify(call.rawPayload)}, NOW())
      ON CONFLICT (job_id) DO UPDATE SET
        room_id = COALESCE(EXCLUDED.room_id, aloha_call_logs.room_id),
        room_name = COALESCE(EXCLUDED.room_name, aloha_call_logs.room_name),
        started_at = COALESCE(EXCLUDED.started_at, aloha_call_logs.started_at),
        ended_at = COALESCE(EXCLUDED.ended_at, aloha_call_logs.ended_at),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, aloha_call_logs.duration_seconds),
        summary = COALESCE(EXCLUDED.summary, aloha_call_logs.summary),
        results = EXCLUDED.results,
        raw_payload = EXCLUDED.raw_payload
    `;

    return res.status(200).json({ ok: true, saved: true, job_id: call.jobId });
  } catch (error) {
    console.error("aloha_summary_save_error", error);
    return res.status(500).json({ ok: false, error: "summary_save_failed" });
  }
}
