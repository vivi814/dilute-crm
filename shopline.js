const fetch = require('node-fetch');

// SHOPLINE 的 Open API 固定打這個共用網關，不是打各商店自己的網域
// （之前的程式碼假設 https://${domain}/api/v2/admin 是錯的 —— 那其實是商店的
// 一般網域，打過去只會被導回商店首頁 HTML，不會有 JSON）。
// 參考：https://open-api.docs.shoplineapp.com/docs/openapi-request-example
const BASE = 'https://open.shopline.io/v1';

// domain 參數保留只是為了不用改所有呼叫端的簽名，這裡拿它推導 User-Agent
// 要求的「商家 handle」（SHOPLINE 規定一定要帶 User-Agent，否則會被拒絕）。
function handleFromDomain(domain) {
  if (!domain) return 'dilute-crm';
  return String(domain).split('.')[0] || 'dilute-crm';
}

function headers(token, domain) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': handleFromDomain(domain),
  };
}

function money(m) {
  if (m == null) return 0;
  if (typeof m === 'number') return m;
  return m.dollars ?? (m.cents != null ? m.cents / 100 : 0);
}

// 回應包裝的 key 沒有 100% 確認過（文件沒給完整範例），防禦性地嘗試幾種常見形狀
function extractArray(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.items)) return res.items;
  for (const v of Object.values(res || {})) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

// ── Generic request ───────────────────────────────────────────
async function slRequest(domain, token, method, path, body = null) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(token, domain),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ShopLine API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 一個分頁請求最多重試幾次 —— 訂單量大的店（幾千筆）整批同步要打幾十次連續請求，
// 中途遇到一次網路瞬斷（ECONNRESET之類）很正常，重試比直接整個放棄划算。
async function slRequestWithRetry(domain, token, method, path, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await slRequest(domain, token, method, path);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ── Paginate through all pages ────────────────────────────────
// 這個 API 沒有保證回傳 total_pages/last_page 這類 meta，用「這頁筆數 < per_page
// 就是最後一頁」判斷停止，比較保守但不依賴不確定存在的欄位。
//
// onPage（可選）：每抓到一頁就立刻呼叫一次，讓呼叫端可以逐頁存檔 —— 訂單量大時
// 整個同步要跑好幾分鐘，中途某一頁重試後還是失敗的話，靠 onPage 已經存進去的資料
// 不會因為後面失敗而整批遺失，只差最後沒抓完的那幾頁。
async function slPaginateAll(domain, token, path, extraParams = {}, onPage = null) {
  const perPage = 100;
  let page = 1;
  let all = [];
  while (true) {
    const qs = new URLSearchParams({ page, per_page: perPage, ...extraParams }).toString();
    const res = await slRequestWithRetry(domain, token, 'GET', `${path}?${qs}`);
    const items = extractArray(res);
    if (onPage) onPage(items, page);
    else all = all.concat(items);
    if (items.length < perPage) break;
    page++;
  }
  return all;
}

// ── Connection test ───────────────────────────────────────────
async function getShopInfo(domain, token) {
  // 這個 API 沒有獨立的 /shop endpoint，用 /token/info 驗證 token 有效性
  return slRequest(domain, token, 'GET', '/token/info');
}

// ── Products & inventory ──────────────────────────────────────
async function getAllProducts(domain, token, onPage = null) {
  return slPaginateAll(domain, token, '/products', {}, onPage);
}

async function getInventoryLevels(domain, token) {
  const products = await getAllProducts(domain, token);
  const rows = [];
  for (const product of products) {
    const variations = product.variations || [];
    for (const v of variations) {
      rows.push({
        item_code:  String(product.id),
        item_name:  product.title_translations?.['zh-hant'] || product.title_translations?.zh || product.title_translations?.en || '',
        variant_id: String(v.id),
        size:       Object.values(v.fields_translations || {})[0] || 'Default',
        sku:        v.sku || '',
        quantity:   v.quantity || 0,
        sl_quantity:v.quantity || 0,
      });
    }
  }
  return rows;
}

async function updateInventory(domain, token, variantId, newQty) {
  // 待驗證：庫存更新的確切 endpoint 還沒對照過真實文件，先保留合理猜測
  return slRequest(domain, token, 'PUT', `/products/variations/${variantId}`, {
    quantity: newQty,
  });
}

// ── Orders ────────────────────────────────────────────────────
async function getOrders(domain, token, params = {}) {
  const qs = new URLSearchParams({ per_page: 100, page: 1, ...params }).toString();
  const res = await slRequest(domain, token, 'GET', `/orders?${qs}`);
  return extractArray(res);
}

async function getAllOrders(domain, token, onPage = null) {
  return slPaginateAll(domain, token, '/orders', {}, onPage);
}

// 只留報表/庫存會用到的欄位，避免逐筆訂單存下整包 SHOPLINE 原始 line_items
function condenseLineItems(items) {
  return (items || []).map(li => ({
    sku:        li.sku || '',
    variant_id: li.item_variation_key != null ? String(li.item_variation_key) : null,
    product_id: li.item_id != null ? String(li.item_id) : null,
    title:      li.title_translations?.['zh-hant'] || li.title_translations?.zh || li.title_translations?.en || '',
    quantity:   li.quantity || 0,
    price:      money(li.item_price ?? li.price),
  }));
}

function normalizeOrder(o) {
  // SHOPLINE 的 status 本身就是單一欄位（temp/pending/removed/confirmed/completed/cancelled），
  // 不是 Shopify 系那種拆成 fulfillment_status/financial_status 兩個頂層欄位 ——
  // 配送/付款狀態實際上是分別放在 order_delivery.status / order_payment.status 裡。
  return {
    sl_order_id:        String(o.id),
    order_number:       o.order_number || String(o.id),
    status:             o.status || 'pending',
    fulfillment_status: o.order_delivery?.status || null,
    financial_status:   o.order_payment?.status || null,
    cancelled_at:       o.status === 'cancelled' ? (o.updated_at || null) : null,
    total_price:        money(o.total),
    currency:           o.total?.currency_iso || 'TWD',
    customer_name:      o.customer_name || '',
    customer_email:     o.customer_email || '',
    line_items:         JSON.stringify(condenseLineItems(o.subtotal_items)),
    created_at:         o.created_at || new Date().toISOString(),
    // 訂單分批出貨時，SHOPLINE 會把原訂單拆成一個帶 parent_order_id 的「子訂單」——
    // /v1/orders 列表會把子訂單當成獨立一筆回傳，但它跟原訂單其實是同一筆客人訂單，
    // 不能算成兩筆訂單（財報的訂單數會被灌水）。存下這個欄位讓 reports.js 做去重。
    parent_order_id:    o.parent_order_id || null,
  };
}

// ── Return orders（退換貨）─────────────────────────────────────
// SHOPLINE 沒有「訂單底下的退款」這種巢狀資源 —— 退換貨是獨立的頂層資源
// GET /v1/return_orders，可以直接整批分頁抓全部，不用像 Shopify 那樣逐筆訂單各查一次。
async function getAllReturnOrders(domain, token, onPage = null) {
  return slPaginateAll(domain, token, '/return_orders', {}, onPage);
}

async function getReturnOrdersForOrder(domain, token, orderId) {
  const res = await slRequest(domain, token, 'GET', `/return_orders?order_id=${encodeURIComponent(orderId)}`);
  return extractArray(res);
}

// ReturnOrderItem 目前查到的欄位沒有 sku，只有 item_id —— 沒辦法直接套用既有的
// sku 前綴比對邏輯去對回商品成本，這裡誠實地把 sku 留空，而不是硬湊一個錯的值
// （財報的「退貨商品排行/成本對應率」會因此看到這批東西沒對到商品，這是資料源本身的限制）。
function condenseRefundLineItems(items) {
  return (items || []).map(ri => ({
    sku:        '',
    variant_id: null,
    product_id: ri.item_id != null ? String(ri.item_id) : null,
    title:      '',
    quantity:   ri.quantity || 0,
  }));
}

// 保留 (ro, orderIdOverride, orderNumberOverride) 這個舊簽名相容 webhook 呼叫端；
// 整批同步時 return_order 物件本身就帶 order_id/return_order_number，可以只傳一個參數。
function normalizeRefund(ro, orderIdOverride, orderNumberOverride) {
  const orderId = orderIdOverride ?? ro.order_id;
  const orderNumber = orderNumberOverride ?? ro.return_order_number ?? String(orderId);
  return {
    sl_refund_id: String(ro.id),
    sl_order_id:  String(orderId),
    order_number: orderNumber,
    reason:       ro.reason || '',
    amount:       money(ro.total),
    line_items:   JSON.stringify(condenseRefundLineItems(ro.items)),
    status:       ro.status || 'completed',
    created_at:   ro.created_at || new Date().toISOString(),
  };
}

module.exports = {
  getShopInfo,
  getAllProducts,
  getInventoryLevels,
  updateInventory,
  getOrders,
  getAllOrders,
  normalizeOrder,
  getAllReturnOrders,
  getReturnOrdersForOrder,
  normalizeRefund,
};
