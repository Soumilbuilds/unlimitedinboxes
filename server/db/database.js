import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, 'app.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    admin_password TEXT NOT NULL,
    mfa_secret TEXT,
    tenant_id TEXT,
    cloudflare_zone_id TEXT,
    cloudflare_ns TEXT,
    status TEXT DEFAULT 'pending_consent',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- Backfill column for existing installs (SQLite has no IF NOT EXISTS for columns)
  -- Guarded so a duplicate-column error is swallowed on re-run.
  -- (handled by application-level migration below)

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    order_name TEXT,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    total_mailboxes INTEGER DEFAULT 100,
    mailbox_password TEXT,
    mailbox_names TEXT,
    created_mailboxes TEXT DEFAULT '[]',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    message TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS tenant_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tenant_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    status TEXT DEFAULT 'pending',
    xpay_checkout_id TEXT UNIQUE,
    xpay_charge_id TEXT UNIQUE,
    xpay_customer_id TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    key_hash TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function ensureColumn(tableName, columnName, definition) {
  const columns = tableColumns(tableName);
  const exists = columns.some(col => col.name === columnName);
  if (!exists) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

function ensureOrdersPasswordColumn() {
  const columns = tableColumns('orders');
  const hasPassword = columns.some(col => col.name === 'mailbox_password');
  if (!hasPassword) {
    db.prepare('ALTER TABLE orders ADD COLUMN mailbox_password TEXT').run();
  }
}

function ensureOrdersNameColumn() {
  const columns = tableColumns('orders');
  const hasName = columns.some(col => col.name === 'order_name');
  if (!hasName) {
    db.prepare('ALTER TABLE orders ADD COLUMN order_name TEXT').run();
  }
}

function ensureOrdersMailboxNamesColumn() {
  ensureColumn('orders', 'mailbox_names', 'TEXT');
}

function ensureTenantsUserColumn() {
  const columns = tableColumns('tenants');
  const hasUser = columns.some(col => col.name === 'user_id');
  if (!hasUser) {
    db.prepare('ALTER TABLE tenants ADD COLUMN user_id INTEGER').run();
  }
}

function ensureTenantsRedirectColumn() {
  ensureColumn('tenants', 'redirect_url', 'TEXT');
}

function ensureTenantsMfaSecretColumn() {
  ensureColumn('tenants', 'mfa_secret', 'TEXT');
}

function ensureOrdersUserColumn() {
  const columns = tableColumns('orders');
  const hasUser = columns.some(col => col.name === 'user_id');
  if (!hasUser) {
    db.prepare('ALTER TABLE orders ADD COLUMN user_id INTEGER').run();
  }
}

function ensureUserBillingColumns() {
  ensureColumn('users', 'lifetime_completed_orders', 'INTEGER DEFAULT 0');

  ensureColumn('users', 'reseller_plan', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'orders_per_month', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'orders_used_this_period', 'INTEGER DEFAULT 0');

  ensureColumn('users', 'xpay_customer_id', 'TEXT');
  ensureColumn('users', 'xpay_subscription_id', 'TEXT');
  ensureColumn('users', 'xpay_subscription_status', 'TEXT');
  ensureColumn('users', 'xpay_subscription_plan', 'TEXT');
  ensureColumn('users', 'xpay_subscription_checkout_url', 'TEXT');
  ensureColumn('users', 'xpay_product', 'TEXT');
  ensureColumn('users', 'xpay_plan_id', 'TEXT');
  ensureColumn('users', 'xpay_current_period_end', 'TEXT');
  ensureColumn('users', 'xpay_cancel_at_period_end', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'xpay_checkout_id', 'TEXT');
  ensureColumn('users', 'xpay_checkout_url', 'TEXT');
  ensureColumn('users', 'xpay_intro_offer_used', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'xpay_last_payment_status', 'TEXT');
  ensureColumn('users', 'xpay_last_invoice_id', 'TEXT');
  ensureColumn('users', 'xpay_last_invoice_status', 'TEXT');
  ensureColumn('users', 'xpay_last_invoice_url', 'TEXT');
  ensureColumn('users', 'xpay_trial_ends_at', 'TEXT');
  ensureColumn('users', 'xpay_default_payment_method_id', 'TEXT');

  ensureColumn('users', 'whop_membership_id', 'TEXT');
  ensureColumn('users', 'whop_membership_status', 'TEXT');
  ensureColumn('users', 'whop_plan_id', 'TEXT');

  ensureColumn('users', 'inboxes_used', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'inboxes_limit', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'has_concurrent_orders', 'INTEGER DEFAULT 0');
}

function ensureTenantPurchasesColumns() {
  ensureColumn('tenant_purchases', 'xpay_checkout_id', 'TEXT');
  ensureColumn('tenant_purchases', 'xpay_charge_id', 'TEXT');
  ensureColumn('tenant_purchases', 'xpay_customer_id', 'TEXT');
}

function backfillLifetimeCompletedOrders() {
  db.prepare(`
    UPDATE users
    SET lifetime_completed_orders = (
      SELECT COUNT(*)
      FROM orders
      WHERE orders.user_id = users.id
        AND orders.status = 'completed'
    )
    WHERE COALESCE(lifetime_completed_orders, 0) < (
      SELECT COUNT(*)
      FROM orders
      WHERE orders.user_id = users.id
        AND orders.status = 'completed'
    )
  `).run();
}

ensureOrdersPasswordColumn();
ensureOrdersNameColumn();
ensureOrdersMailboxNamesColumn();
ensureTenantsUserColumn();
ensureTenantsRedirectColumn();
ensureTenantsMfaSecretColumn();
ensureOrdersUserColumn();
ensureUserBillingColumns();
ensureTenantPurchasesColumns();
backfillLifetimeCompletedOrders();

// --- USERS ---

export function createUser(email, passwordHash, passwordSalt, plan = 'free') {
  const stmt = db.prepare(`
    INSERT INTO users (email, password_hash, password_salt, plan)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(email, passwordHash, passwordSalt, plan);
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function deleteUserByEmail(email) {
  return db.prepare('DELETE FROM users WHERE email = ?').run(email);
}

export function updateUserPlanByEmail(email, plan) {
  const stmt = db.prepare(`
    UPDATE users
    SET plan = ?, updated_at = CURRENT_TIMESTAMP
    WHERE email = ?
  `);
  return stmt.run(plan, email);
}

export function getUserByXpayCustomerId(customerId) {
  return db.prepare('SELECT * FROM users WHERE xpay_customer_id = ?').get(customerId);
}

export function getUserByXpaySubscriptionId(subscriptionId) {
  return db.prepare('SELECT * FROM users WHERE xpay_subscription_id = ?').get(subscriptionId);
}

export function getUserByXpayCheckoutId(checkoutId) {
  return db.prepare('SELECT * FROM users WHERE xpay_checkout_id = ?').get(checkoutId);
}

const USER_BILLING_COLUMNS = new Set([
  'plan',
  'lifetime_completed_orders',
  'reseller_plan',
  'orders_per_month',
  'orders_used_this_period',
  'xpay_customer_id',
  'xpay_subscription_id',
  'xpay_subscription_status',
  'xpay_subscription_plan',
  'xpay_subscription_checkout_url',
  'xpay_product',
  'xpay_plan_id',
  'xpay_current_period_end',
  'xpay_cancel_at_period_end',
  'xpay_checkout_id',
  'xpay_checkout_url',
  'xpay_intro_offer_used',
  'xpay_last_payment_status',
  'xpay_last_invoice_id',
  'xpay_last_invoice_status',
  'xpay_last_invoice_url',
  'xpay_trial_ends_at',
  'xpay_default_payment_method_id',
  'whop_membership_id',
  'whop_membership_status',
  'whop_plan_id',
  'inboxes_used',
  'inboxes_limit',
  'has_concurrent_orders'
]);

export function updateUserBillingById(id, updates = {}) {
  const entries = Object.entries(updates)
    .filter(([key, value]) => USER_BILLING_COLUMNS.has(key) && value !== undefined);

  if (!entries.length) {
    return { changes: 0 };
  }

  const assignments = entries.map(([key]) => `${key} = @${key}`).join(',\n        ');
  const values = Object.fromEntries(entries);
  values.id = id;

  const stmt = db.prepare(`
    UPDATE users
    SET ${assignments},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  return stmt.run(values);
}

// --- TENANTS ---

export function createTenant(tenant) {
  const stmt = db.prepare(`
    INSERT INTO tenants (user_id, name, domain, admin_email, admin_password, mfa_secret)
    VALUES (@user_id, @name, @domain, @admin_email, @admin_password, @mfa_secret)
  `);
  const payload = { ...tenant, mfa_secret: tenant.mfa_secret ?? null };
  return stmt.run(payload);
}

export function getTenants(userId = null) {
  if (!userId) {
    return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  }
  return db.prepare('SELECT * FROM tenants WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getTenantById(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

export function getTenantByIdForUser(id, userId) {
  return db.prepare('SELECT * FROM tenants WHERE id = ? AND user_id = ?').get(id, userId);
}

export function updateTenantCloudflare(id, zoneId, nameServers) {
  const stmt = db.prepare(`
    UPDATE tenants
    SET cloudflare_zone_id = ?, cloudflare_ns = ?
    WHERE id = ?
  `);
  return stmt.run(zoneId, JSON.stringify(nameServers || []), id);
}

export function updateTenantId(id, tenantId) {
  const stmt = db.prepare(`
    UPDATE tenants
    SET tenant_id = ?, status = 'pending_ns'
    WHERE id = ?
  `);
  return stmt.run(tenantId, id);
}

export function updateTenantStatus(id, status) {
  const stmt = db.prepare('UPDATE tenants SET status = ? WHERE id = ?');
  return stmt.run(status, id);
}

export function updateTenantDetails(id, updates = {}) {
  const {
    name = null,
    domain = null,
    admin_email = null,
    admin_password = null,
    mfa_secret = undefined
  } = updates;
  const stmt = db.prepare(`
    UPDATE tenants
    SET name = COALESCE(?, name),
        domain = COALESCE(?, domain),
        admin_email = COALESCE(?, admin_email),
        admin_password = COALESCE(?, admin_password),
        mfa_secret = COALESCE(?, mfa_secret)
    WHERE id = ?
  `);
  return stmt.run(name, domain, admin_email, admin_password, mfa_secret, id);
}

export function updateTenantRedirect(id, redirectUrl) {
  const stmt = db.prepare('UPDATE tenants SET redirect_url = ? WHERE id = ?');
  return stmt.run(redirectUrl, id);
}

export function getRedirectableDomains(userId) {
  return db.prepare(`
    SELECT
      tenants.id AS tenant_id,
      tenants.domain,
      tenants.redirect_url,
      tenants.cloudflare_zone_id,
      tenants.cloudflare_ns,
      COUNT(orders.id) AS completed_orders
    FROM tenants
    JOIN orders ON orders.tenant_id = tenants.id
    WHERE tenants.user_id = ?
      AND orders.status = 'completed'
      AND tenants.domain IS NOT NULL
      AND tenants.domain != ''
    GROUP BY tenants.id
    ORDER BY MAX(orders.updated_at) DESC, tenants.created_at DESC
  `).all(userId);
}

export function deleteTenant(id) {
  // Remove related orders/logs first to avoid FK issues
  db.prepare('DELETE FROM order_logs WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)').run(id);
  db.prepare('DELETE FROM orders WHERE tenant_id = ?').run(id);
  return db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

// --- ORDERS ---

export function createOrder(tenantId, totalMailboxes = 100, mailboxPassword = null, orderName = null, userId = null, mailboxNames = null) {
  const mailboxNamesJson = Array.isArray(mailboxNames) && mailboxNames.length
    ? JSON.stringify(mailboxNames)
    : null;
  const stmt = db.prepare(`
    INSERT INTO orders (tenant_id, total_mailboxes, mailbox_password, order_name, user_id, mailbox_names)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(tenantId, totalMailboxes, mailboxPassword, orderName, userId, mailboxNamesJson);
  return result.lastInsertRowid;
}

export function getOrders(userId = null) {
  if (!userId) {
    return db.prepare(`
      SELECT orders.*, tenants.domain AS tenant_domain, tenants.name AS tenant_name
      FROM orders
      JOIN tenants ON orders.tenant_id = tenants.id
      ORDER BY orders.created_at DESC
    `).all();
  }
  return db.prepare(`
    SELECT orders.*, tenants.domain AS tenant_domain, tenants.name AS tenant_name
    FROM orders
    JOIN tenants ON orders.tenant_id = tenants.id
    WHERE orders.user_id = ?
    ORDER BY orders.created_at DESC
  `).all(userId);
}

export function getOrderById(id) {
  return db.prepare(`
    SELECT orders.*, tenants.domain AS tenant_domain, tenants.name AS tenant_name,
           tenants.admin_email, tenants.admin_password, tenants.tenant_id AS ms_tenant_id, tenants.status AS tenant_status
    FROM orders
    JOIN tenants ON orders.tenant_id = tenants.id
    WHERE orders.id = ?
  `).get(id);
}

export function getOrderByIdForUser(id, userId) {
  return db.prepare(`
    SELECT orders.*, tenants.domain AS tenant_domain, tenants.name AS tenant_name,
           tenants.admin_email, tenants.admin_password, tenants.tenant_id AS ms_tenant_id, tenants.status AS tenant_status
    FROM orders
    JOIN tenants ON orders.tenant_id = tenants.id
    WHERE orders.id = ? AND orders.user_id = ?
  `).get(id, userId);
}

export function updateOrderStatus(id, status) {
  const existing = db.prepare('SELECT id, user_id, status FROM orders WHERE id = ?').get(id);
  const stmt = db.prepare(`
    UPDATE orders
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const result = stmt.run(status, id);

  if (
    result.changes > 0
    && status === 'completed'
    && existing?.status !== 'completed'
    && existing?.user_id
  ) {
    db.prepare(`
      UPDATE users
      SET lifetime_completed_orders = COALESCE(lifetime_completed_orders, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(existing.user_id);

    // Quota tracking for non-reseller users
    const user = db.prepare('SELECT reseller_plan, orders_per_month, orders_used_this_period FROM users WHERE id = ?').get(existing.user_id);
    if (user && !user.reseller_plan && user.orders_per_month) {
      db.prepare('UPDATE users SET orders_used_this_period = COALESCE(orders_used_this_period, 0) + 1 WHERE id = ?').run(existing.user_id);
    }
  }

  return result;
}

export function updateOrderProgress(id, progress, createdMailboxes = null) {
  const stmt = db.prepare(`
    UPDATE orders
    SET progress = ?, created_mailboxes = COALESCE(?, created_mailboxes), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const mailboxesJson = createdMailboxes ? JSON.stringify(createdMailboxes) : null;
  return stmt.run(progress, mailboxesJson, id);
}

export function setOrderError(id, message) {
  const stmt = db.prepare(`
    UPDATE orders
    SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(message, id);
}

export function clearOrderError(id) {
  return db.prepare(`
    UPDATE orders
    SET error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

export function deleteOrder(id) {
  db.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
  return db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

// --- LOGS ---

export function addOrderLog(orderId, message, timestamp = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO order_logs (order_id, timestamp, message)
    VALUES (?, ?, ?)
  `);
  return stmt.run(orderId, timestamp, message);
}

export function getOrderLogs(orderId) {
  return db.prepare(`
    SELECT timestamp, message FROM order_logs
    WHERE order_id = ?
    ORDER BY id ASC
  `).all(orderId);
}

// --- TENANT PURCHASES ---

export function createTenantPurchaseRecord(record) {
  const stmt = db.prepare(`
    INSERT INTO tenant_purchases (
      user_id,
      tenant_type,
      quantity,
      amount_cents,
      currency,
      status,
      xpay_checkout_id,
      xpay_charge_id,
      xpay_customer_id,
      error_message
    )
    VALUES (
      @user_id,
      @tenant_type,
      @quantity,
      @amount_cents,
      COALESCE(@currency, 'usd'),
      COALESCE(@status, 'pending'),
      @xpay_checkout_id,
      @xpay_charge_id,
      @xpay_customer_id,
      @error_message
    )
  `);

  return stmt.run({
    user_id: record.user_id,
    tenant_type: record.tenant_type,
    quantity: record.quantity,
    amount_cents: record.amount_cents,
    currency: record.currency || 'usd',
    status: record.status || 'pending',
    xpay_checkout_id: record.xpay_checkout_id || null,
    xpay_charge_id: record.xpay_charge_id || null,
    xpay_customer_id: record.xpay_customer_id || null,
    error_message: record.error_message || null
  });
}

const TENANT_PURCHASE_COLUMNS = new Set([
  'status',
  'xpay_checkout_id',
  'xpay_charge_id',
  'xpay_customer_id',
  'error_message'
]);

function updateTenantPurchase(whereColumn, whereValue, updates = {}) {
  const entries = Object.entries(updates)
    .filter(([key, value]) => TENANT_PURCHASE_COLUMNS.has(key) && value !== undefined);

  if (!entries.length) {
    return { changes: 0 };
  }

  const assignments = entries.map(([key]) => `${key} = @${key}`).join(',\n        ');
  const values = Object.fromEntries(entries);
  values.whereValue = whereValue;

  const stmt = db.prepare(`
    UPDATE tenant_purchases
    SET ${assignments},
        updated_at = CURRENT_TIMESTAMP
    WHERE ${whereColumn} = @whereValue
  `);
  return stmt.run(values);
}

export function updateTenantPurchaseByCheckoutSession(sessionId, updates = {}) {
  return updateTenantPurchase('xpay_checkout_id', sessionId, updates);
}

export function updateTenantPurchaseByPaymentIntent(paymentIntentId, updates = {}) {
  return updateTenantPurchase('xpay_charge_id', paymentIntentId, updates);
}

export function getTenantPurchaseByCheckoutSession(sessionId) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE xpay_checkout_id = ?').get(sessionId);
}

export function getTenantPurchaseByPaymentIntent(paymentIntentId) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE xpay_charge_id = ?').get(paymentIntentId);
}

export function validateApiKeyForUser(keyHash) {
  const row = db.prepare('SELECT user_id FROM api_keys WHERE key_hash = ?').get(keyHash);
  return row ? row.user_id : null;
}

export function createApiKey(userId, keyHash) {
  db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO api_keys (user_id, key_hash) VALUES (?, ?)').run(userId, keyHash);
}

export function getApiKey(userId) {
  return db.prepare('SELECT created_at, last_used_at FROM api_keys WHERE user_id = ?').get(userId);
}

export function deleteApiKey(userId) {
  return db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
}

export function touchApiKey(userId) {
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE user_id = ?").run(userId);
}

// --- RESELLER API QUOTA ---

export function isResellerPlan(userId) {
  const user = db.prepare('SELECT reseller_plan FROM users WHERE id = ?').get(userId);
  return Boolean(user?.reseller_plan);
}

export function getAvailableOrders(userId) {
  const user = db.prepare('SELECT reseller_plan, orders_per_month, orders_used_this_period FROM users WHERE id = ?').get(userId);
  if (!user) return 0;
  if (user.reseller_plan) return Number.POSITIVE_INFINITY;
  const remaining = (user.orders_per_month || 0) - (user.orders_used_this_period || 0);
  return Math.max(0, remaining);
}

export function incrementOrdersUsed(userId) {
  db.prepare('UPDATE users SET orders_used_this_period = COALESCE(orders_used_this_period, 0) + 1 WHERE id = ?').run(userId);
}

export function resetOrdersUsed(userId) {
  db.prepare('UPDATE users SET orders_used_this_period = 0 WHERE id = ?').run(userId);
}

export default db;
