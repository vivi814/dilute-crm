require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const { inv, orders, returns, events, itemsDb, configDb, imagesDb } = require('./db');
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
// Serve frontend HTML from /public
app.use(express.static(path.join(__dirname, 'public')));
// Serve Dilute Studio app
app.get('/dilute-studio', (_, res) => res.sendFile(path.join(__dirname, 'dilute-studio.html')));
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

// PUT update item
app.put('/api/items/:id', (req, res) => {
  try {
    const item = { ...req.body, id: parseInt(req.params.id) };
    itemsDb.upsert(item);
    broadcast('item_update', { item, action: 'upsert' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE item
app.delete('/api/items/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    itemsDb.delete(id);
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

// ── Image Storage API ─────────────────────────────────────────

// POST /api/img  — upload image, returns { hash, url }
app.post('/api/img', (req, res) => {
  try {
    const { data } = req.body; // data = "data:image/jpeg;base64,..."
    if (!data) return res.status(400).json({ error: 'no data' });
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'invalid format' });
    const mime = matches[1];
    const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 20);
    imagesDb.set(hash, mime, data);
    res.json({ ok: true, hash, url: `/api/img/${hash}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/img/:hash — serve image
app.get('/api/img/:hash', (req, res) => {
  try {
    const row = imagesDb.get(req.params.hash);
    if (!row) return res.status(404).send('Not found');
    const matches = row.data.match(/^data:[^;]+;base64,(.+)$/);
    if (!matches) return res.status(400).send('Bad data');
    const buf = Buffer.from(matches[1], 'base64');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch(e) { res.status(500).send(e.message); }
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
