const fetch = require('node-fetch');

const BASE = (domain) => `https://${domain}/api/v2/admin`;

const headers = (token) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`,
});

// ── Generic request ───────────────────────────────────────────
async function slRequest(domain, token, method, path, body = null) {
  const url = `${BASE(domain)}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ShopLine API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Paginate through all pages ────────────────────────────────
async function slPaginateAll(domain, token, path, dataKey) {
  let page = 1;
  let all = [];
  while (true) {
    const res = await slRequest(domain, token, 'GET', `${path}?page=${page}&limit=100`);
    const items = res.data?.[dataKey] || res[dataKey] || [];
    all = all.concat(items);
    const meta = res.meta || res.data?.meta;
    if (!meta || page >= (meta.total_pages || meta.last_page || 1)) break;
    page++;
  }
  return all;
}

// ── Shop info (connection test) ───────────────────────────────
async function getShopInfo(domain, token) {
  return slRequest(domain, token, 'GET', '/shop');
}

// ── Products & inventory ──────────────────────────────────────
async function getAllProducts(domain, token) {
  return slPaginateAll(domain, token, '/products', 'products');
}

async function getInventoryLevels(domain, token) {
  // ShopLine: inventory per variant
  const products = await getAllProducts(domain, token);
  const rows = [];
  for (const product of products) {
    const variants = product.variants || [];
    for (const variant of variants) {
      rows.push({
        item_code:  product.handle || product.id,
        item_name:  product.title?.zh || product.title?.en || '',
        variant_id: String(variant.id),
        size:       variant.option1 || variant.option2 || 'Default',
        sku:        variant.sku || '',
        quantity:   variant.inventory_quantity || 0,
        sl_quantity:variant.inventory_quantity || 0,
      });
    }
  }
  return rows;
}

async function updateInventory(domain, token, variantId, newQty) {
  return slRequest(domain, token, 'PUT', `/variants/${variantId}`, {
    variant: { inventory_quantity: newQty },
  });
}

// ── Orders ────────────────────────────────────────────────────
async function getOrders(domain, token, params = {}) {
  const qs = new URLSearchParams({ limit: 100, ...params }).toString();
  const res = await slRequest(domain, token, 'GET', `/orders?${qs}`);
  return res.data?.orders || res.orders || [];
}

async function getAllOrders(domain, token) {
  return slPaginateAll(domain, token, '/orders', 'orders');
}

// 只留報表/庫存會用到的欄位，避免逐筆訂單存下整包 ShopLine 原始 line_items
function condenseLineItems(items) {
  return (items || []).map(li => ({
    sku:        li.sku || '',
    variant_id: li.variant_id != null ? String(li.variant_id) : null,
    product_id: li.product_id != null ? String(li.product_id) : null,
    title:      li.title || li.name || '',
    quantity:   li.quantity || 0,
    price:      parseFloat(li.price || 0),
  }));
}

function normalizeOrder(o) {
  // fulfillment_status（配送狀態）跟訂單本身是否被取消/作廢是兩件事，
  // 不能只靠 fulfillment_status 推斷 —— 取消的訂單也可能帶有正常的 fulfillment_status 值，
  // 這裡分開存成獨立欄位，「是否取消」交給呼叫端（webhook cancel handler）明確設定。
  return {
    sl_order_id:        String(o.id),
    order_number:       o.order_number || o.name || String(o.id),
    status:             o.financial_status || o.fulfillment_status || 'pending',
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    financial_status:   o.financial_status || null,
    cancelled_at:       o.cancelled_at || null,
    total_price:        parseFloat(o.total_price || 0),
    currency:           o.currency || 'TWD',
    customer_name:      o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '',
    customer_email:     o.customer?.email || '',
    line_items:         JSON.stringify(condenseLineItems(o.line_items)),
    created_at:         o.created_at || new Date().toISOString(),
  };
}

// ── Refunds / Returns ─────────────────────────────────────────
async function getRefundsForOrder(domain, token, orderId) {
  const res = await slRequest(domain, token, 'GET', `/orders/${orderId}/refunds`);
  return res.data?.refunds || res.refunds || [];
}

function condenseRefundLineItems(items) {
  return (items || []).map(ri => ({
    sku:        ri.line_item?.sku || '',
    variant_id: ri.line_item?.variant_id != null ? String(ri.line_item.variant_id) : null,
    product_id: ri.line_item?.product_id != null ? String(ri.line_item.product_id) : null,
    title:      ri.line_item?.title || ri.line_item?.name || '',
    quantity:   ri.quantity || 0,
  }));
}

function normalizeRefund(r, orderId, orderNumber) {
  return {
    sl_refund_id: String(r.id),
    sl_order_id:  String(orderId),
    order_number: orderNumber || String(orderId),
    reason:       r.reason || '',
    amount:       parseFloat(r.transactions?.[0]?.amount || 0),
    line_items:   JSON.stringify(condenseRefundLineItems(r.refund_line_items)),
    status:       r.status || 'completed',
    created_at:   r.created_at || new Date().toISOString(),
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
  getRefundsForOrder,
  normalizeRefund,
};
