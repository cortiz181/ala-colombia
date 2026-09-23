import express from 'express';
import pg from 'pg';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

const { Pool } = pg;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'change-me';
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin';
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
async function db(q, params=[]) { if (!pool) throw new Error('DATABASE_URL is not configured'); return pool.query(q, params); }

async function initDb(){
  if(!pool) return;
  await db(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS orders (
    id bigserial PRIMARY KEY, phone text NOT NULL, customer_name text, usd_amount numeric(14,2),
    market_rate numeric(18,6), margin_pct numeric(8,4), customer_rate numeric(18,6), ves_amount numeric(20,2),
    recipient_name text, bank_name text, recipient_phone text, cedula text,
    status text NOT NULL DEFAULT 'draft', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS conversations (phone text PRIMARY KEY, state text NOT NULL DEFAULT 'idle', order_id bigint, updated_at timestamptz DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS bank_items (item_id text PRIMARY KEY, access_token text NOT NULL, cursor text, created_at timestamptz DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS bank_transactions (
    transaction_id text PRIMARY KEY, item_id text, account_id text, amount numeric(14,2), name text,
    merchant_name text, pending boolean, date date, raw jsonb, created_at timestamptz DEFAULT now()
  )`);
  await db(`INSERT INTO settings(key,value) VALUES('market_rate','980') ON CONFLICT (key) DO NOTHING`);
  await db(`INSERT INTO settings(key,value) VALUES('zelle_instructions','Send Zelle to your configured business recipient.') ON CONFLICT (key) DO NOTHING`);
}

function marginFor(amount){ if(amount < 100) return 4.5; if(amount < 500) return 3.5; if(amount < 1500) return 2.75; return 2.25; }
async function getSetting(key, fallback=''){ if(!pool) return fallback; const r = await db('SELECT value FROM settings WHERE key=$1',[key]); return r.rows[0]?.value ?? fallback; }
async function quote(amount){ const market = Number(await getSetting('market_rate','980')); const margin = marginFor(amount); const customerRate = market*(1-margin/100); return {market,margin,customerRate,ves:amount*customerRate}; }

async function sendWhatsApp(to, body){
  if(!WA_TOKEN || !WA_PHONE_ID){ console.log(`[WA DRY RUN] -> ${to}: ${body}`); return; }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}/messages`;
  const r = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${WA_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body}})});
  if(!r.ok) throw new Error(`WhatsApp send failed ${r.status}: ${await r.text()}`);
}

async function getConversation(phone){
  const r=await db(`INSERT INTO conversations(phone,state) VALUES($1,'idle') ON CONFLICT(phone) DO UPDATE SET updated_at=now() RETURNING *`,[phone]);
  return r.rows[0];
}
async function setConversation(phone,state,orderId=null){ await db(`INSERT INTO conversations(phone,state,order_id) VALUES($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET state=$2,order_id=$3,updated_at=now()`,[phone,state,orderId]); }

async function handleCustomerMessage(phone,text){
  const msg=text.trim(), c=await getConversation(phone);
  if(/^reset$/i.test(msg)){ await setConversation(phone,'idle',null); return sendWhatsApp(phone,'Conversation reset. Send the USD amount you want to exchange.'); }
  if(c.state==='idle'){
    const amount=Number(msg.replace(/[$,\s]/g,''));
    if(!Number.isFinite(amount)||amount<=0) return sendWhatsApp(phone,'Welcome. Send the USD amount you want to exchange, for example: 500');
    const q=await quote(amount);
    const r=await db(`INSERT INTO orders(phone,usd_amount,market_rate,margin_pct,customer_rate,ves_amount,status) VALUES($1,$2,$3,$4,$5,$6,'collecting_recipient') RETURNING id`,[phone,amount,q.market,q.margin,q.customerRate,q.ves]);
    const id=r.rows[0].id; await setConversation(phone,'recipient_name',id);
    return sendWhatsApp(phone,`Order #${id}\nUSD: $${amount.toFixed(2)}\nRate: ${q.customerRate.toFixed(2)} VES/USD\nRecipient receives: ${q.ves.toLocaleString('en-US',{maximumFractionDigits:2})} VES\n\nReply with the recipient's full name.`);
  }
  const id=c.order_id;
  if(c.state==='recipient_name'){ await db('UPDATE orders SET recipient_name=$1,updated_at=now() WHERE id=$2',[msg,id]); await setConversation(phone,'bank_name',id); return sendWhatsApp(phone,'Venezuelan bank name?'); }
  if(c.state==='bank_name'){ await db('UPDATE orders SET bank_name=$1,updated_at=now() WHERE id=$2',[msg,id]); await setConversation(phone,'recipient_phone',id); return sendWhatsApp(phone,'Recipient phone number?'); }
  if(c.state==='recipient_phone'){ await db('UPDATE orders SET recipient_phone=$1,updated_at=now() WHERE id=$2',[msg,id]); await setConversation(phone,'cedula',id); return sendWhatsApp(phone,'Recipient cédula/RIF?'); }
  if(c.state==='cedula'){
    await db(`UPDATE orders SET cedula=$1,status='waiting_payment',updated_at=now() WHERE id=$2`,[msg,id]); await setConversation(phone,'idle',null);
    const o=(await db('SELECT * FROM orders WHERE id=$1',[id])).rows[0], zi=await getSetting('zelle_instructions');
    return sendWhatsApp(phone,`Order #${id} created.\nAmount: $${Number(o.usd_amount).toFixed(2)}\nPayout: ${Number(o.ves_amount).toLocaleString()} VES\n\n${zi}\n\nAfter the bank feed detects a matching deposit, the order will be flagged for review before payout.`);
  }
}

app.get('/health',(_q,res)=>res.json({ok:true}));
app.get('/webhooks/whatsapp',(req,res)=>{
  if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhooks/whatsapp',async(req,res)=>{
  res.sendStatus(200);
  try{ const m=req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]; if(m?.type==='text') await handleCustomerMessage(m.from,m.text.body); }catch(e){ console.error(e); }
});

function adminOk(req){ return req.query.key===ADMIN_KEY||req.headers['x-admin-key']===ADMIN_KEY; }
app.get('/api/orders',async(req,res)=>{ if(!adminOk(req)) return res.sendStatus(401); const r=await db('SELECT * FROM orders ORDER BY id DESC LIMIT 100'); res.json(r.rows); });
app.post('/api/orders/:id/status',async(req,res)=>{
  if(!adminOk(req)) return res.sendStatus(401);
  const allowed=['waiting_payment','payment_detected','ready_for_payout','completed','hold','cancelled'];
  if(!allowed.includes(req.body.status)) return res.status(400).json({error:'invalid status'});
  const r=await db('UPDATE orders SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[req.body.status,req.params.id]); res.json(r.rows[0]);
});
app.post('/api/settings',async(req,res)=>{ if(!adminOk(req)) return res.sendStatus(401); for(const [k,v] of Object.entries(req.body||{})) await db('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()',[k,String(v)]); res.json({ok:true}); });

const plaidConfigured=!!(process.env.PLAID_CLIENT_ID&&process.env.PLAID_SECRET);
let plaidClient=null;
if(plaidConfigured){
  const env=process.env.PLAID_ENV==='production'?PlaidEnvironments.production:PlaidEnvironments.sandbox;
  plaidClient=new PlaidApi(new Configuration({basePath:env,baseOptions:{headers:{'PLAID-CLIENT-ID':process.env.PLAID_CLIENT_ID,'PLAID-SECRET':process.env.PLAID_SECRET}}}));
}
app.post('/api/plaid/link-token',async(req,res)=>{
  if(!adminOk(req)) return res.sendStatus(401);
  if(!plaidClient) return res.status(503).json({error:'Plaid not configured'});
  const r=await plaidClient.linkTokenCreate({user:{client_user_id:'business-owner'},client_name:'VES Exchange Bot',products:[Products.Transactions],country_codes:[CountryCode.Us],language:'en',webhook:`${BASE_URL}/webhooks/plaid`});
  res.json({link_token:r.data.link_token});
});
app.post('/api/plaid/exchange-token',async(req,res)=>{
  if(!adminOk(req)) return res.sendStatus(401);
  const r=await plaidClient.itemPublicTokenExchange({public_token:req.body.public_token});
  await db('INSERT INTO bank_items(item_id,access_token,cursor) VALUES($1,$2,NULL) ON CONFLICT(item_id) DO UPDATE SET access_token=$2',[r.data.item_id,r.data.access_token]);
  await syncItem(r.data.item_id); res.json({ok:true,item_id:r.data.item_id});
});

async function syncItem(itemId){
  if(!plaidClient) return;
  const row=(await db('SELECT * FROM bank_items WHERE item_id=$1',[itemId])).rows[0]; if(!row) return;
  let cursor=row.cursor||undefined, hasMore=true;
  while(hasMore){
    const r=await plaidClient.transactionsSync({access_token:row.access_token,cursor});
    for(const t of r.data.added){
      await db(`INSERT INTO bank_transactions(transaction_id,item_id,account_id,amount,name,merchant_name,pending,date,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(transaction_id) DO UPDATE SET amount=$4,name=$5,merchant_name=$6,pending=$7,date=$8,raw=$9`,[t.transaction_id,itemId,t.account_id,t.amount,t.name,t.merchant_name,t.pending,t.date,JSON.stringify(t)]);
      const incoming=Number(t.amount)<0?Math.abs(Number(t.amount)):0;
      if(incoming>0&&!t.pending){
        const match=(await db(`SELECT * FROM orders WHERE status='waiting_payment' AND abs(usd_amount-$1)<0.01 ORDER BY created_at ASC LIMIT 1`,[incoming])).rows[0];
        if(match){ await db(`UPDATE orders SET status='payment_detected',updated_at=now() WHERE id=$1`,[match.id]); await sendWhatsApp(match.phone,`✅ Payment detected for Order #${match.id}.\n$${incoming.toFixed(2)} was found in the connected bank feed.\n\nYour payout is pending administrator review.`); }
      }
    }
    for(const t of r.data.modified) await db(`UPDATE bank_transactions SET amount=$1,name=$2,merchant_name=$3,pending=$4,date=$5,raw=$6 WHERE transaction_id=$7`,[t.amount,t.name,t.merchant_name,t.pending,t.date,JSON.stringify(t),t.transaction_id]);
    for(const t of r.data.removed) await db('DELETE FROM bank_transactions WHERE transaction_id=$1',[t.transaction_id]);
    cursor=r.data.next_cursor; hasMore=r.data.has_more; await db('UPDATE bank_items SET cursor=$1 WHERE item_id=$2',[cursor,itemId]);
  }
}
app.post('/webhooks/plaid',async(req,res)=>{ res.sendStatus(200); try{ if(req.body?.webhook_code==='SYNC_UPDATES_AVAILABLE'&&req.body?.item_id) await syncItem(req.body.item_id); }catch(e){ console.error(e); } });
app.get('/admin',(req,res)=>res.sendFile(process.cwd()+'/public/admin.html'));

await initDb();
app.listen(PORT,()=>console.log(`VES bot listening on ${PORT}`));