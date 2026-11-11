import { neon } from "@neondatabase/serverless";
import { timingSafeEqual, randomUUID } from "node:crypto";
function validKey(req) {
  const expected=(process.env.ALOHA_PANEL_KEY||"").trim(), supplied=String(req.headers["x-panel-key"]||"").trim();
  if(!expected||!supplied)return false;const a=Buffer.from(expected),b=Buffer.from(supplied);
  return a.length===b.length&&timingSafeEqual(a,b);
}
const allowed=new Set(["pending","confirmed","preparing","completed","cancelled"]);
const clean=(v,max=1000)=>String(v??"").trim().slice(0,max);
export default async function handler(req,res){
  if(!["GET","POST","PATCH","OPTIONS"].includes(req.method)){res.setHeader("Allow","GET, POST, PATCH, OPTIONS");return res.status(405).json({ok:false,error:"method_not_allowed"});}
  if(req.method==="OPTIONS"){res.setHeader("Allow","GET, POST, PATCH, OPTIONS");return res.status(204).end();}
  if(!validKey(req))return res.status(401).json({ok:false,error:"unauthorized"});
  try{
    const sql=neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS aloha_orders(
      id TEXT PRIMARY KEY, order_number TEXT UNIQUE NOT NULL, call_job_id TEXT,
      customer_name TEXT NOT NULL, phone TEXT, product TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      address TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    if(req.method==="GET"){
      const orders=await sql`SELECT id,order_number,call_job_id,customer_name,phone,product,quantity,address,notes,status,created_at,updated_at FROM aloha_orders ORDER BY created_at DESC LIMIT 200`;
      return res.status(200).json({ok:true,orders});
    }
    const body=typeof req.body==="string"?JSON.parse(req.body):req.body||{};
    if(req.method==="POST"){
      const customer=clean(body.customer_name,140),product=clean(body.product,180),quantity=Math.max(1,Math.min(10000,parseInt(body.quantity,10)||1));
      if(!customer||!product)return res.status(400).json({ok:false,error:"customer_and_product_required"});
      const id=randomUUID(), orderNumber="AL-"+new Date().toISOString().slice(0,10).replace(/-/g,"")+"-"+id.slice(0,6).toUpperCase();
      const [order]=await sql`INSERT INTO aloha_orders(id,order_number,call_job_id,customer_name,phone,product,quantity,address,notes,status)
      VALUES(${id},${orderNumber},${clean(body.call_job_id,160)||null},${customer},${clean(body.phone,50)||null},${product},${quantity},${clean(body.address,500)||null},${clean(body.notes,3000)||null},'pending')
      RETURNING id,order_number,call_job_id,customer_name,phone,product,quantity,address,notes,status,created_at,updated_at`;
      return res.status(201).json({ok:true,order});
    }
    const id=clean(body.id,80),status=clean(body.status,30);
    if(!id||!allowed.has(status))return res.status(400).json({ok:false,error:"invalid_order_update"});
    const [order]=await sql`UPDATE aloha_orders SET status=${status},updated_at=NOW() WHERE id=${id} RETURNING id,order_number,status,updated_at`;
    if(!order)return res.status(404).json({ok:false,error:"order_not_found"});
    return res.status(200).json({ok:true,order});
  }catch(error){console.error("aloha_orders_error",{message:error?.message||String(error)});return res.status(500).json({ok:false,error:"orders_database_error"});}
}