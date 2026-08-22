import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(process.env.APP_DB_PATH || join(__dirname, 'app.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

  -- The original API implementation was intentionally retired. Its keys are
  -- incompatible with the fresh developer API and must never remain usable.
  DROP TABLE IF EXISTS api_keys;

  CREATE TABLE IF NOT EXISTS developer_api_keys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    display_prefix TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    revoked_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_developer_api_keys_user
    ON developer_api_keys(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS developer_api_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    key_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    idempotency_key TEXT,
    request_hash TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    http_status INTEGER,
    response_body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(key_id) REFERENCES developer_api_keys(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_api_requests_idempotency
    ON developer_api_requests(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_developer_api_requests_user_created
    ON developer_api_requests(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS developer_api_rate_windows (
    key_id TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(key_id, window_start)
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
    request_token TEXT,
    unit_price_cents INTEGER,
    subtotal_cents INTEGER,
    discount_cents INTEGER DEFAULT 0,
    promo_code_id TEXT,
    promo_code TEXT,
    whop_checkout_id TEXT,
    whop_payment_id TEXT,
    whop_plan_id TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS managed_billing_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cycle_number INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    receipt_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    provider_intent_id TEXT UNIQUE,
    locked_at TEXT,
    lock_owner TEXT,
    last_error TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, cycle_number),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_managed_billing_cycles_due
    ON managed_billing_cycles(status, next_attempt_at, due_at);

  CREATE TABLE IF NOT EXISTS xpay_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whop_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whop_plan_changes (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    target_plan_id TEXT NOT NULL,
    source_membership_id TEXT,
    promo_code_id TEXT,
    payment_id TEXT UNIQUE,
    checkout_id TEXT UNIQUE,
    checkout_url TEXT,
    status TEXT NOT NULL,
    effective_at TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    last_error TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_whop_plan_changes_user
    ON whop_plan_changes(user_id, requested_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_whop_plan_changes_active_user
    ON whop_plan_changes(user_id)
    WHERE status IN ('created', 'pending_payment', 'awaiting_checkout', 'scheduled', 'applying', 'cleanup_pending');
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

function ensureOrdersProcessingLeaseColumns() {
  ensureColumn('orders', 'processing_token', 'TEXT');
  ensureColumn('orders', 'processing_heartbeat_at', 'TEXT');
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
  ensureColumn('users', 'xpay_billing_mode', 'TEXT');
  ensureColumn('users', 'xpay_recurring_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'xpay_next_charge_at', 'TEXT');
  ensureColumn('users', 'xpay_billing_cycle', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'xpay_billing_processing_at', 'TEXT');
  ensureColumn('users', 'xpay_cancelled_at', 'TEXT');

  ensureColumn('users', 'whop_membership_id', 'TEXT');
  ensureColumn('users', 'whop_membership_status', 'TEXT');
  ensureColumn('users', 'whop_plan_id', 'TEXT');
  ensureColumn('users', 'whop_checkout_session_id', 'TEXT');
  ensureColumn('users', 'whop_member_id', 'TEXT');
  ensureColumn('users', 'whop_payment_method_id', 'TEXT');
  ensureColumn('users', 'whop_billing_address', 'TEXT');
  ensureColumn('users', 'whop_current_period_end', 'TEXT');
  ensureColumn('users', 'whop_cancel_at_period_end', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'whop_intro_offer_used', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'whop_last_payment_status', 'TEXT');
  ensureColumn('users', 'whop_pending_plan_id', 'TEXT');
  ensureColumn('users', 'whop_pending_promo_code_id', 'TEXT');
  ensureColumn('users', 'whop_pending_payment_id', 'TEXT');
  ensureColumn('users', 'whop_plan_change_requested_at', 'TEXT');
  ensureColumn('users', 'whop_membership_event_at', 'TEXT');
  ensureColumn('users', 'whop_payment_event_at', 'TEXT');

  ensureColumn('users', 'inboxes_used', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'inboxes_limit', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'has_concurrent_orders', 'INTEGER DEFAULT 0');
}

function ensureTenantPurchasesColumns() {
  ensureColumn('tenant_purchases', 'xpay_checkout_id', 'TEXT');
  ensureColumn('tenant_purchases', 'xpay_charge_id', 'TEXT');
  ensureColumn('tenant_purchases', 'xpay_customer_id', 'TEXT');
  ensureColumn('tenant_purchases', 'request_token', 'TEXT');
  ensureColumn('tenant_purchases', 'unit_price_cents', 'INTEGER');
  ensureColumn('tenant_purchases', 'subtotal_cents', 'INTEGER');
  ensureColumn('tenant_purchases', 'discount_cents', 'INTEGER DEFAULT 0');
  ensureColumn('tenant_purchases', 'promo_code_id', 'TEXT');
  ensureColumn('tenant_purchases', 'promo_code', 'TEXT');
  ensureColumn('tenant_purchases', 'whop_checkout_id', 'TEXT');
  ensureColumn('tenant_purchases', 'whop_payment_id', 'TEXT');
  ensureColumn('tenant_purchases', 'whop_plan_id', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_purchases_request_token
      ON tenant_purchases(user_id, request_token)
      WHERE request_token IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_purchases_whop_checkout
      ON tenant_purchases(whop_checkout_id)
      WHERE whop_checkout_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_purchases_whop_payment
      ON tenant_purchases(whop_payment_id)
      WHERE whop_payment_id IS NOT NULL;
  `);
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

function backfillInboxesUsed() {
  db.prepare(`
    UPDATE users
    SET inboxes_used = (
      SELECT COALESCE(SUM(orders.total_mailboxes), 0)
      FROM orders
      WHERE orders.user_id = users.id AND orders.status = 'completed'
    )
    WHERE COALESCE(inboxes_used, 0) < (
      SELECT COALESCE(SUM(orders.total_mailboxes), 0)
      FROM orders
      WHERE orders.user_id = users.id AND orders.status = 'completed'
    )
  `).run();
}

ensureOrdersPasswordColumn();
ensureOrdersNameColumn();
ensureOrdersMailboxNamesColumn();
ensureOrdersProcessingLeaseColumns();
ensureTenantsUserColumn();
ensureTenantsRedirectColumn();
ensureTenantsMfaSecretColumn();
ensureOrdersUserColumn();
ensureUserBillingColumns();
ensureTenantPurchasesColumns();
backfillLifetimeCompletedOrders();
backfillInboxesUsed();

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

export function getUserByWhopMembershipId(membershipId) {
  return db.prepare('SELECT * FROM users WHERE whop_membership_id = ?').get(membershipId);
}

export function getUserByWhopMemberId(memberId) {
  return db.prepare('SELECT * FROM users WHERE whop_member_id = ?').get(memberId);
}

export function getUserByWhopCheckoutSessionId(sessionId) {
  return db.prepare('SELECT * FROM users WHERE whop_checkout_session_id = ?').get(sessionId);
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
  'xpay_billing_mode',
  'xpay_recurring_enabled',
  'xpay_next_charge_at',
  'xpay_billing_cycle',
  'xpay_billing_processing_at',
  'xpay_cancelled_at',
  'whop_membership_id',
  'whop_membership_status',
  'whop_plan_id',
  'whop_checkout_session_id',
  'whop_member_id',
  'whop_payment_method_id',
  'whop_billing_address',
  'whop_current_period_end',
  'whop_cancel_at_period_end',
  'whop_intro_offer_used',
  'whop_last_payment_status',
  'whop_pending_plan_id',
  'whop_pending_promo_code_id',
  'whop_pending_payment_id',
  'whop_plan_change_requested_at',
  'whop_membership_event_at',
  'whop_payment_event_at',
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

const ACTIVE_PLAN_CHANGE_STATUSES = ['created', 'pending_payment', 'awaiting_checkout', 'scheduled', 'applying', 'cleanup_pending'];
const PLAN_CHANGE_COLUMNS = new Set([
  'target_plan_id', 'source_membership_id', 'promo_code_id', 'payment_id',
  'checkout_id', 'checkout_url', 'status', 'effective_at', 'completed_at', 'last_error',
]);

export function createWhopPlanChange({ id, userId, targetPlanId, sourceMembershipId = null, promoCodeId = null }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO whop_plan_changes (
        id, user_id, target_plan_id, source_membership_id, promo_code_id,
        status, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'created', ?, ?)
    `).run(String(id), userId, String(targetPlanId), sourceMembershipId, promoCodeId, now, now);
    return getWhopPlanChangeById(id);
  })();
}

export function getWhopPlanChangeById(id) {
  return id ? db.prepare('SELECT * FROM whop_plan_changes WHERE id = ?').get(String(id)) : null;
}

export function getActiveWhopPlanChange(userId) {
  return db.prepare(`
    SELECT * FROM whop_plan_changes
    WHERE user_id = ? AND status IN (${ACTIVE_PLAN_CHANGE_STATUSES.map(() => '?').join(', ')})
    ORDER BY requested_at DESC LIMIT 1
  `).get(userId, ...ACTIVE_PLAN_CHANGE_STATUSES);
}

export function getWhopPlanChangeByPaymentId(paymentId) {
  return paymentId ? db.prepare('SELECT * FROM whop_plan_changes WHERE payment_id = ?').get(String(paymentId)) : null;
}

export function updateWhopPlanChange(id, updates = {}) {
  const entries = Object.entries(updates).filter(([key, value]) => PLAN_CHANGE_COLUMNS.has(key) && value !== undefined);
  if (!entries.length) return getWhopPlanChangeById(id);
  const values = Object.fromEntries(entries);
  values.id = String(id);
  values.updated_at = new Date().toISOString();
  db.prepare(`
    UPDATE whop_plan_changes
    SET ${entries.map(([key]) => `${key} = @${key}`).join(', ')}, updated_at = @updated_at
    WHERE id = @id
  `).run(values);
  return getWhopPlanChangeById(id);
}

export function bindWhopPlanChangePayment(id, paymentId) {
  const result = db.prepare(`
    UPDATE whop_plan_changes
    SET payment_id = ?, updated_at = ?
    WHERE id = ? AND (payment_id IS NULL OR payment_id = ?)
      AND status IN ('created', 'pending_payment', 'awaiting_checkout', 'scheduled', 'applying')
  `).run(String(paymentId), new Date().toISOString(), String(id), String(paymentId));
  return result.changes ? getWhopPlanChangeById(id) : null;
}

export function claimWhopPlanChange(id, paymentId) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE whop_plan_changes
    SET payment_id = ?, status = 'applying', updated_at = ?
    WHERE id = ? AND (payment_id IS NULL OR payment_id = ?)
      AND status IN ('created', 'pending_payment', 'awaiting_checkout', 'scheduled')
  `).run(String(paymentId), now, String(id), String(paymentId));
  return result.changes ? getWhopPlanChangeById(id) : null;
}

// --- APP-MANAGED RECURRING BILLING ---

export function enrollManagedRecurringBilling(userId, {
  firstChargeAt,
  amountCents,
  currency = 'USD',
  planKey = 'starter',
}) {
  const firstDue = new Date(firstChargeAt).toISOString();
  const receiptId = `starter_u${userId}_c1`;
  const idempotencyKey = `starter.u${userId}.c1`;

  return db.transaction(() => {
    updateUserBillingById(userId, {
      plan: 'trial',
      xpay_billing_mode: 'managed',
      xpay_recurring_enabled: 1,
      xpay_subscription_plan: planKey,
      xpay_subscription_status: 'TRIALING',
      xpay_trial_ends_at: firstDue,
      xpay_current_period_end: firstDue,
      xpay_next_charge_at: firstDue,
      xpay_billing_cycle: 0,
      xpay_cancel_at_period_end: 0,
      xpay_cancelled_at: null,
      xpay_subscription_checkout_url: null,
      inboxes_limit: 100,
    });

    db.prepare(`
      INSERT OR IGNORE INTO managed_billing_cycles (
        user_id, cycle_number, due_at, next_attempt_at, amount_cents,
        currency, receipt_id, idempotency_key, status
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      userId,
      firstDue,
      firstDue,
      amountCents,
      String(currency).toUpperCase(),
      receiptId,
      idempotencyKey
    );

    return db.prepare(
      'SELECT * FROM managed_billing_cycles WHERE user_id = ? AND cycle_number = 1'
    ).get(userId);
  })();
}

export function getManagedBillingCyclesForUser(userId) {
  return db.prepare(`
    SELECT *
    FROM managed_billing_cycles
    WHERE user_id = ?
    ORDER BY cycle_number ASC
  `).all(userId);
}

export function getManagedBillingCycleByReceiptId(receiptId) {
  return db.prepare(
    'SELECT * FROM managed_billing_cycles WHERE receipt_id = ?'
  ).get(receiptId);
}

export function getManagedBillingCycleByProviderIntentId(intentId) {
  return db.prepare(
    'SELECT * FROM managed_billing_cycles WHERE provider_intent_id = ?'
  ).get(intentId);
}

export function claimDueManagedBillingCycle({
  now,
  staleBefore,
  lockOwner,
}) {
  return db.transaction(() => {
    const cycle = db.prepare(`
      SELECT c.*
      FROM managed_billing_cycles c
      JOIN users u ON u.id = c.user_id
      WHERE COALESCE(u.xpay_recurring_enabled, 0) = 1
        AND COALESCE(u.xpay_cancel_at_period_end, 0) = 0
        AND c.due_at <= @now
        AND (
          (c.status IN ('pending', 'retry') AND c.next_attempt_at <= @now)
          OR (c.status = 'processing' AND c.locked_at < @staleBefore)
        )
      ORDER BY c.next_attempt_at ASC, c.id ASC
      LIMIT 1
    `).get({ now, staleBefore });

    if (!cycle) return null;

    const result = db.prepare(`
      UPDATE managed_billing_cycles
      SET status = 'processing',
          locked_at = @now,
          lock_owner = @lockOwner,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
        AND (
          status IN ('pending', 'retry')
          OR (status = 'processing' AND locked_at < @staleBefore)
        )
    `).run({ id: cycle.id, now, staleBefore, lockOwner });

    if (!result.changes) return null;
    return db.prepare(`
      SELECT c.*, u.xpay_customer_id, u.xpay_default_payment_method_id,
             u.xpay_recurring_enabled, u.xpay_cancel_at_period_end
      FROM managed_billing_cycles c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(cycle.id);
  })();
}

export function completeManagedBillingCycle(cycleId, {
  providerIntentId,
  paidAt,
  nextDueAt,
  intervalAmountCents,
}) {
  return db.transaction(() => {
    const cycle = db.prepare(
      'SELECT * FROM managed_billing_cycles WHERE id = ?'
    ).get(cycleId);
    if (!cycle || cycle.status === 'succeeded') return cycle;

    const paidIso = new Date(paidAt).toISOString();
    const nextDueIso = new Date(nextDueAt).toISOString();
    db.prepare(`
      UPDATE managed_billing_cycles
      SET status = 'succeeded',
          provider_intent_id = COALESCE(provider_intent_id, ?),
          paid_at = ?,
          locked_at = NULL,
          lock_owner = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(providerIntentId || null, paidIso, cycleId);

    updateUserBillingById(cycle.user_id, {
      plan: 'starter',
      xpay_billing_mode: 'managed',
      xpay_subscription_plan: 'starter',
      xpay_subscription_status: 'ACTIVE',
      xpay_last_payment_status: 'paid',
      xpay_trial_ends_at: null,
      xpay_current_period_end: nextDueIso,
      xpay_next_charge_at: nextDueIso,
      xpay_billing_cycle: cycle.cycle_number,
      xpay_billing_processing_at: null,
      inboxes_limit: 500,
    });

    const nextCycle = cycle.cycle_number + 1;
    db.prepare(`
      INSERT OR IGNORE INTO managed_billing_cycles (
        user_id, cycle_number, due_at, next_attempt_at, amount_cents,
        currency, receipt_id, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      cycle.user_id,
      nextCycle,
      nextDueIso,
      nextDueIso,
      intervalAmountCents,
      cycle.currency,
      `starter_u${cycle.user_id}_c${nextCycle}`,
      `starter.u${cycle.user_id}.c${nextCycle}`
    );

    return db.prepare(
      'SELECT * FROM managed_billing_cycles WHERE id = ?'
    ).get(cycleId);
  })();
}

export function retryManagedBillingCycle(cycleId, {
  error,
  nextAttemptAt,
  terminal = false,
  providerIntentId = null,
}) {
  return db.transaction(() => {
    const cycle = db.prepare(
      'SELECT * FROM managed_billing_cycles WHERE id = ?'
    ).get(cycleId);
    if (!cycle || cycle.status === 'succeeded') return cycle;

    const status = terminal ? 'action_required' : 'retry';
    db.prepare(`
      UPDATE managed_billing_cycles
      SET status = ?,
          attempt_count = attempt_count + 1,
          next_attempt_at = ?,
          provider_intent_id = COALESCE(provider_intent_id, ?),
          locked_at = NULL,
          lock_owner = NULL,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      new Date(nextAttemptAt).toISOString(),
      providerIntentId,
      String(error || 'Payment failed').slice(0, 1000),
      cycleId
    );

    updateUserBillingById(cycle.user_id, {
      plan: 'free',
      xpay_subscription_status: 'PAST_DUE',
      xpay_last_payment_status: 'failed',
      xpay_billing_processing_at: null,
    });

    return db.prepare(
      'SELECT * FROM managed_billing_cycles WHERE id = ?'
    ).get(cycleId);
  })();
}

export function cancelManagedRecurringBilling(userId, cancelledAt = new Date()) {
  const cancelledIso = new Date(cancelledAt).toISOString();
  return db.transaction(() => {
    updateUserBillingById(userId, {
      xpay_recurring_enabled: 0,
      xpay_cancel_at_period_end: 1,
      xpay_cancelled_at: cancelledIso,
      xpay_next_charge_at: null,
      xpay_billing_processing_at: null,
    });
    db.prepare(`
      UPDATE managed_billing_cycles
      SET status = 'cancelled',
          locked_at = NULL,
          lock_owner = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('pending', 'retry', 'processing')
    `).run(userId);
    return getUserById(userId);
  })();
}

export function recordXpayWebhookEvent(eventId, eventType) {
  if (!eventId) return true;
  const result = db.prepare(`
    INSERT OR IGNORE INTO xpay_webhook_events (event_id, event_type)
    VALUES (?, ?)
  `).run(String(eventId), String(eventType || ''));
  return result.changes > 0;
}

export function forgetXpayWebhookEvent(eventId) {
  if (!eventId) return;
  db.prepare('DELETE FROM xpay_webhook_events WHERE event_id = ?').run(String(eventId));
}

export function recordWhopWebhookEvent(eventId, eventType) {
  if (!eventId) return true;
  const result = db.prepare(`
    INSERT OR IGNORE INTO whop_webhook_events (event_id, event_type)
    VALUES (?, ?)
  `).run(String(eventId), String(eventType || ''));
  return result.changes > 0;
}

export function forgetWhopWebhookEvent(eventId) {
  if (!eventId) return;
  db.prepare('DELETE FROM whop_webhook_events WHERE event_id = ?').run(String(eventId));
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

export function createOrderWithinQuota({
  tenantId,
  totalMailboxes = 100,
  mailboxPassword = null,
  orderName = null,
  userId,
  mailboxNames = null,
  inboxesLimit = null,
}) {
  const create = db.transaction(() => {
    const requested = Number(totalMailboxes);
    if (!Number.isInteger(requested) || requested < 1) {
      const error = new Error('The mailbox quantity must be a positive integer.');
      error.code = 'INVALID_MAILBOX_QUANTITY';
      throw error;
    }
    const completed = Number(db.prepare('SELECT COALESCE(inboxes_used, 0) AS total FROM users WHERE id = ?').get(userId)?.total || 0);
    const reserved = Number(db.prepare(`
      SELECT COALESCE(SUM(total_mailboxes), 0) AS total
      FROM orders
      WHERE user_id = ? AND status NOT IN ('cancelled', 'completed')
    `).get(userId)?.total || 0);
    const committed = completed + reserved;
    if (Number.isFinite(inboxesLimit) && committed + requested > inboxesLimit) {
      const error = new Error(`This order exceeds the plan allowance. ${Math.max(0, inboxesLimit - committed)} inboxes remain.`);
      error.code = 'INBOX_LIMIT_REACHED';
      error.remaining = Math.max(0, inboxesLimit - committed);
      error.limit = inboxesLimit;
      throw error;
    }
    return createOrder(tenantId, requested, mailboxPassword, orderName, userId, mailboxNames);
  });
  return create();
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
  const existing = db.prepare('SELECT id, user_id, status, total_mailboxes FROM orders WHERE id = ?').get(id);
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
          inboxes_used = COALESCE(inboxes_used, 0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(Number(existing.total_mailboxes || 0), existing.user_id);

    // Quota tracking for non-reseller users
    const user = db.prepare('SELECT reseller_plan, orders_per_month, orders_used_this_period FROM users WHERE id = ?').get(existing.user_id);
    if (user && !user.reseller_plan && user.orders_per_month) {
      db.prepare('UPDATE users SET orders_used_this_period = COALESCE(orders_used_this_period, 0) + 1 WHERE id = ?').run(existing.user_id);
    }
  }

  return result;
}

export function claimOrderForProcessing({ orderId, userId, maxConcurrentOrders }) {
  const claim = db.transaction(() => {
    const order = db.prepare('SELECT id, status FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!order) return { claimed: false, reason: 'not_found' };
    if (!['pending', 'failed'].includes(order.status)) return { claimed: false, reason: order.status };
    const processing = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM orders
      WHERE user_id = ? AND status = 'processing' AND id != ?
    `).get(userId, orderId).count);
    if (Number.isFinite(maxConcurrentOrders) && processing >= maxConcurrentOrders) {
      return { claimed: false, reason: 'concurrency' };
    }
    const result = db.prepare(`
      UPDATE orders
      SET status = 'processing', processing_token = NULL,
          processing_heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')
    `).run(orderId, userId);
    return { claimed: result.changes === 1, reason: result.changes ? null : 'conflict' };
  });
  return claim();
}

export function acquireOrderProcessingLease(orderId, token, staleAfterSeconds = 900) {
  const safeSeconds = Math.max(60, Number(staleAfterSeconds) || 900);
  return db.prepare(`
    UPDATE orders
    SET processing_token = ?, processing_heartbeat_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'processing'
      AND (
        processing_token IS NULL
        OR processing_token = ?
        OR processing_heartbeat_at IS NULL
        OR processing_heartbeat_at < datetime('now', '-' || ? || ' seconds')
      )
  `).run(token, orderId, token, safeSeconds).changes === 1;
}

export function touchOrderProcessingLease(orderId, token) {
  return db.prepare(`
    UPDATE orders
    SET processing_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND processing_token = ?
  `).run(orderId, token);
}

export function releaseOrderProcessingLease(orderId, token) {
  return db.prepare(`
    UPDATE orders
    SET processing_token = NULL, processing_heartbeat_at = NULL
    WHERE id = ? AND processing_token = ?
  `).run(orderId, token);
}

export function persistCreatedMailboxes(id, createdMailboxes) {
  return db.prepare(`
    UPDATE orders
    SET created_mailboxes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(createdMailboxes), id);
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
      request_token,
      unit_price_cents,
      subtotal_cents,
      discount_cents,
      promo_code_id,
      promo_code,
      whop_checkout_id,
      whop_payment_id,
      whop_plan_id,
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
      @request_token,
      @unit_price_cents,
      @subtotal_cents,
      COALESCE(@discount_cents, 0),
      @promo_code_id,
      @promo_code,
      @whop_checkout_id,
      @whop_payment_id,
      @whop_plan_id,
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
    request_token: record.request_token || null,
    unit_price_cents: record.unit_price_cents ?? null,
    subtotal_cents: record.subtotal_cents ?? record.amount_cents,
    discount_cents: record.discount_cents ?? 0,
    promo_code_id: record.promo_code_id || null,
    promo_code: record.promo_code || null,
    whop_checkout_id: record.whop_checkout_id || null,
    whop_payment_id: record.whop_payment_id || null,
    whop_plan_id: record.whop_plan_id || null,
    error_message: record.error_message || null
  });
}

const TENANT_PURCHASE_COLUMNS = new Set([
  'status',
  'xpay_checkout_id',
  'xpay_charge_id',
  'xpay_customer_id',
  'whop_checkout_id',
  'whop_payment_id',
  'whop_plan_id',
  'amount_cents',
  'discount_cents',
  'promo_code_id',
  'promo_code',
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

export function getTenantPurchaseByIdForUser(id, userId) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE id = ? AND user_id = ?').get(id, userId);
}

export function getTenantPurchaseByRequestToken(userId, requestToken) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE user_id = ? AND request_token = ?').get(userId, requestToken);
}

export function getTenantPurchaseByWhopPaymentId(paymentId) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE whop_payment_id = ?').get(paymentId);
}

export function getTenantPurchaseByWhopCheckoutId(checkoutId) {
  return db.prepare('SELECT * FROM tenant_purchases WHERE whop_checkout_id = ?').get(checkoutId);
}

export function updateTenantPurchaseById(id, updates = {}) {
  return updateTenantPurchase('id', id, updates);
}

// --- DEVELOPER API ---

export function createDeveloperApiKey({ id, userId, name, secretHash, displayPrefix }) {
  const active = db.prepare(`
    SELECT COUNT(*) AS count FROM developer_api_keys
    WHERE user_id = ? AND revoked_at IS NULL
  `).get(userId);
  if (Number(active.count) >= 5) {
    const error = new Error('Revoke an existing API key before creating another one.');
    error.code = 'API_KEY_LIMIT_REACHED';
    throw error;
  }
  db.prepare(`
    INSERT INTO developer_api_keys (id, user_id, name, secret_hash, display_prefix)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, name, secretHash, displayPrefix);
  return getDeveloperApiKeyByIdForUser(id, userId);
}

export function getDeveloperApiKeyByIdForUser(id, userId) {
  return db.prepare(`
    SELECT id, name, display_prefix, created_at, last_used_at, revoked_at
    FROM developer_api_keys WHERE id = ? AND user_id = ?
  `).get(id, userId);
}

export function listDeveloperApiKeys(userId) {
  return db.prepare(`
    SELECT id, name, display_prefix, created_at, last_used_at, revoked_at
    FROM developer_api_keys WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

export function revokeDeveloperApiKey(id, userId) {
  return db.prepare(`
    UPDATE developer_api_keys SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(id, userId);
}

export function findDeveloperApiKey(secretHash) {
  return db.prepare(`
    SELECT id, user_id, name, display_prefix
    FROM developer_api_keys
    WHERE secret_hash = ? AND revoked_at IS NULL
  `).get(secretHash);
}

export function touchDeveloperApiKey(id) {
  return db.prepare(`
    UPDATE developer_api_keys SET last_used_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))
  `).run(id);
}

export function consumeDeveloperApiRateLimit(keyId, limit, now = Date.now()) {
  const windowStart = Math.floor(now / 60000) * 60000;
  const consume = db.transaction(() => {
    db.prepare('DELETE FROM developer_api_rate_windows WHERE window_start < ?').run(windowStart - 120000);
    db.prepare(`
      INSERT INTO developer_api_rate_windows (key_id, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(key_id, window_start)
      DO UPDATE SET request_count = request_count + 1
    `).run(keyId, windowStart);
    return Number(db.prepare(`
      SELECT request_count FROM developer_api_rate_windows
      WHERE key_id = ? AND window_start = ?
    `).get(keyId, windowStart).request_count);
  });
  const count = consume();
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    reset: Math.ceil((windowStart + 60000) / 1000),
  };
}

export function beginDeveloperApiRequest({ id, userId, keyId, method, path, idempotencyKey, requestHash }) {
  const begin = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id, method, path, request_hash, status, http_status, response_body
      FROM developer_api_requests
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, idempotencyKey);
    if (existing) return { existing };
    db.prepare(`
      INSERT INTO developer_api_requests
        (id, user_id, key_id, method, path, idempotency_key, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, keyId, method, path, idempotencyKey, requestHash);
    return { id };
  });
  return begin();
}

export function completeDeveloperApiRequest(id, httpStatus, responseBody, status = 'completed') {
  return db.prepare(`
    UPDATE developer_api_requests
    SET status = ?, http_status = ?, response_body = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'processing'
  `).run(status, httpStatus, String(responseBody || '').slice(0, 100000), id);
}

export function recordDeveloperApiRequest({ id, userId, keyId, method, path, httpStatus }) {
  return db.prepare(`
    INSERT INTO developer_api_requests
      (id, user_id, key_id, method, path, status, http_status, completed_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP)
  `).run(id, userId, keyId, method, path, httpStatus);
}

export function getDeveloperApiHistory(userId, limit = 20) {
  return db.prepare(`
    SELECT id, method, path, status, http_status, created_at, completed_at
    FROM developer_api_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function getReservedInboxCount(userId) {
  const completed = Number(db.prepare('SELECT COALESCE(inboxes_used, 0) AS total FROM users WHERE id = ?').get(userId)?.total || 0);
  const reserved = Number(db.prepare(`
    SELECT COALESCE(SUM(total_mailboxes), 0) AS total FROM orders
    WHERE user_id = ? AND status NOT IN ('cancelled', 'completed')
  `).get(userId)?.total || 0);
  return completed + reserved;
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
