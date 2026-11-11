import { neon } from "@neondatabase/serverless";
import { timingSafeEqual, randomUUID } from "node:crypto";
function equal(expected, supplied) { if (!expected || !supplied) return false; const a=Buffer.from(String(expected).trim()), b=Buffer.from(String(supplied||"").trim()); return a.length===b.length && timingSafeEqual(a,b); }
const panelAuth=req=>equal(process.env.ALOHA_PANEL_KEY,req.headers["x-panel-key"]);
const agentAuth=req=>equal(process.env.ALOHA_AGENT_API_KEY,req.headers["x-aloha-agent-key"]);
const clean=(v,n=1000)=>String(v??"").trim().slice(0,n);
const allowed=new Set(["pending","confirmed","sent_to_business","preparing","courier_picked_up","on_the_way","delivered","completed","cancelled","rejected"]);
export default async function handler(req,res){
 if(!["GET","POST","PATCH","OPTIONS"].includes(req.method)){res.setHeader("Allow","GET, POST, PATCH, OPTIONS");return res.status(405).json({ok:false,error:"method_not_allowed"});}
 if(req.method==="OPTIONS"){res.setHeader("Allow","GET, POST, PATCH, OPTIONS");return res.status(204).end();}
 const isPanel=panelAuth(req),isAgent=agentAuth(req); if(!isPanel&&!isAgent)return res.status(401).json({ok:false,error:"unauthorized"});
 try{
  const sql=neon(process.env.DATABASE_URL);
  await sql`CREATE TABLE IF NOT EXISTS aloha_orders (id TEXT PRIMARY KEY,order_number TEXT UNIQUE NOT NULL,call_job_id TEXT,customer_name TEXT NOT NULL,phone TEXT,product TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,address TEXT,notes TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS business_name TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS business_phone TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS business_address TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS business_osm_id TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS order_items JSONB`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS price_total NUMERIC(12,2)`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS currency TEXT`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE aloha_orders ADD COLUMN IF NOT EXISTS confirmation_text TEXT`;
  await sql`CREATE TABLE IF NOT EXISTS aloha_order_status_history (id BIGSERIAL PRIMARY KEY,order_id TEXT NOT NULL,old_status TEXT,new_status TEXT NOT NULL,changed_by TEXT NOT NULL DEFAULT 'system',note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  if(req.method==="GET"){if(!isPanel)return res.status(403).json({ok:false,error:"panel_access_required"});const orders=await sql`SELECT * FROM aloha_orders ORDER BY created_at DESC LIMIT 200`;const histories=await sql`SELECT order_id,old_status,new_status,changed_by,note,created_at FROM aloha_order_status_history ORDER BY created_at DESC LIMIT 1000`;return res.status(200).json({ok:true,orders,histories});}
  const body=typeof req.body==="string"?JSON.parse(req.body):req.body||{};
  if(req.method==="POST"){
   if(isAgent&&body.confirmed!==true)return res.status(409).json({ok:false,error:"explicit_customer_confirmation_required"});
   const customer=clean(body.customer_name,140),product=clean(body.product,500),address=clean(body.delivery_address||body.address,700),quantity=Math.max(1,Math.min(10000,parseInt(body.quantity,10)||1));
   if(!customer||!product||!address)return res.status(400).json({ok:false,error:"customer_product_and_full_address_required"});
   const lat=Number(body.latitude),lon=Number(body.longitude);
   if(isAgent&&(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat > 90||lon < -180||lon > 180))return res.status(400).json({ok:false,error:"verified_coordinates_required"});
   const id=randomUUID(),orderNumber="AL-"+new Date().toISOString().slice(0,10).replace(/-/g,"")+"-"+id.slice(0,6).toUpperCase(),status=isAgent?"confirmed":"pending";
   const items=Array.isArray(body.order_items)?JSON.stringify(body.order_items).slice(0,12000):null;
   const price=body.price_total===null||body.price_total===undefined||body.price_total===""?null:Number(body.price_total);
   const [order]=await sql`INSERT INTO aloha_orders (id,order_number,call_job_id,customer_name,phone,product,quantity,address,notes,status,delivery_address,latitude,longitude,business_name,business_phone,business_address,business_osm_id,order_items,price_total,currency,confirmed_at,confirmation_text) VALUES (${id},${orderNumber},${clean(body.call_job_id,160)||null},${customer},${clean(body.phone,50)||null},${product},${quantity},${address},${clean(body.notes,4000)||null},${status},${address},${Number.isFinite(lat)?lat:null},${Number.isFinite(lon)?lon:null},${clean(body.business_name,180)||null},${clean(body.business_phone,60)||null},${clean(body.business_address,500)||null},${clean(body.business_osm_id,100)||null},${items},${Number.isFinite(price)?price:null},${clean(body.currency,8)||null},${isAgent?new Date().toISOString():null},${isAgent?clean(body.confirmation_text,1000)||"Müşteri siparişi açıkça onayladı.":null}) RETURNING *`;
   await sql`INSERT INTO aloha_order_status_history(order_id,old_status,new_status,changed_by,note) VALUES (${id},NULL,${status},${isAgent?"aloha-agent":"panel"},${isAgent?"Müşteri onayıyla oluşturuldu":"Panelden manuel oluşturuldu"})`;
   return res.status(201).json({ok:true,order});
  }
  if(isAgent)return res.status(403).json({ok:false,error:"panel_access_required_for_status_changes"});
  const id=clean(body.id,80),status=clean(body.status,40);if(!id||!allowed.has(status))return res.status(400).json({ok:false,error:"invalid_order_update"});
  const [previous]=await sql`SELECT status FROM aloha_orders WHERE id=${id} LIMIT 1`;if(!previous)return res.status(404).json({ok:false,error:"order_not_found"});
  const [order]=await sql`UPDATE aloha_orders SET status=${status},updated_at=NOW() WHERE id=${id} RETURNING *`;
  if(previous.status!==status)await sql`INSERT INTO aloha_order_status_history(order_id,old_status,new_status,changed_by) VALUES (${id},${previous.status},${status},'panel')`;
  return res.status(200).json({ok:true,order});
 }catch(error){console.error("aloha_orders_error",{message:error?.message||String(error)});return res.status(500).json({ok:false,error:"orders_database_error"});}
}