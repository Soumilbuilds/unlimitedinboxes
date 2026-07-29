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

 ensureColumn('users', 'xpay_customer_id', 'TEXT');
 ensureColumn('users', 'xpay_subscription_id', 'TEXT');
 ensureColumn('users', 'xpay_subscription_status', 'TEXT');
 ensureColumn('users', 'xpay_subscription_plan', 'TEXT');
 ensureColumn('users', 'xpay_pm_id', 'TEXT');
 ensureColumn('users', 'xpay_payment_method_status', 'TEXT');
 ensureColumn('users', 'xpay_trial_ends_at', 'TEXT');
 ensureColumn('users', 'xpay_last_payment_status', 'TEXT');

 ensureColumn('users', 'inboxes_used', 'INTEGER DEFAULT 0');
 ensureColumn('users', 'inboxes_limit', 'INTEGER DEFAULT 0');
 ensureColumn('users', 'has_concurrent_orders', 'INTEGER DEFAULT 0');
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

const USER_BILLING_COLUMNS = new Set([
 'plan',
 'lifetime_completed_orders',
 'xpay_customer_id',
 'xpay_subscription_id',
 'xpay_subscription_status',
 'xpay_subscription_plan',
 'xpay_pm_id',
 'xpay_payment_method_status',
 'xpay_trial_ends_at',
 'xpay_last_payment_status',
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

 const assignments = entries.map(([key]) => `${key} = @${key}`).join(',\n ');
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
 return stmt.run(tenant);
}

export function getTenantsByUserId(userId) {
 return db.prepare('SELECT * FROM tenants WHERE user_id = ?').all(userId);
}

export function getTenantById(id) {
 return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

export function updateTenant(id, updates) {
 const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
 if (!entries.length) return { changes: 0 };
 const setClause = entries.map(([k]) => `${k} = @${k}`).join(', ');
 const values = Object.fromEntries(entries);
 values.id = id;
 return db.prepare(`UPDATE tenants SET ${setClause} WHERE id = @id`).run(values);
}

export function deleteTenant(id) {
 return db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

// --- ORDERS ---

export function createOrder(order) {
 const stmt = db.prepare(`
 INSERT INTO orders (tenant_id, user_id, order_name, status, total_mailboxes, mailbox_password, mailbox_names, created_mailboxes)
 VALUES (@tenant_id, @user_id, @order_name, @status, @total_mailboxes, @mailbox_password, @mailbox_names, @created_mailboxes)
 `);
 return stmt.run(order);
}

export function getOrdersByUserId(userId) {
 return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getOrderById(id) {
 return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

export function getOrdersByTenantId(tenantId) {
 return db.prepare('SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

export function updateOrder(id, updates) {
 const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
 if (!entries.length) return { changes: 0 };
 const setClause = entries.map(([k]) => `${k} = @${k}`).join(', ');
 const values = Object.fromEntries(entries);
 values.id = id;
 return db.prepare(`UPDATE orders SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run(values);
}

export function deleteOrder(id) {
 return db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

export function addOrderLog(orderId, message) {
 return db.prepare('INSERT INTO order_logs (order_id, message) VALUES (?, ?)').run(orderId, message);
}

export function getOrderLogs(orderId) {
 return db.prepare('SELECT * FROM order_logs WHERE order_id = ? ORDER BY timestamp ASC').all(orderId);
}

// --- API KEYS ---

export function createApiKey(userId, keyHash) {
 const stmt = db.prepare(`
 INSERT INTO api_keys (user_id, key_hash) VALUES (?, ?)
 `);
 return stmt.run(userId, keyHash);
}

export function getApiKeyByHash(keyHash) {
 return db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
}

export function updateApiKeyLastUsed(id) {
 return db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export const touchApiKey = updateApiKeyLastUsed;
