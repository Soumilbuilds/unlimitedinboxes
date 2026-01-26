import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, 'app.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    admin_password TEXT NOT NULL,
    tenant_id TEXT,
    cloudflare_zone_id TEXT,
    cloudflare_ns TEXT,
    status TEXT DEFAULT 'pending_consent',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    total_mailboxes INTEGER DEFAULT 100,
    mailbox_password TEXT,
    created_mailboxes TEXT DEFAULT '[]',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
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

ensureOrdersPasswordColumn();

// --- TENANTS ---

export function createTenant(tenant) {
  const stmt = db.prepare(`
    INSERT INTO tenants (name, domain, admin_email, admin_password)
    VALUES (@name, @domain, @admin_email, @admin_password)
  `);
  return stmt.run(tenant);
}

export function getTenants() {
  return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
}

export function getTenantById(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
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

export function deleteTenant(id) {
  // Remove related orders/logs first to avoid FK issues
  db.prepare('DELETE FROM order_logs WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)').run(id);
  db.prepare('DELETE FROM orders WHERE tenant_id = ?').run(id);
  return db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

// --- ORDERS ---

export function createOrder(tenantId, totalMailboxes = 100, mailboxPassword = null) {
  const stmt = db.prepare(`
    INSERT INTO orders (tenant_id, total_mailboxes, mailbox_password)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(tenantId, totalMailboxes, mailboxPassword);
  return result.lastInsertRowid;
}

export function getOrders() {
  return db.prepare(`
    SELECT orders.*, tenants.domain AS tenant_domain, tenants.name AS tenant_name
    FROM orders
    JOIN tenants ON orders.tenant_id = tenants.id
    ORDER BY orders.created_at DESC
  `).all();
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
