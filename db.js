/**
 * Simple JSON file-based storage — no native compilation needed
 * Works on Railway / any Node.js environment
 */
const fs   = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function filePath(name){ return path.join(DATA_DIR, `${name}.json`); }
function readJson(name, fallback={}){
  try { return JSON.parse(fs.readFileSync(filePath(name),'utf8')); }
  catch { return fallback; }
}
function writeJson(name, data){
  fs.writeFileSync(filePath(name), JSON.stringify(data), 'utf8');
}

// ── Items ─────────────────────────────────────────────────────
const itemsDb = {
  getAll(){ return Object.values(readJson('items',{})); },
  upsert(item){ const d=readJson('items',{}); d[item.id]=item; writeJson('items',d); },
  delete(id){ const d=readJson('items',{}); delete d[id]; writeJson('items',d); },
  nextId(){ const ids=Object.keys(readJson('items',{})).map(Number); return ids.length?Math.max(...ids)+1:1; },
};

// ── Config (CATS, SEASONS, sampleRecords …) ───────────────────
const configDb = {
  get(key){ return readJson('config',{})[key]??null; },
  set(key,value){ const d=readJson('config',{}); d[key]=value; writeJson('config',d); },
  getAll(){ return readJson('config',{}); },
};

// ── Images ────────────────────────────────────────────────────
const imagesDb = {
  get(hash){ return readJson('images',{})[hash]||null; },
  set(hash,mime,data){ const d=readJson('images',{}); d[hash]={mime,data}; writeJson('images',d); },
};

// ── Inventory / Orders / Returns (legacy stubs) ───────────────
const inv = {
  getAll(){ return readJson('inventory',[]); },
  upsert(rows){ writeJson('inventory',rows); },
  updateQuantity(variantId, qty){
    const d=readJson('inventory',[]);
    const row=d.find(r=>r.variant_id===String(variantId));
    if(row) row.quantity=qty;
    writeJson('inventory',d);
  },
  adjustFromOrder(lineItems, direction){
    const d=readJson('inventory',[]);
    lineItems.forEach(item=>{
      const row=d.find(r=>r.variant_id===String(item.variant_id));
      if(row) row.quantity=Math.max(0,(row.quantity||0)+direction*item.quantity);
    });
    writeJson('inventory',d);
  },
};
const orders = {
  getAll(limit=100){ const d=readJson('orders',[]); return d.slice(0,limit); },
  getByStatus(status){ return readJson('orders',[]).filter(o=>o.status===status); },
  upsert(order){
    const d=readJson('orders',[]);
    const i=d.findIndex(o=>o.sl_order_id===order.sl_order_id);
    if(i>=0) d[i]=order; else d.unshift(order);
    writeJson('orders',d);
  },
  stats(){
    const d=readJson('orders',[]);
    const today=new Date().toISOString().slice(0,10);
    return {
      total:d.length, pending:d.filter(o=>o.status==='pending').length,
      today_orders:d.filter(o=>(o.created_at||'').startsWith(today)).length,
      today_revenue:d.filter(o=>(o.created_at||'').startsWith(today)).reduce((a,o)=>a+(o.total_price||0),0),
    };
  },
};
const returns = {
  getAll(limit=100){ return readJson('returns',[]).slice(0,limit); },
  upsert(ret){
    const d=readJson('returns',[]);
    const i=d.findIndex(r=>r.sl_refund_id===ret.sl_refund_id);
    if(i>=0) d[i]=ret; else d.unshift(ret);
    writeJson('returns',d);
  },
  stats(){
    const d=readJson('returns',[]);
    const today=new Date().toISOString().slice(0,10);
    return { total:d.length, today_count:d.filter(r=>(r.created_at||'').startsWith(today)).length };
  },
};
const events = {
  log(type,payload){
    const d=readJson('events',[]);
    d.unshift({type,payload,created_at:new Date().toISOString()});
    writeJson('events',d.slice(0,200));
  },
  recent(limit=50){ return readJson('events',[]).slice(0,limit); },
};

module.exports = { inv, orders, returns, events, itemsDb, configDb, imagesDb };
