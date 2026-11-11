import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";
function validKey(req) {
  const expected = (process.env.ALOHA_PANEL_KEY || "").trim();
  const supplied = String(req.headers["x-panel-key"] || "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
function findValue(root, names) {
  const wanted = new Set(names.map(x => x.toLowerCase()));
  const seen = new Set();
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return null;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && item != null && item !== "") {
        if (typeof item === "string" || typeof item === "number") return String(item);
        if (typeof item === "object" && (item.url || item.uri)) return String(item.url || item.uri);
      }
    }
    for (const item of Object.values(value)) {
      const found = walk(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return walk(root);
}
function safeHttpUrl(value) {
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) ? u.toString() : null; }
  catch { return null; }
}
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); return res.status(405).json({ok:false,error:"method_not_allowed"}); }
  if (!validKey(req)) return res.status(401).json({ok:false,error:"unauthorized"});
  try {
    const sql = neon(process.env.DATABASE_URL);
    const calls = await sql`SELECT job_id, room_id, room_name, started_at, ended_at, duration_seconds, summary, results, raw_payload, created_at FROM aloha_call_logs ORDER BY created_at DESC LIMIT 100`;
    const enriched = calls.map(call => {
      const raw = call.raw_payload || {};
      const audio = findValue(raw, ["recording_url","recordingUrl","audio_url","audioUrl","recording_uri","recordingUri","media_url","mediaUrl","recording","audio"]);
      const transcript = findValue(raw, ["transcript","transcription","full_transcript","fullTranscript"]);
      const phone = findValue(raw, ["caller_phone","callerPhone","phone_number","phoneNumber","from_number","fromNumber","customer_phone","customerPhone"]);
      const customer = findValue(raw, ["customer_name","customerName","caller_name","callerName"]);
      const intent = findValue(raw, ["intent","call_intent","callIntent","topic"]);
      const sentiment = findValue(raw, ["sentiment","customer_sentiment","customerSentiment"]);
      const product = findValue(raw, ["product","product_name","productName","item_name","itemName"]);
      const quantity = findValue(raw, ["quantity","qty","amount"]);
      const address = findValue(raw, ["delivery_address","deliveryAddress","address"]);
      const roomPhone = String(call.room_name || "").match(/\\+?\\d[\\d\\s().-]{8,}\\d/);
      return {...call, audio_url: audio ? safeHttpUrl(audio) : null, transcript, caller_phone: phone || (roomPhone ? roomPhone[0].replace(/[\\s().-]/g, "") : null), customer_name: customer, intent, sentiment, product, quantity, address};
    });
    return res.status(200).json({ok:true,calls:enriched});
  } catch (error) {
    console.error("aloha_calls_list_error", {message:error?.message || String(error)});
    return res.status(500).json({ok:false,error:"database_error"});
  }
}