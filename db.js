/**
 * JSON-based storage with GitHub persistence.
 * Primary store: in-memory (fast)
 * Backup: local JSON files
 * Persistent: GitHub repo file (survives Railway restarts)
 *
 * Main data (items/config/returnForms) → dilute-data.json
 * Images                               → dilute-images.json (separate, avoids size limits)
 */
const fs   = require('fs');
const path = require('path');
const {
  loadFromGitHub, loadImagesFromGitHub,
  loadFromLocalCache, loadImagesFromLocalCache,
  scheduleSave, scheduleImagesSave,
  saveToGitHub,
} = require('./github-storage');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── In-memory store ───────────────────────────────────────────
let _store = {
  items:       {},
  config:      {},
  images:      {},
  returnForms: {},
  inventory:   [],
  orders:      [],
  returns:     [],
  events:      [],
};

// ── Snapshot helpers ─────────────────────────────────────────
// Main data (no images — kept in separate file)
function getSnapshot() {
  return {
    items:       _store.items,
    config:      _store.config,
    returnForms: _store.returnForms,
  };
}

function getImagesSnapshot() {
  return _store.images;
}

function flushToDisk() {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'store.json'),
      JSON.stringify(getSnapshot()),
      'utf8'
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'images.json'),
      JSON.stringify(getImagesSnapshot()),
      'utf8'
    );
  } catch {}
}

function markDirty() {
  flushToDisk();
  scheduleSave(getSnapshot());
}

function markImagesDirty() {
  flushToDisk();
  scheduleImagesSave(getImagesSnapshot());
}

function loadFromDisk() {
  try {
    const f = path.join(DATA_DIR, 'store.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return null;
}

function loadImagesFromDisk() {
  try {
    const f = path.join(DATA_DIR, 'images.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return null;
}

function applySnapshot(snap) {
  if (!snap) return;
  if (snap.items)       _store.items       = snap.items;
  if (snap.config)      _store.config      = snap.config;
  if (snap.returnForms) _store.returnForms = snap.returnForms;
  // backward compat: old snapshots may have had images bundled in
  if (snap.images && Object.keys(_store.images).length === 0) _store.images = snap.images;
  console.log(`[db] Loaded: ${Object.keys(_store.items).length} items, ${Object.keys(_store.config).length} config keys`);
}

function applyImagesSnapshot(images) {
  if (!images) return;
  _store.images = images;
  console.log(`[db] Loaded: ${Object.keys(_store.images).length} images`);
}

// ── Startup: load from GitHub → local cache → disk ───────────
(async () => {
  // Main data
  const ghData = await loadFromGitHub();
  if (ghData) { applySnapshot(ghData); }
  else {
    const cacheData = loadFromLocalCache();
    if (cacheData) { applySnapshot(cacheData); console.log('[db] Loaded main data from local cache'); }
    else {
      const diskData = loadFromDisk();
      if (diskData) { applySnapshot(diskData); console.log('[db] Loaded main data from disk'); }
      else { console.log('[db] Starting fresh (no main data found)'); }
    }
  }

  // Images (separate load)
  const ghImages = await loadImagesFromGitHub();
  if (ghImages) { applyImagesSnapshot(ghImages); }
  else {
    const cacheImages = loadImagesFromLocalCache();
    if (cacheImages) { applyImagesSnapshot(cacheImages); console.log('[db] Loaded images from local cache'); }
    else {
      const diskImages = loadImagesFromDisk();
      if (diskImages) { applyImagesSnapshot(diskImages); console.log('[db] Loaded images from disk'); }
      else { console.log('[db] No images found, starting fresh'); }
    }
  }
})();

// ── Immediate GitHub save (used by item PUT/DELETE routes) ────
async function saveNow() {
  flushToDisk();
  await saveToGitHub(getSnapshot());
}

// ── Items ─────────────────────────────────────────────────────
const itemsDb = {
  getAll()            { return Object.values(_store.items); },
  upsert(item)        { _store.items[item.id] = item; markDirty(); },
  async upsertNow(item) { _store.items[item.id] = item; await saveNow(); },
  async deleteNow(id)   { delete _store.items[id]; await saveNow(); },
  delete(id)          { delete _store.items[id]; markDirty(); },
  nextId()            {
    const ids = Object.keys(_store.items).map(Number);
    return ids.length ? Math.max(...ids) + 1 : 1;
  },
};

// ── Config ────────────────────────────────────────────────────
const configDb = {
  get(key)        { return _store.config[key] ?? null; },
  set(key, value) { _store.config[key] = value; markDirty(); },
  getAll()        { return { ..._store.config }; },
};

// ── Return Forms ──────────────────────────────────────────────
const returnFormsDb = {
  getAll()      { return Object.values(_store.returnForms).sort((a,b) => b.submitted_at.localeCompare(a.submitted_at)); },
  get(id)       { return _store.returnForms[id] || null; },
  upsert(form)  { _store.returnForms[form.id] = form; markDirty(); },
  delete(id)    { delete _store.returnForms[id]; markDirty(); },
  nextId()      {
    const ids = Object.keys(_store.returnForms).map(Number).filter(n => !isNaN(n));
    return ids.length ? Math.max(...ids) + 1 : 1;
  },
};

// ── Images ────────────────────────────────────────────────────
const imagesDb = {
  get(hash)            { return _store.images[hash] || null; },
  set(hash, mime, data){
    _store.images[hash] = { mime, data };
    markImagesDirty(); // save images to their own file
  },
};

// ── Inventory / Orders / Returns (ShopLine — session only) ────
const inv = {
  getAll()            { return _store.inventory; },
  upsert(rows)        { _store.inventory = rows; },
  updateQuantity(vid, qty) {
    const r = _store.inventory.find(x => x.variant_id === String(vid));
    if (r) r.quantity = qty;
  },
  adjustFromOrder(lineItems, dir) {
    lineItems.forEach(item => {
      const r = _store.inventory.find(x => x.variant_id === String(item.variant_id));
      if (r) r.quantity = Math.max(0, (r.quantity||0) + dir * item.quantity);
    });
  },
};
const orders = {
  getAll(limit=100)  { return _store.orders.slice(0, limit); },
  getByStatus(s)     { return _store.orders.filter(o => o.status === s); },
  upsert(order)      {
    const i = _store.orders.findIndex(o => o.sl_order_id === order.sl_order_id);
    if (i >= 0) _store.orders[i] = order; else _store.orders.unshift(order);
  },
  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const d = _store.orders;
    return {
      total: d.length,
      pending: d.filter(o => o.status === 'pending').length,
      today_orders: d.filter(o => (o.created_at||'').startsWith(today)).length,
      today_revenue: d.filter(o => (o.created_at||'').startsWith(today))
                      .reduce((a, o) => a + (o.total_price||0), 0),
    };
  },
};
const returns = {
  getAll(limit=100) { return _store.returns.slice(0, limit); },
  upsert(ret)       {
    const i = _store.returns.findIndex(r => r.sl_refund_id === ret.sl_refund_id);
    if (i >= 0) _store.returns[i] = ret; else _store.returns.unshift(ret);
  },
  stats() {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: _store.returns.length,
      today_count: _store.returns.filter(r => (r.created_at||'').startsWith(today)).length,
    };
  },
};
const events = {
  log(type, payload) {
    _store.events.unshift({ type, payload, created_at: new Date().toISOString() });
    _store.events = _store.events.slice(0, 200);
  },
  recent(limit=50) { return _store.events.slice(0, limit); },
};

module.exports = { inv, orders, returns, events, itemsDb, configDb, imagesDb, returnFormsDb };
