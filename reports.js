/**
 * 財務報表彙整模組。四個 /api/reports/* endpoint 共用的口徑定義都寫在這裡，
 * 不要在各自的 route handler 裡各自決定 —— 保持整份報表用同一套邏輯：
 *
 * - 營收以訂單 created_at（下單日）入帳，不是付款日/出貨日（目前只有這個時間欄位可靠）。
 * - 毛營收 = 未取消/未作廢訂單加總；淨營收 = 毛營收 − 當期退款金額。
 * - 部分退款歸屬到「退款發生當下」的期間，不回溯改寫原訂單期間的營收（不然過去的月份
 *   營收會無預警變動，看起來像 bug）。
 * - 退換貨率有天生落後偏誤（退貨通常晚於下單），最近期間的數字要標示尚未完整。
 * - 毛利用「淨出貨數量」(下單數量−退貨數量) 算 COGS —— 退回的商品通常不再計入成本，
 *   不能營收扣了、成本又扣一次。
 * - SKU 對應商品成本：不能切第一個 '-'（貨號產生器可能讓 item.code 本身就帶 '-'），
 *   改成找 code 前綴、且優先取最長 code 的那個商品（見 matchItemBySku）。
 */
const { orders, returns, itemsDb, configDb } = require('./db');

const DEFAULT_EXCHANGE_RATE = 4.62;

// 商家在台灣，「今天」「這個月」都要用台灣時間（UTC+8）認定，不能直接切
// created_at 原始 UTC 字串的日期部分 —— 訂單存的是 UTC 時間，UTC 晚上 4 點以後
// 已經是台灣隔天，直接切字串會把台灣同一天的訂單切到不同天、或把隔天的訂單
// 誤算進今天（實測對過 ShopLine 官方報表才抓到這個誤差）。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function toLocalDateStr(dateStr) {
  if (!dateStr) return '';
  const t = Date.parse(dateStr);
  if (isNaN(t)) return '';
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function parseLineItems(record) {
  try { return JSON.parse(record.line_items || '[]'); } catch { return []; }
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = toLocalDateStr(dateStr);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function bucketKey(dateStr, granularity) {
  const d = toLocalDateStr(dateStr);
  return granularity === 'month' ? d.slice(0, 7) : d;
}

// SHOPLINE 的訂單狀態是單一 enum（temp/pending/removed/confirmed/completed/cancelled），
// 沒有 Shopify 系那種另外的 financial_status==='voided' 概念，判斷取消只看 status 就夠。
function isVoidOrCancelled(o) {
  return o.status === 'cancelled';
}

// 找 sku 對應的商品：不能只切第一個 '-'，因為貨號產生器可能讓 item.code 本身就帶 '-'
// （例如 '2603MG-001'），要找「code 前綴相符」且取最長 code 的那個，避免
// '2603MG' 和 '2603MG-001' 同時存在時對應到錯誤商品。
function matchItemBySku(sku, items) {
  if (!sku) return null;
  let best = null;
  for (const item of items) {
    if (!item.code) continue;
    if (sku === item.code || sku.startsWith(item.code + '-')) {
      if (!best || item.code.length > best.code.length) best = item;
    }
  }
  return best;
}

function itemUnitCostTwd(item, rate) {
  if (!item || typeof item.costCny !== 'number') return null;
  return item.deductCur === 'TWD' ? item.costCny : item.costCny * rate;
}

// ── 營收/訂單分析 ────────────────────────────────────────────
function getRevenueReport({ from, to, granularity = 'day' } = {}) {
  const allOrders  = orders.getAll(Infinity).filter(o => inRange(o.created_at, from, to));
  const allReturns = returns.getAll(Infinity).filter(r => inRange(r.created_at, from, to));
  const grossOrders = allOrders.filter(o => !isVoidOrCancelled(o));

  const buckets = new Map();
  const getBucket = key => {
    if (!buckets.has(key)) buckets.set(key, { period: key, gross_revenue: 0, order_count: 0, refund_amount: 0 });
    return buckets.get(key);
  };
  grossOrders.forEach(o => {
    const b = getBucket(bucketKey(o.created_at, granularity));
    b.gross_revenue += o.total_price || 0;
    b.order_count += 1;
  });
  allReturns.forEach(r => {
    const b = getBucket(bucketKey(r.created_at, granularity));
    b.refund_amount += r.amount || 0;
  });

  const series = [...buckets.values()]
    .map(b => ({
      ...b,
      net_revenue: b.gross_revenue - b.refund_amount,
      aov: b.order_count ? b.gross_revenue / b.order_count : 0,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const totalGross  = grossOrders.reduce((a, o) => a + (o.total_price || 0), 0);
  const totalRefund = allReturns.reduce((a, r) => a + (r.amount || 0), 0);

  return {
    definition: {
      basis: '以訂單 created_at（下單日）入帳，非付款日/出貨日',
      note: '毛營收=未取消/未作廢訂單加總；淨營收=毛營收−當期退款金額（退款歸屬到退款發生當下，不回溯改寫原訂單期間的營收）',
    },
    summary: {
      gross_revenue: totalGross,
      refund_amount: totalRefund,
      net_revenue: totalGross - totalRefund,
      order_count: grossOrders.length,
      cancelled_count: allOrders.length - grossOrders.length,
      aov: grossOrders.length ? totalGross / grossOrders.length : 0,
    },
    series,
  };
}

// ── 商品銷售排行 ─────────────────────────────────────────────
function getProductsReport({ from, to, sort = 'revenue', limit = 50 } = {}) {
  const items = itemsDb.getAll();
  const grossOrders = orders.getAll(Infinity)
    .filter(o => inRange(o.created_at, from, to))
    .filter(o => !isVoidOrCancelled(o));

  const bySku = new Map();
  let totalRevenue = 0, totalQty = 0;
  grossOrders.forEach(o => {
    parseLineItems(o).forEach(li => {
      const key = li.sku || li.title || 'unknown';
      const row = bySku.get(key) || { sku: key, title: li.title, quantity: 0, revenue: 0 };
      const lineRevenue = (li.price || 0) * (li.quantity || 0);
      row.quantity += li.quantity || 0;
      row.revenue += lineRevenue;
      bySku.set(key, row);
      totalRevenue += lineRevenue;
      totalQty += li.quantity || 0;
    });
  });

  let matchedRevenue = 0, matchedQty = 0;
  const rows = [...bySku.values()].map(row => {
    const item = matchItemBySku(row.sku, items);
    if (item) { matchedRevenue += row.revenue; matchedQty += row.quantity; }
    return { ...row, item_code: item?.code || null, matched: !!item };
  });
  rows.sort((a, b) => (sort === 'units' ? b.quantity - a.quantity : b.revenue - a.revenue));

  return {
    definition: { basis: '同營收報表：只計未取消/未作廢訂單，以下單日篩選期間' },
    match_rate: {
      revenue_matched_pct: totalRevenue ? Math.round((matchedRevenue / totalRevenue) * 100) : null,
      quantity_matched_pct: totalQty ? Math.round((matchedQty / totalQty) * 100) : null,
    },
    products: rows.slice(0, Number(limit) || 50),
  };
}

// ── 退換貨分析 ───────────────────────────────────────────────
function getReturnsReport({ from, to } = {}) {
  const rangedOrders = orders.getAll(Infinity)
    .filter(o => inRange(o.created_at, from, to) && !isVoidOrCancelled(o));
  const rangedReturns = returns.getAll(Infinity).filter(r => inRange(r.created_at, from, to));

  const grossRevenue  = rangedOrders.reduce((a, o) => a + (o.total_price || 0), 0);
  const refundAmount  = rangedReturns.reduce((a, r) => a + (r.amount || 0), 0);

  const reasonCounts = new Map();
  rangedReturns.forEach(r => {
    const key = r.reason || '未填寫';
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  });

  const bySku = new Map();
  rangedReturns.forEach(r => {
    parseLineItems(r).forEach(li => {
      const key = li.sku || li.title || 'unknown';
      const row = bySku.get(key) || { sku: key, title: li.title, quantity: 0 };
      row.quantity += li.quantity || 0;
      bySku.set(key, row);
    });
  });

  const recentCutoff = toLocalDateStr(new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString());

  return {
    definition: {
      note: '退換貨率有天生落後偏誤（退貨通常晚於下單），最近 14 天內的數字尚未完整，僅供參考，不要當成最終數字',
    },
    summary: {
      order_count: rangedOrders.length,
      return_count: rangedReturns.length,
      return_rate: rangedOrders.length ? rangedReturns.length / rangedOrders.length : null,
      refund_amount: refundAmount,
      refund_rate_of_revenue: grossRevenue ? refundAmount / grossRevenue : null,
      data_incomplete_after: recentCutoff,
    },
    reasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    top_returned_products: [...bySku.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 20),
  };
}

// ── 毛利/獲利分析 ────────────────────────────────────────────
function getProfitReport({ from, to, granularity = 'month' } = {}) {
  const items = itemsDb.getAll();
  const rate = Number(configDb.get('financeExchangeRate')) || DEFAULT_EXCHANGE_RATE;

  const grossOrders  = orders.getAll(Infinity)
    .filter(o => inRange(o.created_at, from, to) && !isVoidOrCancelled(o));
  const rangedReturns = returns.getAll(Infinity).filter(r => inRange(r.created_at, from, to));

  // 趨勢圖用的概算：每期用「該期下單商品」的毛（未扣退貨）成本概算，不做跨期的
  // net-quantity 計算（退貨常常跨到下一期才發生）。精確數字看下面的 summary，
  // 這裡只是讓使用者看到大致走勢。
  const trendBuckets = new Map();
  grossOrders.forEach(o => {
    const key = bucketKey(o.created_at, granularity);
    const b = trendBuckets.get(key) || { period: key, revenue: 0, cogs: 0 };
    b.revenue += o.total_price || 0;
    parseLineItems(o).forEach(li => {
      const item = matchItemBySku(li.sku, items);
      const unitCost = itemUnitCostTwd(item, rate);
      if (unitCost != null) b.cogs += unitCost * (li.quantity || 0);
    });
    trendBuckets.set(key, b);
  });
  const series = [...trendBuckets.values()]
    .map(b => ({
      ...b,
      gross_profit: b.revenue - b.cogs,
      margin_pct: b.revenue ? Math.round(((b.revenue - b.cogs) / b.revenue) * 1000) / 10 : null,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  // 淨數量 = 下單數量 − 退貨數量（同一 sku）；COGS 用淨數量算
  const netQtyBySku = new Map();
  const revenueBySku = new Map();
  grossOrders.forEach(o => {
    parseLineItems(o).forEach(li => {
      const key = li.sku || li.title || 'unknown';
      netQtyBySku.set(key, (netQtyBySku.get(key) || 0) + (li.quantity || 0));
      revenueBySku.set(key, (revenueBySku.get(key) || 0) + (li.price || 0) * (li.quantity || 0));
    });
  });
  rangedReturns.forEach(r => {
    parseLineItems(r).forEach(li => {
      const key = li.sku || li.title || 'unknown';
      netQtyBySku.set(key, (netQtyBySku.get(key) || 0) - (li.quantity || 0));
    });
  });

  let totalRevenue = 0, totalCogs = 0, matchedRevenue = 0;
  const perProduct = [];
  netQtyBySku.forEach((qty, sku) => {
    const revenue = revenueBySku.get(sku) || 0;
    totalRevenue += revenue;
    const item = matchItemBySku(sku, items);
    const unitCost = itemUnitCostTwd(item, rate);
    let cogs = null;
    if (unitCost != null) {
      cogs = unitCost * Math.max(qty, 0);
      totalCogs += cogs;
      matchedRevenue += revenue;
    }
    perProduct.push({ sku, item_code: item?.code || null, net_quantity: qty, revenue, cogs, matched: unitCost != null });
  });

  const refundAmount = rangedReturns.reduce((a, r) => a + (r.amount || 0), 0);
  const netRevenue = totalRevenue - refundAmount;
  const grossProfit = netRevenue - totalCogs;

  return {
    definition: {
      formula: '毛利 = (淨營收 − COGS) / 淨營收；COGS 用「淨出貨數量」(下單數量−退貨數量) × 單位成本計算',
      exchange_rate_note: `目前使用的 CNY→TWD 匯率為 ${rate}（configDb.financeExchangeRate，跟頁面上 client-only 的 rate-input 脫鉤），套用到整個查詢期間的所有訂單，不是精確的歷史匯率`,
      series_note: '趨勢圖（series）用每期下單當下的商品成本概算、未扣當期退貨，只用來看走勢；精確數字看 summary',
    },
    summary: {
      revenue: totalRevenue,
      refund_amount: refundAmount,
      net_revenue: netRevenue,
      cogs: totalCogs,
      gross_profit: grossProfit,
      margin_pct: netRevenue ? Math.round((grossProfit / netRevenue) * 1000) / 10 : null,
      cost_match_rate_pct: totalRevenue ? Math.round((matchedRevenue / totalRevenue) * 100) : null,
    },
    series,
    products: perProduct.sort((a, b) => (b.revenue || 0) - (a.revenue || 0)),
  };
}

module.exports = { getRevenueReport, getProductsReport, getReturnsReport, getProfitReport, matchItemBySku };
