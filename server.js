require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const { inv, orders, returns, events, itemsDb, configDb, imagesDb, returnFormsDb } = require('./db');
const sl = require('./shopline');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT             = process.env.PORT || 3001;
const SL_DOMAIN        = process.env.SL_DOMAIN || '';
const SL_TOKEN         = process.env.SL_TOKEN  || '';
const SL_WEBHOOK_SECRET= process.env.SL_WEBHOOK_SECRET || '';
const FRONTEND_ORIGIN  = process.env.FRONTEND_ORIGIN || '*';

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_ORIGIN }));
// Explicit HTML routes (before static middleware)
const noCache = (_, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};
app.get('/dilute-studio', noCache, (_, res) => res.sendFile(path.join(__dirname, 'dilute-studio.html')));
app.get('/return-form', noCache, (_, res) => res.sendFile(path.join(__dirname, 'public', 'return-form.html')));
app.get('/project-mgmt', noCache, (_, res) => res.sendFile(path.join(__dirname, 'project-mgmt.html')));
app.get('/pm-sw.js', (_, res) => res.sendFile(path.join(__dirname, 'pm-sw.js')));
app.get('/pm-manifest.json', (_, res) => res.sendFile(path.join(__dirname, 'pm-manifest.json')));
app.get('/dilute-sw.js', (_, res) => res.sendFile(path.join(__dirname, 'dilute-sw.js')));
app.get('/dilute-manifest.json', (_, res) => res.sendFile(path.join(__dirname, 'dilute-manifest.json')));
// Serve frontend HTML from /public
app.use(express.static(path.join(__dirname, 'public')));
// Raw body for webhook signature verification
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── WebSocket broadcast ───────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // Send latest snapshot on connect
  ws.send(JSON.stringify({
    type: 'snapshot',
    payload: {
      inventory: inv.getAll(),
      orders:    orders.getAll(50),
      returns:   returns.getAll(50),
      stats:     { orders: orders.stats(), returns: returns.stats() },
      items:     itemsDb.getAll(),
      config:    configDb.getAll(),
    },
    ts: new Date().toISOString(),
  }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ── Helper: verify ShopLine webhook signature ─────────────────
function verifyWebhook(rawBody, signature) {
  if (!SL_WEBHOOK_SECRET || !signature) return true; // skip if not configured
  const hmac = crypto.createHmac('sha256', SL_WEBHOOK_SECRET)
    .update(rawBody).digest('base64');
  return hmac === signature;
}

// ── WEBHOOK endpoint ──────────────────────────────────────────
app.post('/webhook/shopline', async (req, res) => {
  const sig   = req.headers['x-shopline-hmac-sha256'];
  const topic = req.headers['x-shopline-topic'] || '';

  if (!verifyWebhook(req.body, sig)) {
    console.warn('[Webhook] Invalid signature');
    return res.status(401).send('Unauthorized');
  }

  let data;
  try { data = JSON.parse(req.body.toString()); }
  catch(e) { return res.status(400).send('Bad JSON'); }

  res.status(200).send('OK'); // respond immediately
  events.log(topic, data);
  console.log(`[Webhook] ${topic}`);

  try {
    // ── Order created / updated ───────────────────────────────
    if (topic === 'orders/create' || topic === 'orders/update') {
      const order = sl.normalizeOrder(data);
      orders.upsert(order);
      // Deduct inventory for new orders
      if (topic === 'orders/create') {
        inv.adjustFromOrder(data.line_items || [], -1);
      }
      broadcast('order_update', {
        order,
        stats: orders.stats(),
        inventory: inv.getAll(),
      });
    }

    // ── Order cancelled ───────────────────────────────────────
    else if (topic === 'orders/cancel') {
      const order = sl.normalizeOrder({ ...data, status: 'cancelled' });
      orders.upsert(order);
      // Restore inventory
      inv.adjustFromOrder(data.line_items || [], +1);
      broadcast('order_update', {
        order,
        stats: orders.stats(),
        inventory: inv.getAll(),
      });
    }

    // ── Refund / return ───────────────────────────────────────
    else if (topic === 'refunds/create') {
      const ret = sl.normalizeRefund(data, data.order_id, data.order_number);
      returns.upsert(ret);
      // Restore inventory for returned items
      const returnedItems = (data.refund_line_items || []).map(i => ({
        variant_id: i.line_item?.variant_id,
        quantity: i.quantity,
      })).filter(i => i.variant_id);
      inv.adjustFromOrder(returnedItems, +1);
      broadcast('return_update', {
        ret,
        stats: returns.stats(),
        inventory: inv.getAll(),
      });
    }

    // ── Inventory level update ────────────────────────────────
    else if (topic === 'inventory_levels/update') {
      const { inventory_item_id, available } = data;
      if (inventory_item_id) {
        inv.updateQuantity(String(inventory_item_id), available);
        broadcast('inventory_update', { inventory: inv.getAll() });
      }
    }

    // ── Product update ────────────────────────────────────────
    else if (topic === 'products/update') {
      broadcast('product_update', { product: data });
    }

  } catch(err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// ── REST API ──────────────────────────────────────────────────

// Health check
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Storage status — 診斷 GitHub 備份是否正常
app.get('/api/storage-status', async (_, res) => {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo } = require('./github-storage');
  if (!token) return res.json({ ok: false, error: 'GITHUB_TOKEN 未設定' });
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/dilute-data.json`, {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'dilute-crm' }
    });
    if (r.status === 200) {
      const j = await r.json();
      return res.json({ ok: true, status: 'file_exists', sha: j.sha, size: j.size });
    } else if (r.status === 404) {
      // 檔案不存在，嘗試建立
      const { saveToGitHub } = require('./github-storage');
      await saveToGitHub({ items:{}, config:{}, returnForms:{} });
      return res.json({ ok: true, status: 'created_new_file' });
    } else {
      return res.json({ ok: false, error: `GitHub API: ${r.status}` });
    }
  } catch(e) {
    return res.json({ ok: false, error: e.message });
  }
});

// Force immediate GitHub save of current in-memory data
app.post('/api/force-github-save', async (_, res) => {
  try {
    const { saveToGitHub } = require('./github-storage');
    const { itemsDb, configDb } = require('./db');
    const items = {};
    itemsDb.getAll().forEach(i => { items[i.id] = i; });
    const config = configDb.getAll();
    await saveToGitHub({ items, config, returnForms: {} });
    res.json({ ok: true, itemCount: Object.keys(items).length });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Dashboard stats
app.get('/api/stats', (_, res) => {
  res.json({
    orders:  orders.stats(),
    returns: returns.stats(),
  });
});

// Inventory
app.get('/api/inventory', (_, res) => res.json(inv.getAll()));

app.put('/api/inventory/:variantId', async (req, res) => {
  const { variantId } = req.params;
  const { quantity } = req.body;
  try {
    if (SL_DOMAIN && SL_TOKEN) {
      await sl.updateInventory(SL_DOMAIN, SL_TOKEN, variantId, quantity);
    }
    inv.updateQuantity(variantId, quantity);
    broadcast('inventory_update', { inventory: inv.getAll() });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Orders
app.get('/api/orders', (req, res) => {
  const { status, limit = 100 } = req.query;
  const data = status ? orders.getByStatus(status) : orders.getAll(Number(limit));
  res.json(data);
});

// Returns
app.get('/api/returns', (req, res) => {
  res.json(returns.getAll(Number(req.query.limit || 100)));
});

// Recent events log
app.get('/api/events', (_, res) => {
  const { events: ev } = require('./db');
  res.json(ev.recent(50));
});

// ── Sync from ShopLine ────────────────────────────────────────
app.post('/api/sync', async (req, res) => {
  const domain = req.body.domain || SL_DOMAIN;
  const token  = req.body.token  || SL_TOKEN;
  if (!domain || !token) return res.status(400).json({ error: 'Missing domain or token' });

  res.json({ ok: true, message: '同步開始，請稍候…' });

  try {
    console.log('[Sync] Starting full sync…');

    // 1. Inventory
    broadcast('sync_progress', { step: 'inventory', message: '同步庫存中…' });
    const invRows = await sl.getInventoryLevels(domain, token);
    inv.upsert(invRows);
    console.log(`[Sync] Inventory: ${invRows.length} variants`);

    // 2. Orders (last 90 days)
    broadcast('sync_progress', { step: 'orders', message: '同步訂單中…' });
    const allOrders = await sl.getAllOrders(domain, token);
    allOrders.forEach(o => orders.upsert(sl.normalizeOrder(o)));
    console.log(`[Sync] Orders: ${allOrders.length}`);

    // 3. Returns (sample from recent orders)
    broadcast('sync_progress', { step: 'returns', message: '同步退貨中…' });
    const recentOrders = allOrders.slice(0, 50);
    for (const o of recentOrders) {
      try {
        const refunds = await sl.getRefundsForOrder(domain, token, o.id);
        refunds.forEach(r => returns.upsert(sl.normalizeRefund(r, o.id, o.order_number)));
      } catch(e) { /* skip orders without refund access */ }
    }

    broadcast('sync_done', {
      inventory: inv.getAll(),
      orders:    orders.getAll(50),
      returns:   returns.getAll(50),
      stats:     { orders: orders.stats(), returns: returns.stats() },
      message:   '✅ 同步完成',
    });
    console.log('[Sync] Done');

  } catch(err) {
    console.error('[Sync] Error:', err.message);
    broadcast('sync_error', { message: err.message });
  }
});

// ── ShopLine API proxy (test connection) ──────────────────────
app.post('/api/shopline/test', async (req, res) => {
  const { domain, token } = req.body;
  try {
    const info = await sl.getShopInfo(domain, token);
    res.json({ ok: true, shop: info.data || info });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PRODUCT DATA API
// ══════════════════════════════════════════════════════════════

// GET all items
app.get('/api/items', (req, res) => {
  try { res.json(itemsDb.getAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create item
app.post('/api/items', (req, res) => {
  try {
    const item = req.body;
    if(!item.id) item.id = itemsDb.nextId();
    itemsDb.upsert(item);
    broadcast('item_update', { item, action: 'upsert' });
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update item — await GitHub save before responding
app.put('/api/items/:id', async (req, res) => {
  try {
    const item = { ...req.body, id: parseInt(req.params.id) };
    await itemsDb.upsertNow(item);
    broadcast('item_update', { item, action: 'upsert' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE item — await GitHub save before responding
app.delete('/api/items/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await itemsDb.deleteNow(id);
    broadcast('item_update', { id, action: 'delete' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET config (CATS, SEASONS, skuColors, etc.)
app.get('/api/config', (req, res) => {
  try { res.json(configDb.getAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT config key
app.put('/api/config/:key', (req, res) => {
  try {
    const { key } = req.params;
    configDb.set(key, req.body.value);
    broadcast('config_update', { key, value: req.body.value });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST config bulk (save all at once)
app.post('/api/config', (req, res) => {
  try {
    const cfg = req.body;
    Object.entries(cfg).forEach(([k, v]) => configDb.set(k, v));
    broadcast('config_update', cfg);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ShopLine Excel Export ─────────────────────────────────────
// 欄位對照（0-indexed）依據 ootdcloset 店家專屬模板（66欄）
// 工作表: 'Bulk Import Products'，資料從第3行開始
const SL_COL = {
  handle: 0,       // Product Handle*
  nameEn: 1,       // Product Name(English)*
  nameZh: 2,       // Product Name(Chinese)*
  summaryEn: 3,    // Product Summary(English)
  summaryZh: 4,    // Product Summary(Chinese)
  descEn: 5,       // Product Description(English)
  descZh: 6,       // Product Description(Chinese)
  status: 17,      // Online Store Status
  img: 19,         // Max.12 images*
  catEn: 21,       // Online Store Categories(English)
  catZh: 22,       // Online Store Categories(Chinese)
  price: 25,       // Price
  sku: 29,         // SKU
  qty: 36,         // Quantity
  tag: 39,         // Product Tag
  specAEn: 43,     // Specification Name A(English)
  specAZh: 44,     // Specification Name A(Chinese)
  specBEn: 45,     // Specification Name B(English)
  specBZh: 46,     // Specification Name B(Chinese)
  varAEn: 48,      // Variation name A(English)
  varAZh: 49,      // Variation name A(Chinese)
  varBEn: 50,      // Variation name B(English)
  varBZh: 51,      // Variation name B(Chinese)
  varQty: 52,      // Variation quantity
  varPrice: 53,    // Variation price
  varSku: 63,      // Variation SKU
};

// 依需求：商品描述的內容整段搬到商品摘要（描述欄位留空）。
// ShopLine「商品摘要」上限300字元，超過會被截斷。
function summaryFrom(desc) {
  return (desc || '').slice(0, 300);
}

app.post('/api/shopline-export', (req, res) => {
  try {
    const XLSX = require('xlsx');
    const templatePath = path.join(__dirname, 'shopline_template.xls');
    const wb = XLSX.readFile(templatePath);
    const ws = wb.Sheets['Bulk Import Products'];

    // 清除 row 3 以後的資料（index 2+），保留第1、2行表頭
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 2; r <= range.e.r; r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) delete ws[addr];
      }
    }

    const { handle, nameZh, nameEn, descZh, descEn, catZh, tags, price, imgUrl, webStatus, variantRows, itemId } = req.body;
    // ShopLine 用「商品編號」欄位判斷是新增還是更新同一件商品——同一個編號會被當成同一件商品覆蓋。
    // 用商品在系統裡本來就唯一的 id 當編號，確保每個商品匯出都不會互相覆蓋。
    const slHandle = itemId || 1;

    function emptyRow() { return new Array(66).fill(''); }
    const dataRows = [];

    if (!variantRows || !variantRows.length) {
      const row = emptyRow();
      row[SL_COL.handle] = slHandle;
      row[SL_COL.nameZh] = nameZh; row[SL_COL.nameEn] = nameEn;
      row[SL_COL.summaryZh] = summaryFrom(descZh); row[SL_COL.summaryEn] = summaryFrom(descEn);
      row[SL_COL.status] = webStatus || 'Y';
      row[SL_COL.img] = ensureImgExt(imgUrl || '');
      row[SL_COL.catZh] = catZh; row[SL_COL.tag] = tags;
      row[SL_COL.price] = price ? Number(price) : '';
      row[SL_COL.sku] = handle;
      dataRows.push(row);
    } else {
      const hasColor = variantRows.some(r => r.color);
      variantRows.forEach((r, idx) => {
        const isFirst = idx === 0;
        const row = emptyRow();
        row[SL_COL.handle] = slHandle;
        if (isFirst) {
          row[SL_COL.nameZh] = nameZh; row[SL_COL.nameEn] = nameEn;
          row[SL_COL.summaryZh] = summaryFrom(descZh); row[SL_COL.summaryEn] = summaryFrom(descEn);
          row[SL_COL.status] = webStatus || 'Y';
          row[SL_COL.img] = ensureImgExt(imgUrl || '');
          row[SL_COL.catZh] = catZh; row[SL_COL.tag] = tags;
          row[SL_COL.specAZh] = hasColor ? '顏色' : '尺寸';
          row[SL_COL.specAEn] = hasColor ? 'Color' : 'Size';
          row[SL_COL.specBZh] = hasColor ? '尺寸' : '';
          row[SL_COL.specBEn] = hasColor ? 'Size' : '';
        }
        row[SL_COL.varAZh] = hasColor ? r.color : r.size;
        row[SL_COL.varAEn] = hasColor ? r.color : r.size; // 英文選項名稱（必填）
        row[SL_COL.varBZh] = hasColor ? r.size : '';
        row[SL_COL.varBEn] = hasColor ? r.size : '';      // 英文選項名稱B（必填）
        row[SL_COL.varQty] = r.qty !== undefined ? Number(r.qty) : '';
        row[SL_COL.varPrice] = r.price !== undefined ? Number(r.price) : '';
        row[SL_COL.varSku] = r.sku || '';
        dataRows.push(row);
      });
    }

    XLSX.utils.sheet_add_aoa(ws, dataRows, { origin: 'A3' });

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
    const filename = `shopline_${handle}_${new Date().toISOString().slice(0,10)}.xls`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Image Storage API ─────────────────────────────────────────

// ShopLine（以及其他不少匯入系統）驗證圖片連結時只看副檔名，不會真的抓網址內容，
// 所以圖片網址一定要帶副檔名，不能只是 /api/img/HASH。
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function extForMime(mime) { return MIME_EXT[mime] || 'jpg'; }

// 補上舊圖片網址(上傳於此修正之前，沒有副檔名)的副檔名，讓ShopLine匯出一律附帶副檔名
// 主圖欄位可能是多張圖片網址用空格連接（ShopLine多圖格式），逐一補上
function ensureImgExt(urlOrList) {
  return (urlOrList || '').split(/\s+/).filter(Boolean).map(url => {
    const m = url.match(/\/api\/img\/([a-f0-9]+)$/);
    if (!m) return url;
    const row = imagesDb.get(m[1]);
    if (!row) return url;
    return `${url}.${extForMime(row.mime)}`;
  }).join(' ');
}

// POST /api/img  — upload image, returns { hash, url }
app.post('/api/img', async (req, res) => {
  try {
    const { data } = req.body; // data = "data:image/jpeg;base64,..."
    if (!data) return res.status(400).json({ error: 'no data' });
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'invalid format' });
    const mime = matches[1];
    const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 20);
    // 上傳成功回應前先確保圖片已經同步存進GitHub，避免存檔還沒完成伺服器就重啟導致圖片遺失
    await imagesDb.setNow(hash, mime, data);
    res.json({ ok: true, hash, url: `/api/img/${hash}.${extForMime(mime)}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/img/:hash — serve image（副檔名為選填，僅供外部系統辨識格式用，實際查詢仍用 hash）
app.get('/api/img/:hash', (req, res) => {
  try {
    const hash = req.params.hash.replace(/\.[a-zA-Z0-9]+$/, '');
    const row = imagesDb.get(hash);
    if (!row) return res.status(404).send('Not found');
    const matches = row.data.match(/^data:[^;]+;base64,(.+)$/);
    if (!matches) return res.status(400).send('Bad data');
    const buf = Buffer.from(matches[1], 'base64');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch(e) { res.status(500).send(e.message); }
});

// ── Return Form (public) ──────────────────────────────────────
// POST /api/return-form — customer submits form
app.post('/api/return-form', (req, res) => {
  try {
    const id = returnFormsDb.nextId();
    const form = {
      id,
      submitted_at: new Date().toISOString(),
      // customer fields
      order_date:      req.body.order_date || '',
      order_number:    req.body.order_number || '',
      email:           req.body.email || '',
      order_name:      req.body.order_name || '',
      line_name:       req.body.line_name || '',
      type:            req.body.type || 'return',         // 'return' | 'exchange' | 'defective'
      defective_action: req.body.defective_action || '',  // 'return' | 'exchange' (問題商品時)
      reason:          req.body.reason || '',
      reason_detail:   req.body.reason_detail || '',
      exchange_size:   req.body.exchange_size || '',
      items:           req.body.items || '',
      return_method:   '順豐到付',
      pickup_name:     req.body.pickup_name || '',
      pickup_phone:    req.body.pickup_phone || '',
      pickup_address:  req.body.pickup_address || '',
      bank_code:       req.body.bank_code || '',
      bank_account:    req.body.bank_account || '',
      notes:           req.body.notes || '',
      include_invoice: req.body.include_invoice === 'true' || req.body.include_invoice === true,
      read_policy:     req.body.read_policy === 'true' || req.body.read_policy === true,
      // staff fields (empty on submission)
      sf_tracking:     '',
      sf_staff:        '',
      received_date:   '',
      receiver:        '',
      refund_method:   '',
      notified:        false,
      refund_done:     false,
      refund_amount:   '',
      refund_date:     '',
      status:          'pending',   // pending | processing | completed
    };
    returnFormsDb.upsert(form);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/return-forms — internal list
app.get('/api/return-forms', (_, res) => {
  res.json(returnFormsDb.getAll());
});

// GET /api/return-forms/:id
app.get('/api/return-forms/:id', (req, res) => {
  const form = returnFormsDb.get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'not found' });
  res.json(form);
});

// PUT /api/return-forms/:id — staff updates internal fields
app.put('/api/return-forms/:id', (req, res) => {
  try {
    const form = returnFormsDb.get(Number(req.params.id));
    if (!form) return res.status(404).json({ error: 'not found' });
    const updated = { ...form, ...req.body, id: form.id, submitted_at: form.submitted_at };
    returnFormsDb.upsert(updated);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/return-forms/:id
app.delete('/api/return-forms/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!returnFormsDb.get(id)) return res.status(404).json({ error: 'not found' });
    returnFormsDb.delete(id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   Dilute Studio Backend              ║
║   http://localhost:${PORT}              ║
║   WebSocket: ws://localhost:${PORT}     ║
╚══════════════════════════════════════╝
  `);
});
