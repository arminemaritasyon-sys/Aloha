import { neon } from "@neondatabase/serverless";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { ensureMemorySchema, normalizePhone } from "../lib/customer-memory.mjs";

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
function agentAuth(req) { const bearer=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i)?.[1]||""; const eq=(a,b)=>{if(!a||!b)return false;const x=Buffer.from(String(a).trim()),y=Buffer.from(String(b).trim());return x.length===y.length&&timingSafeEqual(x,y)}; return eq(process.env.ALOHA_AGENT_API_KEY,req.headers["x-aloha-agent-key"])||eq(process.env.LIVEKIT_WEBHOOK_SECRET,bearer); }

async function handleCustomerMemory(req,res,sql,isPanel,isAgent) {
  await ensureMemorySchema(sql);
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  if(req.method==="GET"){
    const [settings]=await sql`SELECT * FROM aloha_memory_settings WHERE id=1`;
    const phone=normalizePhone(req.query?.phone||"");
    if(phone){
      const [customer]=await sql`SELECT id,phone_e164,full_name,consent_at,consent_source,memory_enabled,created_at,updated_at FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
      if(!customer)return res.status(200).json({ok:true,settings,customer:null,memories:[]});
      const memories=await sql`SELECT id,call_job_id,summary,intent,preferences,order_notes,follow_up,created_at FROM aloha_customer_memories WHERE customer_id=${customer.id} ORDER BY created_at DESC LIMIT 50`;
      return res.status(200).json({ok:true,settings,customer,memories});
    }
    const customers=await sql`SELECT c.id,c.phone_e164,c.full_name,c.consent_at,c.memory_enabled,c.updated_at,COUNT(m.id)::int AS memory_count,MAX(m.created_at) AS last_memory_at FROM aloha_customers c LEFT JOIN aloha_customer_memories m ON m.customer_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 250`;
    return res.status(200).json({ok:true,settings,customers});
  }
  if(req.method==="POST"){
    if(!isAgent&&!isPanel)return res.status(403).json({ok:false,error:"agent_access_required"});
    const action=clean(body.action,40),phone=normalizePhone(body.phone);
    if(!phone)return res.status(400).json({ok:false,error:"valid_phone_required"});
    if(action==="lookup"){
      const [settings]=await sql`SELECT enabled,personalized_greeting,greeting_template FROM aloha_memory_settings WHERE id=1`;
      if(!settings?.enabled)return res.status(200).json({ok:true,found:false,memory_enabled:false});
      const [customer]=await sql`SELECT id,full_name,consent_at,memory_enabled FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
      if(!customer)return res.status(200).json({ok:true,found:false,needs_consent:true});
      if(!customer.consent_at||!customer.memory_enabled)return res.status(200).json({ok:true,found:true,personalization_allowed:false,needs_consent:!customer.consent_at});
      const memories=settings.personalized_greeting?await sql`SELECT summary,intent,preferences,order_notes,follow_up,created_at FROM aloha_customer_memories WHERE customer_id=${customer.id} ORDER BY created_at DESC LIMIT 5`:[];
      const greeting=settings.personalized_greeting&&customer.full_name?settings.greeting_template.replaceAll("{{name}}",customer.full_name):null;
      return res.status(200).json({ok:true,found:true,personalization_allowed:true,customer_name:customer.full_name,greeting,memories});
    }
    if(action==="consent"||action==="remember"){
      const [settings]=await sql`SELECT enabled,save_call_summaries,save_preferences FROM aloha_memory_settings WHERE id=1`;
      if(!settings?.enabled)return res.status(409).json({ok:false,error:"customer_memory_disabled"});
      const [existing]=await sql`SELECT id,consent_at FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
      if(!existing?.consent_at&&body.consent!==true)return res.status(409).json({ok:false,error:"explicit_customer_consent_required"});
      const name=clean(body.full_name,180);
      const [customer]=await sql`INSERT INTO aloha_customers(id,phone_e164,full_name,consent_at,consent_source,memory_enabled,updated_at)
        VALUES(${randomUUID()},${phone},${name||null},NOW(),'voice_consent',TRUE,NOW())
        ON CONFLICT(phone_e164) DO UPDATE SET full_name=COALESCE(NULLIF(EXCLUDED.full_name,''),aloha_customers.full_name),consent_at=COALESCE(aloha_customers.consent_at,NOW()),consent_source=COALESCE(aloha_customers.consent_source,'voice_consent'),memory_enabled=TRUE,updated_at=NOW()
        RETURNING id,phone_e164,full_name,consent_at,memory_enabled`;
      if(action==="remember"){
        const summary=clean(body.summary,8000);
        if(summary)await sql`INSERT INTO aloha_customer_memories(customer_id,call_job_id,summary,intent,preferences,order_notes,follow_up)
          VALUES(${customer.id},${clean(body.call_job_id,180)||null},${summary},${clean(body.intent,500)||null},${JSON.stringify(settings.save_preferences?(body.preferences||{}):{})}::jsonb,${JSON.stringify(body.order_notes||[])}::jsonb,${clean(body.follow_up,1200)||null})`;
      }
      return res.status(200).json({ok:true,customer,saved:action==="remember"});
    }
    return res.status(400).json({ok:false,error:"invalid_action"});
  }
  if(req.method==="PATCH"){
    if(body.type==="settings"){
      const [settings]=await sql`UPDATE aloha_memory_settings SET enabled=${body.enabled===true},personalized_greeting=${body.personalized_greeting!==false},save_call_summaries=${body.save_call_summaries!==false},save_preferences=${body.save_preferences!==false},retention_days=${Math.max(30,Math.min(3650,Number(body.retention_days)||365))},greeting_template=${clean(body.greeting_template,500)||"Merhaba {{name}}, tekrar hoş geldiniz. Size nasıl yardımcı olabilirim."} WHERE id=1 RETURNING *`;
      return res.status(200).json({ok:true,settings});
    }
    const id=clean(body.customer_id,80);
    if(!id)return res.status(400).json({ok:false,error:"customer_id_required"});
    const [customer]=await sql`UPDATE aloha_customers SET full_name=${clean(body.full_name,180)||null},memory_enabled=${body.memory_enabled!==false},consent_at=CASE WHEN ${body.revoke_consent===true} THEN NULL ELSE consent_at END,consent_source=CASE WHEN ${body.revoke_consent===true} THEN NULL ELSE consent_source END,updated_at=NOW() WHERE id=${id} RETURNING id,phone_e164,full_name,consent_at,memory_enabled,updated_at`;
    if(!customer)return res.status(404).json({ok:false,error:"customer_not_found"});
    if(body.revoke_consent===true)await sql`DELETE FROM aloha_customer_memories WHERE customer_id=${id}`;
    return res.status(200).json({ok:true,customer});
  }
  if(req.method==="DELETE"){
    const id=clean(req.query?.customer_id||body.customer_id,80);
    if(!id)return res.status(400).json({ok:false,error:"customer_id_required"});
    await sql`DELETE FROM aloha_customers WHERE id=${id}`;
    return res.status(200).json({ok:true,deleted:true});
  }
  return res.status(405).json({ok:false,error:"method_not_allowed"});
}


export default async function handler(req, res) {
  if (!["GET", "POST", "PATCH", "DELETE", "OPTIONS"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (String(req.query?.resource||"") === "customer-memory") {
    const isPanel=validKey(req), isAgent=agentAuth(req);
    if ((req.method==="GET"||req.method==="PATCH"||req.method==="DELETE")&&!isPanel) return res.status(401).json({ok:false,error:"unauthorized"});
    if (req.method==="POST"&&!isPanel&&!isAgent) return res.status(401).json({ok:false,error:"unauthorized"});
    if (!process.env.DATABASE_URL) return res.status(503).json({ok:false,error:"database_unavailable"});
    try { return await handleCustomerMemory(req,res,neon(process.env.DATABASE_URL),isPanel,isAgent); }
    catch(error) { console.error("aloha_customer_memory_error",{message:error?.message||String(error)}); return res.status(500).json({ok:false,error:"customer_memory_error"}); }
  }
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
