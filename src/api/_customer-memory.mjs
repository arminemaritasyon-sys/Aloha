import { neon } from "@neondatabase/serverless";

export function normalizePhone(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10) digits = "90" + digits;
  else if (digits.length === 11 && digits.startsWith("0")) digits = "90" + digits.slice(1);
  if (digits.length < 8 || digits.length > 15) return null;
  return "+" + digits;
}

export async function ensureMemorySchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS aloha_customers (
    id TEXT PRIMARY KEY,
    phone_e164 TEXT NOT NULL UNIQUE,
    full_name TEXT,
    consent_at TIMESTAMPTZ,
    consent_source TEXT,
    memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS aloha_customer_memories (
    id BIGSERIAL PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES aloha_customers(id) ON DELETE CASCADE,
    call_job_id TEXT,
    summary TEXT NOT NULL,
    intent TEXT,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    order_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
    follow_up TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS aloha_customer_memories_customer_date_idx
    ON aloha_customer_memories(customer_id, created_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS aloha_memory_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    personalized_greeting BOOLEAN NOT NULL DEFAULT TRUE,
    save_call_summaries BOOLEAN NOT NULL DEFAULT TRUE,
    save_preferences BOOLEAN NOT NULL DEFAULT TRUE,
    retention_days INTEGER NOT NULL DEFAULT 365,
    greeting_template TEXT NOT NULL DEFAULT 'Merhaba {{name}}, tekrar hoş geldiniz. Size nasıl yardımcı olabilirim?'
  )`;
  await sql`INSERT INTO aloha_memory_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
}

export async function appendCallMemory(sql, call) {
  await ensureMemorySchema(sql);
  const raw = call?.rawPayload || {};
  const keys = new Set(["caller_phone","callerPhone","phone_number","phoneNumber","from_number","fromNumber","customer_phone","customerPhone","sip.phoneNumber"]);
  const names = new Set(["customer_name","customerName","caller_name","callerName","full_name","fullName"]);
  const summaries = [call?.summary, raw.summary, raw.call_summary, raw.analysis?.summary, raw.data?.summary];
  let phone = null, name = null;
  const seen = new Set();
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" || typeof item === "number") {
        if (!phone && keys.has(key)) phone = String(item);
        if (!name && names.has(key)) name = String(item);
      }
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  }
  walk(raw);
  const normalized = normalizePhone(phone);
  const summary = String(summaries.find(x => typeof x === "string" && x.trim()) || "").trim().slice(0, 8000);
  if (!normalized || !summary) return false;
  const [settings] = await sql`SELECT enabled, save_call_summaries, retention_days FROM aloha_memory_settings WHERE id=1`;
  if (!settings?.enabled || !settings?.save_call_summaries) return false;
  const [customer] = await sql`SELECT id FROM aloha_customers
    WHERE phone_e164=${normalized} AND consent_at IS NOT NULL AND memory_enabled=TRUE LIMIT 1`;
  if (!customer) return false;
  await sql`INSERT INTO aloha_customer_memories (customer_id, call_job_id, summary, intent)
    VALUES (${customer.id}, ${String(call?.jobId || "").slice(0,180) || null}, ${summary}, ${String(raw.intent || raw.call_intent || "").slice(0,500) || null})`;
  const days = Math.max(30, Math.min(3650, Number(settings.retention_days) || 365));
  await sql`DELETE FROM aloha_customer_memories WHERE customer_id=${customer.id}
    AND created_at < NOW() - (${days}::text || ' days')::interval`;
  if (name) await sql`UPDATE aloha_customers SET full_name=COALESCE(NULLIF(full_name,''), ${name.slice(0,180)}), updated_at=NOW() WHERE id=${customer.id}`;
  return true;
}
