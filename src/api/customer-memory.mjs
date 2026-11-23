import { neon } from "@neondatabase/serverless";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ensureMemorySchema, normalizePhone } from "./_customer-memory.mjs";

const clean = (v, n=2000) => String(v ?? "").trim().slice(0,n);
function equal(a,b) {
  if (!a || !b) return false;
  const x=Buffer.from(String(a).trim()), y=Buffer.from(String(b).trim());
  return x.length===y.length && timingSafeEqual(x,y);
}
const panelAuth = req => equal(process.env.ALOHA_PANEL_KEY, req.headers["x-panel-key"]);
const agentAuth = req => {
  const bearer=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i)?.[1]||"";
  return equal(process.env.ALOHA_AGENT_API_KEY,req.headers["x-aloha-agent-key"]) ||
    equal(process.env.LIVEKIT_WEBHOOK_SECRET,bearer);
};
export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store, max-age=0");
  if (!["GET","POST","PATCH","DELETE","OPTIONS"].includes(req.method)) {
    res.setHeader("Allow","GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ok:false,error:"method_not_allowed"});
  }
  if (req.method==="OPTIONS") { res.setHeader("Allow","GET, POST, PATCH, DELETE, OPTIONS"); return res.status(204).end(); }
  const isPanel=panelAuth(req), isAgent=agentAuth(req);
  if ((req.method==="GET" || req.method==="PATCH" || req.method==="DELETE") && !isPanel) return res.status(401).json({ok:false,error:"unauthorized"});
  if (req.method==="POST" && !isAgent && !isPanel) return res.status(401).json({ok:false,error:"unauthorized"});
  if (!process.env.DATABASE_URL) return res.status(503).json({ok:false,error:"database_unavailable"});
  try {
    const sql=neon(process.env.DATABASE_URL);
    await ensureMemorySchema(sql);
    const body=typeof req.body==="string" ? JSON.parse(req.body) : (req.body||{});

    if (req.method==="GET") {
      const [settings]=await sql`SELECT * FROM aloha_memory_settings WHERE id=1`;
      const phone=normalizePhone(req.query?.phone || "");
      if (phone) {
        const [customer]=await sql`SELECT id,phone_e164,full_name,consent_at,consent_source,memory_enabled,created_at,updated_at
          FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
        if (!customer) return res.status(200).json({ok:true,settings,customer:null,memories:[]});
        const memories=await sql`SELECT id,call_job_id,summary,intent,preferences,order_notes,follow_up,created_at
          FROM aloha_customer_memories WHERE customer_id=${customer.id} ORDER BY created_at DESC LIMIT 50`;
        return res.status(200).json({ok:true,settings,customer,memories});
      }
      const customers=await sql`SELECT c.id,c.phone_e164,c.full_name,c.consent_at,c.memory_enabled,c.updated_at,
        COUNT(m.id)::int AS memory_count, MAX(m.created_at) AS last_memory_at
        FROM aloha_customers c LEFT JOIN aloha_customer_memories m ON m.customer_id=c.id
        GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 250`;
      return res.status(200).json({ok:true,settings,customers});
    }

    if (req.method==="POST") {
      const action=clean(body.action,40);
      const phone=normalizePhone(body.phone);
      if (!phone) return res.status(400).json({ok:false,error:"valid_phone_required"});
      if (action==="lookup") {
        if (!isAgent) return res.status(403).json({ok:false,error:"agent_access_required"});
        const [settings]=await sql`SELECT enabled,personalized_greeting,greeting_template FROM aloha_memory_settings WHERE id=1`;
        if (!settings?.enabled) return res.status(200).json({ok:true,found:false,memory_enabled:false});
        const [customer]=await sql`SELECT id,full_name,consent_at,memory_enabled FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
        if (!customer) return res.status(200).json({ok:true,found:false,needs_consent:true});
        if (!customer.consent_at || !customer.memory_enabled) return res.status(200).json({ok:true,found:true,personalization_allowed:false,needs_consent:!customer.consent_at});
        const memories=settings.personalized_greeting ? await sql`SELECT summary,intent,preferences,order_notes,follow_up,created_at
          FROM aloha_customer_memories WHERE customer_id=${customer.id} ORDER BY created_at DESC LIMIT 5` : [];
        const greeting=settings.personalized_greeting && customer.full_name
          ? settings.greeting_template.replaceAll("{{name}}",customer.full_name) : null;
        return res.status(200).json({ok:true,found:true,personalization_allowed:true,customer_name:customer.full_name,greeting,memories});
      }
      if (action==="consent" || action==="remember") {
        if (!isAgent) return res.status(403).json({ok:false,error:"agent_access_required"});
        const [settings]=await sql`SELECT enabled,save_call_summaries,save_preferences FROM aloha_memory_settings WHERE id=1`;
        if (!settings?.enabled) return res.status(409).json({ok:false,error:"customer_memory_disabled"});
        const [existing]=await sql`SELECT id,consent_at FROM aloha_customers WHERE phone_e164=${phone} LIMIT 1`;
        if (!existing?.consent_at && body.consent !== true) return res.status(409).json({ok:false,error:"explicit_customer_consent_required"});
        const name=clean(body.full_name,180);
        const [customer]=await sql`INSERT INTO aloha_customers (id,phone_e164,full_name,consent_at,consent_source,memory_enabled,updated_at)
          VALUES (${randomUUID()},${phone},${name||null},NOW(),'voice_consent',TRUE,NOW())
          ON CONFLICT (phone_e164) DO UPDATE SET
            full_name=COALESCE(NULLIF(EXCLUDED.full_name,''),aloha_customers.full_name),
            consent_at=COALESCE(aloha_customers.consent_at,NOW()),
            consent_source=COALESCE(aloha_customers.consent_source,'voice_consent'),
            memory_enabled=TRUE,updated_at=NOW()
          RETURNING id,phone_e164,full_name,consent_at,memory_enabled`;
        if (action==="remember") {
          const summary=clean(body.summary,8000);
          if (summary) await sql`INSERT INTO aloha_customer_memories (customer_id,call_job_id,summary,intent,preferences,order_notes,follow_up)
            VALUES (${customer.id},${clean(body.call_job_id,180)||null},${summary},${clean(body.intent,500)||null},
              ${JSON.stringify(settings.save_preferences ? (body.preferences||{}) : {})}::jsonb,
              ${JSON.stringify(body.order_notes||[])}::jsonb,${clean(body.follow_up,1200)||null})`;
        }
        return res.status(200).json({ok:true,customer,saved:action==="remember"});
      }
      return res.status(400).json({ok:false,error:"invalid_action"});
    }

    if (req.method==="PATCH") {
      if (body.type==="settings") {
        const [settings]=await sql`UPDATE aloha_memory_settings SET
          enabled=${body.enabled===true}, personalized_greeting=${body.personalized_greeting!==false},
          save_call_summaries=${body.save_call_summaries!==false}, save_preferences=${body.save_preferences!==false},
          retention_days=${Math.max(30,Math.min(3650,Number(body.retention_days)||365))},
          greeting_template=${clean(body.greeting_template,500)||"Merhaba {{name}}, tekrar hoş geldiniz. Size nasıl yardımcı olabilirim."}
          WHERE id=1 RETURNING *`;
        return res.status(200).json({ok:true,settings});
      }
      const id=clean(body.customer_id,80);
      if (!id) return res.status(400).json({ok:false,error:"customer_id_required"});
      const [customer]=await sql`UPDATE aloha_customers SET
        full_name=${clean(body.full_name,180)||null},
        memory_enabled=${body.memory_enabled!==false},
        consent_at=CASE WHEN ${body.revoke_consent===true} THEN NULL ELSE consent_at END,
        consent_source=CASE WHEN ${body.revoke_consent===true} THEN NULL ELSE consent_source END,
        updated_at=NOW() WHERE id=${id}
        RETURNING id,phone_e164,full_name,consent_at,memory_enabled,updated_at`;
      if (!customer) return res.status(404).json({ok:false,error:"customer_not_found"});
      if (body.revoke_consent===true) await sql`DELETE FROM aloha_customer_memories WHERE customer_id=${id}`;
      return res.status(200).json({ok:true,customer});
    }

    const id=clean(req.query?.customer_id || body.customer_id,80);
    if (!id) return res.status(400).json({ok:false,error:"customer_id_required"});
    await sql`DELETE FROM aloha_customers WHERE id=${id}`;
    return res.status(200).json({ok:true,deleted:true});
  } catch(error) {
    console.error("aloha_customer_memory_error",{message:error?.message||String(error)});
    return res.status(500).json({ok:false,error:"customer_memory_error"});
  }
}
