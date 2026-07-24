/**
 * JSON-based storage with GitHub persistence.
 * Primary store: in-memory (fast)
 * Backup: local JSON files
 * Persistent: GitHub repo file (survives Railway restarts)
 *
 * Main data (items/config/returnForms) → dilute-data.json
 * Images                               → dilute-images.json (separate, avoids size limits)
 * Orders/returns (ShopLine sync)        → dilute-orders.json (separate, own debounce — see markOrdersDirty)
 */
const fs   = require('fs');
const path = require('path');
const {
  loadFromGitHub, loadImagesFromGitHub, loadOrdersFromGitHub,
  loadFromLocalCache, loadImagesFromLocalCache, loadOrdersFromLocalCache,
  scheduleSave, scheduleOrdersSave,
  saveToGitHub, saveOrdersToGitHub,
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
  events:      [],
};

// orders/returns 用 Map（key: sl_order_id / sl_refund_id）取代原本的陣列 findIndex+unshift，
// 資料量隨同步累積到數千筆後，upsert 才不會變成整批同步時的 O(n²)
const _ordersMap  = new Map();
const _returnsMap = new Map();

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

// orders/returns 存成獨立檔案（dilute-orders.json），不跟 items/config/returnForms 混在同一包 —
// 訂單歷史會持續變大，混在一起會讓每次商品編輯的存檔都跟著變慢、更容易撞到 90MB 上限
function getOrdersSnapshot() {
  return {
    orders:  [..._ordersMap.values()],
    returns: [..._returnsMap.values()],
  };
}

function applyOrdersSnapshot(snap) {
  if (!snap) return;
  (snap.orders  || []).forEach(o => _ordersMap.set(o.sl_order_id, o));
  (snap.returns || []).forEach(r => _returnsMap.set(r.sl_refund_id, r));
  console.log(`[db] Loaded: ${_ordersMap.size} orders, ${_returnsMap.size} returns`);
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

function flushOrdersToDisk() {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'orders.json'),
      JSON.stringify(getOrdersSnapshot()),
      'utf8'
    );
  } catch {}
}

// 跟 markDirty() 不同：markOrdersDirty() 在 /api/sync 整批同步時會被連續呼叫上千次
// （每筆訂單一次），本機磁碟寫入也要 debounce，不能像 markDirty() 一樣每次都同步寫檔，
// 否則等於把 Map 化省下來的 O(n) 又原封不動地搬回磁碟 I/O 上
let _ordersDiskTimer = null;
function markOrdersDirty() {
  if (_ordersDiskTimer) clearTimeout(_ordersDiskTimer);
  _ordersDiskTimer = setTimeout(flushOrdersToDisk, 100);
  // 傳函式而不是先算好的結果 —— 同一個 forEach 迴圈裡呼叫上千次時，
  // 只有 debounce 到期那一刻才真的組一次 snapshot，不會每筆訂單都組一次陣列
  scheduleOrdersSave(getOrdersSnapshot);
}

function loadOrdersFromDisk() {
  try {
    const f = path.join(DATA_DIR, 'orders.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return null;
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

  // Orders/returns (separate file — see getOrdersSnapshot() note)
  const ghOrders = await loadOrdersFromGitHub();
  if (ghOrders) { applyOrdersSnapshot(ghOrders); }
  else {
    const cacheOrders = loadOrdersFromLocalCache();
    if (cacheOrders) { applyOrdersSnapshot(cacheOrders); console.log('[db] Loaded orders from local cache'); }
    else {
      const diskOrders = loadOrdersFromDisk();
      if (diskOrders) { applyOrdersSnapshot(diskOrders); console.log('[db] Loaded orders from disk'); }
      else { console.log('[db] No orders found, starting fresh'); }
    }
  }
})();

// ── Immediate GitHub save (used by item PUT/DELETE routes) ────
// 回傳 GitHub 是否真的存檔成功，讓路由能在存檔失敗時老實回報錯誤，而不是誤報成功
async function saveNow() {
  flushToDisk();
  return await saveToGitHub(getSnapshot());
}

// 整批同步（upsertSilent）結束後呼叫這個，一次把記憶體裡的訂單/退貨存進 GitHub——
// 只產生一個 commit，不會像逐頁存檔那樣觸發一連串重新部署把同步自己中斷掉。
async function flushOrdersNow() {
  flushOrdersToDisk();
  return await saveOrdersToGitHub(getOrdersSnapshot());
}

// ── Items ─────────────────────────────────────────────────────
const itemsDb = {
  getAll()            { return Object.values(_store.items); },
  upsert(item)        { _store.items[item.id] = item; markDirty(); },
  async upsertNow(item) { _store.items[item.id] = item; return await saveNow(); },
  async deleteNow(id)   { delete _store.items[id]; return await saveNow(); },
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
// 只保留讀取：新照片改用 github-storage.js 的 ghSaveImageFile 各自存成獨立檔案（見 server.js），
// 這裡的 _store.images 只當作舊架構(整包 dilute-images.json)資料的讀取 fallback。
const imagesDb = {
  get(hash) { return _store.images[hash] || null; },
};

// ── Inventory (ShopLine — session only, re-synced on demand) ──
// Orders/returns 已改成持久化（見上面 getOrdersSnapshot/applyOrdersSnapshot），
// 只有 inventory 本身還是單純的即時快照、不落地。
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
// 依 created_at 新到舊排序（Map 只保留插入順序，更新既有 key 不會把它移到最前面，
// 所以「最新在前」一定要在讀取時排序，不能靠插入順序）
function sortByCreatedDesc(list) {
  return list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

const orders = {
  getAll(limit=100)  { return sortByCreatedDesc([..._ordersMap.values()]).slice(0, limit); },
  getByStatus(s)     { return [..._ordersMap.values()].filter(o => o.status === s); },
  upsert(order)      { _ordersMap.set(order.sl_order_id, order); markOrdersDirty(); },
  // 整批同步（幾千筆訂單、分幾十頁）用這個：只寫記憶體，不觸發存檔。
  // GitHub 存檔會建立一個 commit，這個 repo 同時是 Railway 的部署來源，
  // 每筆訂單都各自觸發一次存檔 = 每筆都各自觸發一次重新部署，會把還在跑的
  // 同步自己中斷掉。整批同步結束後改用 flushOrdersNow() 只存一次。
  upsertSilent(order) { _ordersMap.set(order.sl_order_id, order); },
  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const d = [..._ordersMap.values()];
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
  getAll(limit=100) { return sortByCreatedDesc([..._returnsMap.values()]).slice(0, limit); },
  upsert(ret)       { _returnsMap.set(ret.sl_refund_id, ret); markOrdersDirty(); },
  upsertSilent(ret) { _returnsMap.set(ret.sl_refund_id, ret); },
  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const d = [..._returnsMap.values()];
    return {
      total: d.length,
      today_count: d.filter(r => (r.created_at||'').startsWith(today)).length,
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

module.exports = { inv, orders, returns, events, itemsDb, configDb, imagesDb, returnFormsDb, flushOrdersNow };
