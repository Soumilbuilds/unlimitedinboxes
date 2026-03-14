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
    whop_member_id TEXT,
    whop_membership_id TEXT,
    whop_membership_status TEXT,
    whop_renewal_period_end DATETIME,
    whop_cancel_at_period_end INTEGER DEFAULT 0,
    whop_plan_id TEXT,
    whop_last_payment_id TEXT,
    whop_last_payment_status TEXT,
    whop_last_payment_substatus TEXT,
    whop_last_invoice_id TEXT,
    whop_last_invoice_status TEXT,
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
    tenant_id TEXT,
    cloudflare_zone_id TEXT,
    cloudflare_ns TEXT,
    status TEXT DEFAULT 'pending_consent',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    order_name TEXT,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    total_mailboxes INTEGER DEFAULT 100,
    mailbox_password TEXT,
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
`);

function ensureOrdersPasswordColumn() {
  const columns = db.prepare('PRAGMA table_info(orders)').all();
  const hasPassword = columns.some(col => col.name === 'mailbox_password');
  if (!hasPassword) {
    db.prepare('ALTER TABLE orders ADD COLUMN mailbox_password TEXT').run();
  }
}

function ensureUserColumn(name, definition) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasColumn = columns.some(col => col.name === name);
  if (!hasColumn) {
    db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${definition}`).run();
  }
}

function ensureOrdersNameColumn() {
  const columns = db.prepare('PRAGMA table_info(orders)').all();
  const hasName = columns.some(col => col.name === 'order_name');
  if (!hasName) {
    db.prepare('ALTER TABLE orders ADD COLUMN order_name TEXT').run();
  }
}

function ensureTenantsUserColumn() {
  const columns = db.prepare('PRAGMA table_info(tenants)').all();
  const hasUser = columns.some(col => col.name === 'user_id');
  if (!hasUser) {
    db.prepare('ALTER TABLE tenants ADD COLUMN user_id INTEGER').run();
  }
}

function ensureOrdersUserColumn() {
  const columns = db.prepare('PRAGMA table_info(orders)').all();
  const hasUser = columns.some(col => col.name === 'user_id');
  if (!hasUser) {
    db.prepare('ALTER TABLE orders ADD COLUMN user_id INTEGER').run();
  }
}

ensureOrdersPasswordColumn();
ensureOrdersNameColumn();
ensureTenantsUserColumn();
ensureOrdersUserColumn();
ensureUserColumn('whop_member_id', 'TEXT');
ensureUserColumn('whop_membership_id', 'TEXT');
ensureUserColumn('whop_membership_status', 'TEXT');
ensureUserColumn('whop_renewal_period_end', 'DATETIME');
ensureUserColumn('whop_cancel_at_period_end', 'INTEGER DEFAULT 0');
ensureUserColumn('whop_plan_id', 'TEXT');
ensureUserColumn('whop_last_payment_id', 'TEXT');
ensureUserColumn('whop_last_payment_status', 'TEXT');
ensureUserColumn('whop_last_payment_substatus', 'TEXT');
ensureUserColumn('whop_last_invoice_id', 'TEXT');
ensureUserColumn('whop_last_invoice_status', 'TEXT');

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

export function getUserByWhopMembershipId(membershipId) {
  return db.prepare('SELECT * FROM users WHERE whop_membership_id = ?').get(membershipId);
}

export function getUserByWhopMemberId(memberId) {
  return db.prepare('SELECT * FROM users WHERE whop_member_id = ?').get(memberId);
}

export function updateUserPlanByEmail(email, plan) {
  const stmt = db.prepare(`
    UPDATE users
    SET plan = ?, updated_at = CURRENT_TIMESTAMP
    WHERE email = ?
  `);
  return stmt.run(plan, email);
}

export function updateUserBillingById(id, updates = {}) {
  const allowed = [
    'plan',
    'whop_member_id',
    'whop_membership_id',
    'whop_membership_status',
    'whop_renewal_period_end',
    'whop_cancel_at_period_end',
    'whop_plan_id',
    'whop_last_payment_id',
    'whop_last_payment_status',
    'whop_last_payment_substatus',
    'whop_last_invoice_id',
    'whop_last_invoice_status'
  ];

  const assignments = [];
  const params = { id };

  allowed.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      assignments.push(`${key} = @${key}`);
      params[key] = updates[key];
    }
  });

  if (assignments.length === 0) {
    return { changes: 0 };
  }

  assignments.push('updated_at = CURRENT_TIMESTAMP');

  const stmt = db.prepare(`
    UPDATE users
    SET ${assignments.join(', ')}
    WHERE id = @id
  `);

  return stmt.run(params);
}

// --- TENANTS ---

export function createTenant(tenant) {
  const stmt = db.prepare(`
    INSERT INTO tenants (user_id, name, domain, admin_email, admin_password)
    VALUES (@user_id, @name, @domain, @admin_email, @admin_password)
  `);
  return stmt.run(tenant);
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
  const { name = null, domain = null, admin_email = null, admin_password = null } = updates;
  const stmt = db.prepare(`
    UPDATE tenants
    SET name = COALESCE(?, name),
        domain = COALESCE(?, domain),
        admin_email = COALESCE(?, admin_email),
        admin_password = COALESCE(?, admin_password)
    WHERE id = ?
  `);
  return stmt.run(name, domain, admin_email, admin_password, id);
}

export function deleteTenant(id) {
  // Remove related orders/logs first to avoid FK issues
  db.prepare('DELETE FROM order_logs WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)').run(id);
  db.prepare('DELETE FROM orders WHERE tenant_id = ?').run(id);
  return db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

// --- ORDERS ---

export function createOrder(tenantId, totalMailboxes = 100, mailboxPassword = null, orderName = null, userId = null) {
  const stmt = db.prepare(`
    INSERT INTO orders (tenant_id, total_mailboxes, mailbox_password, order_name, user_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(tenantId, totalMailboxes, mailboxPassword, orderName, userId);
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
  const stmt = db.prepare(`
    UPDATE orders
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(status, id);
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

export default db;
