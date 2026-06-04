const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dilute.db'));

// Enable WAL for better concurrent performance
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code   TEXT NOT NULL,
    item_name   TEXT,
    variant_id  TEXT,
    size        TEXT,
    sku         TEXT,
    quantity    INTEGER DEFAULT 0,
    sl_quantity INTEGER DEFAULT 0,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sl_order_id   TEXT UNIQUE,
    order_number  TEXT,
    status        TEXT,
    total_price   REAL,
    currency      TEXT DEFAULT 'TWD',
    customer_name TEXT,
    customer_email TEXT,
    line_items    TEXT,
    created_at    TEXT,
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS returns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sl_refund_id  TEXT UNIQUE,
    sl_order_id   TEXT,
    order_number  TEXT,
    reason        TEXT,
    amount        REAL,
    line_items    TEXT,
    status        TEXT DEFAULT 'pending',
    created_at    TEXT,
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT,
    payload    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(item_code);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS images (
    hash       TEXT PRIMARY KEY,
    mime       TEXT NOT NULL DEFAULT 'image/jpeg',
    data       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Inventory helpers ─────────────────────────────────────────
const inv = {
  getAll: () => db.prepare('SELECT * FROM inventory ORDER BY item_code, size').all(),

  getByCode: (code) => db.prepare('SELECT * FROM inventory WHERE item_code = ?').all(code),

  upsert: db.transaction((rows) => {
    const stmt = db.prepare(`
      INSERT INTO inventory (item_code, item_name, variant_id, size, sku, quantity, sl_quantity, updated_at)
      VALUES (@item_code, @item_name, @variant_id, @size, @sku, @quantity, @sl_quantity, datetime('now'))
      ON CONFLICT(variant_id) DO UPDATE SET
        quantity = excluded.quantity,
        sl_quantity = excluded.sl_quantity,
        updated_at = datetime('now')
    `);
    // Need unique index on variant_id for ON CONFLICT
    rows.forEach(r => stmt.run(r));
  }),

  updateQuantity: (variantId, qty) => db.prepare(`
    UPDATE inventory SET sl_quantity = ?, updated_at = datetime('now') WHERE variant_id = ?
  `).run(qty, variantId),

  adjustFromOrder: db.transaction((lineItems, direction = -1) => {
    // direction: -1 for sale, +1 for return
    const stmt = db.prepare(`
      UPDATE inventory SET
        sl_quantity = MAX(0, sl_quantity + ?),
        updated_at = datetime('now')
      WHERE variant_id = ?
    `);
    lineItems.forEach(item => {
      stmt.run(direction * item.quantity, String(item.variant_id));
    });
  }),
};

// ── Orders helpers ────────────────────────────────────────────
const orders = {
  getAll: (limit = 100) => db.prepare(`
    SELECT * FROM orders ORDER BY created_at DESC LIMIT ?
  `).all(limit),

  getByStatus: (status) => db.prepare(`
    SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC
  `).all(status),

  upsert: (order) => db.prepare(`
    INSERT INTO orders (sl_order_id, order_number, status, total_price, currency,
      customer_name, customer_email, line_items, created_at, updated_at)
    VALUES (@sl_order_id, @order_number, @status, @total_price, @currency,
      @customer_name, @customer_email, @line_items, @created_at, datetime('now'))
    ON CONFLICT(sl_order_id) DO UPDATE SET
      status = excluded.status,
      updated_at = datetime('now')
  `).run(order),

  stats: () => db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN date(created_at) = date('now') THEN total_price ELSE 0 END) as today_revenue,
      COUNT(CASE WHEN date(created_at) = date('now') THEN 1 END) as today_orders
    FROM orders
  `).get(),
};

// ── Returns helpers ───────────────────────────────────────────
const returns = {
  getAll: (limit = 100) => db.prepare(`
    SELECT * FROM returns ORDER BY created_at DESC LIMIT ?
  `).all(limit),

  upsert: (ret) => db.prepare(`
    INSERT INTO returns (sl_refund_id, sl_order_id, order_number, reason, amount, line_items, status, created_at, updated_at)
    VALUES (@sl_refund_id, @sl_order_id, @order_number, @reason, @amount, @line_items, @status, @created_at, datetime('now'))
    ON CONFLICT(sl_refund_id) DO UPDATE SET
      status = excluded.status,
      updated_at = datetime('now')
  `).run(ret),

  stats: () => db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(amount) as total_amount,
      COUNT(CASE WHEN date(created_at) = date('now') THEN 1 END) as today_count,
      SUM(CASE WHEN date(created_at) = date('now') THEN amount ELSE 0 END) as today_amount
    FROM returns
  `).get(),
};

// ── Events log ────────────────────────────────────────────────
const events = {
  log: (type, payload) => db.prepare(`
    INSERT INTO events (type, payload) VALUES (?, ?)
  `).run(type, JSON.stringify(payload)),

  recent: (limit = 50) => db.prepare(`
    SELECT * FROM events ORDER BY created_at DESC LIMIT ?
  `).all(limit),
};

// Add unique index for variant_id after schema creation
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_variant ON inventory(variant_id)');
} catch(e) { /* already exists */ }

// ── Items (product records) ───────────────────────────────────
const itemsDb = {
  getAll: () => db.prepare('SELECT id, data, updated_at FROM items ORDER BY id').all()
    .map(r => ({ ...JSON.parse(r.data), _updated_at: r.updated_at })),

  upsert: (item) => db.prepare(`
    INSERT INTO items (id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
  `).run(item.id, JSON.stringify(item)),

  delete: (id) => db.prepare('DELETE FROM items WHERE id = ?').run(id),

  nextId: () => {
    const row = db.prepare('SELECT MAX(id) as mx FROM items').get();
    return (row.mx || 99) + 1;
  },
};

// ── Config (CATS, SEASONS, skuColors, etc.) ───────────────────
const configDb = {
  get: (key) => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  },
  set: (key, value) => db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value)),
  getAll: () => {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const out = {};
    rows.forEach(r => out[r.key] = JSON.parse(r.value));
    return out;
  },
};

// ── Images ────────────────────────────────────────────────────
const imagesDb = {
  get: (hash) => {
    const row = db.prepare('SELECT mime, data FROM images WHERE hash = ?').get(hash);
    return row || null;
  },
  set: (hash, mime, data) => db.prepare(`
    INSERT OR IGNORE INTO images (hash, mime, data) VALUES (?, ?, ?)
  `).run(hash, mime, data),
};

module.exports = { db, inv, orders, returns, events, itemsDb, configDb, imagesDb };
