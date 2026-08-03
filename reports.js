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

// 「哪一天」的認定方式是商家明確指定的：直接用訂單 created_at 的原始 UTC 日期
// （不轉換成台灣時間），理由是這樣才會跟訂單編號開頭的日期一致（訂單編號本身
// 就是拿 UTC 時間格式化出來的，例如 20260728162906346 = UTC 2026-07-28 16:29:06）。
// 這個跟 SHOPLINE 官方後台首頁「成交總額」用的認定方式不同（那邊實測是用台灣
// 時間），會有深夜下的單兩邊各自歸類到不同日期的情況——這是商家明確選擇要跟
// 訂單編號一致，不是算錯，日後如果要改回對齊官方後台，把 TZ_OFFSET_MS 改回
// 8*60*60*1000 即可。
const TZ_OFFSET_MS = 0;

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

// 訂單本身的 status 只代表訂單流程狀態，不代表金流有沒有實際入帳 —— 實測發現有訂單
// status 是 completed（流程走完），但 financial_status（order_payment.status）卻是
// pending（金流其實沒收到錢），這種不能算進「客人已付款」的營收。
// completed／partially_refunded 代表金流確實入帳且目前仍保留（partially_refunded 的
// order.total 已經是退款後的淨額，不用再另外扣一次）；pending/failed/expired 代表
// 根本沒收到錢；refunding/refunded 代表錢正在退或已經退完，都不算「客人已付款」。
function isConfirmedPaid(o) {
  return o.financial_status === 'completed' || o.financial_status === 'partially_refunded';
}

// 訂單分批出貨時，SHOPLINE 會把原訂單拆成帶 parent_order_id 的「子訂單」，
// /v1/orders 列表會把子訂單當成獨立一筆回傳 —— 子訂單的金額是真的錢（要算進營收），
// 但不是「多一張訂單」，算訂單數/客單價時不能把子訂單也算成一筆，會把訂單數灌水
// （實測對過 ShopLine 官方報表才抓到：159 筆原始紀錄裡有 4 筆是子訂單，
// 159−4=155 才是官方顯示的「成交訂單總量」）。
function isCountableOrder(o) {
  return !o.parent_order_id;
}

// 訂單被退了多少錢：實測發現「全額退款」(financial_status==='refunded') 的訂單，
// order.total 並不會被歸零、還是顯示原本的金額（只有「部分退款」才會把 order.total
// 更新成退款後的淨額）——如果兩種情況都用「payment_total − total_price」的差額去算，
// 全額退款會算出 0（因為兩個欄位其實還是相等的），嚴重低估退款金額。
// 全額退款：退款金額 = 全部金額（payment_total，等同 total_price）。
// 部分退款：退款金額 = payment_total − total_price 的差額（明確被扣減的部分）。
// 已知限制：極少數 partially_refunded 訂單的 total 完全沒被更新（可能是退運費/點數
// 之類不影響商品金額的退款），這種情況這個公式會算成 0，屬於資料本身沒有更細的欄位
// 可以拿來拆解，不是計算邏輯的錯。
function orderRefundAmount(o) {
  if (o.financial_status === 'refunded') return o.payment_total || o.total_price || 0;
  if (o.financial_status === 'partially_refunded') {
    return Math.max(0, (o.payment_total || 0) - (o.total_price || 0));
  }
  return 0;
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
  const grossOrders = allOrders.filter(o => !isVoidOrCancelled(o) && isConfirmedPaid(o));

  const buckets = new Map();
  const getBucket = key => {
    if (!buckets.has(key)) buckets.set(key, { period: key, gross_revenue: 0, order_count: 0, refund_amount: 0 });
    return buckets.get(key);
  };
  grossOrders.forEach(o => {
    const b = getBucket(bucketKey(o.created_at, granularity));
    b.gross_revenue += o.total_price || 0;
    if (isCountableOrder(o)) b.order_count += 1;
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

  const totalGross    = grossOrders.reduce((a, o) => a + (o.total_price || 0), 0);
  const totalRefund   = allReturns.reduce((a, r) => a + (r.amount || 0), 0);
  const countedOrders = grossOrders.filter(isCountableOrder);

  // 依金流狀態拆三類，讓「已收款/待付款/已失敗」看得到，不用只看一個籠統的
  // excluded_count。兩個實測發現，決定了這裡故意不是三類都用同一種篩選：
  // (a) 付款失敗/逾期的訂單，訂單本身幾乎都會一起被標成 cancelled（577 筆
  //     failed/expired 全部是 cancelled）——如果跟營收一樣先排除取消訂單，
  //     「已失敗」永遠會是 0，所以待付款/已失敗這兩類不排除取消訂單。
  // (b) 但也有 397 筆訂單明明 financial_status 是 completed/partially_refunded、
  //     訂單卻是 cancelled 狀態——「已收款」這類如果不排除取消訂單，會跟上面的
  //     毛營收/訂單數對不起來（同一個畫面出現兩個互相矛盾的數字），所以「已收款」
  //     沿用跟營收一樣的篩選（grossOrders，已排除取消訂單）。
  // 金額用全部（含分批出貨的子訂單，每一筆都是真的錢），筆數用去重過的
  // （子訂單不算一張獨立訂單）——跟營收報表「金額算全部、訂單數去重」同一套原則。
  const paymentBreakdown = (list, statuses) => {
    const filtered = list.filter(o => statuses.includes(o.financial_status));
    return {
      count:  filtered.filter(isCountableOrder).length,
      amount: filtered.reduce((a, o) => a + (o.total_price || 0), 0),
    };
  };
  const paymentReceived = paymentBreakdown(grossOrders, ['completed', 'partially_refunded']);
  const paymentPending  = paymentBreakdown(allOrders, ['pending']);
  const paymentFailed   = paymentBreakdown(allOrders, ['failed', 'expired']);

  // 訂單是用「下單日」歸類，不是「付款日」——今天下單但還沒付款（pending）的訂單，
  // 現在完全不算進營收；等它幾天後真的付款完成，這筆金額會追加回「下單當天」
  // 那個日期，讓最近幾天的營收數字往上調整。反過來，如果最後真的沒付款
  // （expired/failed），因為從頭到尾都沒被算進去過，也不需要再扣一次——不像
  // ShopLine 官方後台那種「先算再事後扣」的做法。約 3 天是這家店 pending 訂單
  // 通常會確定（付款成功或逾期失效）的天數，最近 3 天的數字要標示還沒定案。
  const revenueIncompleteAfter = toLocalDateStr(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());

  return {
    definition: {
      basis: '以訂單 created_at（下單日）入帳，非付款日/出貨日',
      note: '毛營收=未取消訂單、且金流狀態確定已收款（completed/partially_refunded）的加總；訂單走完流程但實際沒收到錢（pending/failed/expired）不算進營收。淨營收=毛營收−當期退款金額（退款歸屬到退款發生當下，不回溯改寫原訂單期間的營收）。訂單數不計分批出貨產生的子訂單（同一張客人訂單只算一次，金額仍完整計入）',
      pending_payment_note: '最近幾天可能有訂單還卡在「尚未付款」狀態，這種訂單目前完全不算進營收；等它之後真的付款完成，數字會追加回下單當天，所以最近幾天的營收可能還會往上調整，不是最終數字',
    },
    summary: {
      gross_revenue: totalGross,
      refund_amount: totalRefund,
      net_revenue: totalGross - totalRefund,
      order_count: countedOrders.length,
      excluded_count: allOrders.length - grossOrders.length,
      aov: countedOrders.length ? totalGross / countedOrders.length : 0,
      data_incomplete_after: revenueIncompleteAfter,
      payment_received: paymentReceived,
      payment_pending:  paymentPending,
      payment_failed:   paymentFailed,
    },
    series,
  };
}

// ── 商品銷售排行 ─────────────────────────────────────────────
function getProductsReport({ from, to, sort = 'revenue', limit = 50 } = {}) {
  const items = itemsDb.getAll();
  const grossOrders = orders.getAll(Infinity)
    .filter(o => inRange(o.created_at, from, to))
    .filter(o => !isVoidOrCancelled(o) && isConfirmedPaid(o));

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
    definition: { basis: '同營收報表：只計未取消、且確定已收款的訂單，以下單日篩選期間' },
    match_rate: {
      revenue_matched_pct: totalRevenue ? Math.round((matchedRevenue / totalRevenue) * 100) : null,
      quantity_matched_pct: totalQty ? Math.round((matchedQty / totalQty) * 100) : null,
    },
    products: rows.slice(0, Number(limit) || 50),
  };
}

// ── 退換貨分析 ───────────────────────────────────────────────
function getReturnsReport({ from, to } = {}) {
  // 這家店的 return_orders（SHOPLINE 正式的「退換貨」功能）整店查起來是 0 筆，
  // 但訂單的金流狀態（financial_status）明確顯示有大量 partially_refunded/refunded 的
  // 訂單 —— 這家店的退款是直接退在金流上，不是走退換貨流程。只看 return_orders
  // 會完全漏掉這些真實發生的退款，所以這裡改成兩種來源都算：
  // (a) 正式 return_orders（保留，以防之後真的開始用這個功能）
  // (b) 訂單本身 payment_total（原始付款）− total_price（目前淨額）的差額
  const rangedOrdersAll = orders.getAll(Infinity)
    .filter(o => inRange(o.created_at, from, to) && !isVoidOrCancelled(o));
  const rangedOrders  = rangedOrdersAll.filter(isConfirmedPaid);
  const rangedReturns = returns.getAll(Infinity).filter(r => inRange(r.created_at, from, to));

  const grossRevenue = rangedOrders.reduce((a, o) => a + (o.total_price || 0), 0);

  const formalRefundAmount = rangedReturns.reduce((a, r) => a + (r.amount || 0), 0);

  const orderLevelRefunds = rangedOrdersAll.filter(o =>
    o.financial_status === 'partially_refunded' || o.financial_status === 'refunded'
  );
  const orderLevelRefundAmount = orderLevelRefunds.reduce((a, o) => a + orderRefundAmount(o), 0);

  const refundAmount = formalRefundAmount + orderLevelRefundAmount;
  const returnCount  = rangedReturns.length + orderLevelRefunds.length;
  const orderCount   = rangedOrders.filter(isCountableOrder).length;

  const reasonCounts = new Map();
  rangedReturns.forEach(r => {
    const key = r.reason || '未填寫（正式退換貨單）';
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  });
  if (orderLevelRefunds.length) {
    reasonCounts.set('訂單金流直接退款（無詳細原因，非走退換貨流程）', orderLevelRefunds.length);
  }

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
      note: '退換貨率有天生落後偏誤（退貨通常晚於下單），最近 14 天內的數字尚未完整，僅供參考，不要當成最終數字。這家店的退款主要是直接退在金流上（非走 SHOPLINE 的退換貨功能），退貨商品排行只涵蓋走正式退換貨流程的部分，金流直接退款目前無法拆解到是哪個商品',
    },
    summary: {
      order_count: orderCount,
      return_count: returnCount,
      return_rate: orderCount ? returnCount / orderCount : null,
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
    .filter(o => inRange(o.created_at, from, to) && !isVoidOrCancelled(o) && isConfirmedPaid(o));
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

  // 權威營收數字用訂單的 total（跟營收報表用同一套算法）——不能用逐筆 line_item
  // 價格加總重算一次。訂單層級的折扣/購物金/點數折抵通常不會分攤回每個 line_item，
  // line_item 加總會比 order.total 還大，算出來的「毛利」就可能比「淨營收」還高，
  // 邏輯上不可能發生（毛利 = 淨營收 − 成本，成本不會是負的）。
  // line_item 的價格只用在下面「每個商品的營收占比」這種比例概算，不能拿來當權威總數。
  const totalRevenue = grossOrders.reduce((a, o) => a + (o.total_price || 0), 0);
  const lineItemRevenueSum = [...revenueBySku.values()].reduce((a, v) => a + v, 0);

  let totalCogs = 0, matchedRevenue = 0;
  const perProduct = [];
  netQtyBySku.forEach((qty, sku) => {
    const lineRevenue = revenueBySku.get(sku) || 0;
    // 用這個商品的 line_item 金額占「全部 line_item 加總」的比例，換算回權威營收，
    // 避免直接拿 line_item 金額當作這個商品「實際貢獻的營收」（見上面的說明）。
    const revenue = lineItemRevenueSum ? (lineRevenue / lineItemRevenueSum) * totalRevenue : 0;
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
