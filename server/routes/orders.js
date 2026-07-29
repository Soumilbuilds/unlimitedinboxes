import { Router } from 'express';
import {
 createOrder,
 getOrders,
 getOrderById,
 getOrderByIdForUser,
 getTenantByIdForUser,
 getTenants,
 getUserByEmail,
 updateOrderStatus,
 addOrderLog,
 deleteOrder,
 getOrderLogs as getStoredLogs,
 updateUserBillingById
} from '../db/database.js';
import { xpay, PLANS } from '../services/xpay.js';
import { getUserAccessState } from '../services/access.js';
import { processOrder, cancelOrder, getOrderLogs, hasActiveJob } from '../services/orderProcessor.js';
import { validateApiKey } from '../services/apiKey.js';

const router = Router();

function isValidMailboxPassword(password) {
 if (typeof password !== 'string') return false;
 if (password.length < 8 || password.length > 256) return false;
 let categories = 0;
 if (/[A-Z]/.test(password)) categories += 1;
 if (/[a-z]/.test(password)) categories += 1;
 if (/[0-9]/.test(password)) categories += 1;
 if (/[^A-Za-z0-9]/.test(password)) categories += 1;
 return categories >= 3;
}

function parseMailboxNames(input) {
 if (!input) return null;
 if (Array.isArray(input)) {
 return input
 .map(item => (typeof item === 'string' ? item.trim() : ''))
 .filter(Boolean)
 .map(item => item.replace(/\s+/g, ' '));
 }
 if (typeof input === 'string') {
 return input
 .split(/\r?\n/)
 .map(line => line.trim())
 .filter(Boolean)
 .map(line => line.replace(/\s+/g, ' '));
 }
 return null;
}

function isValidFullName(name) {
 if (!name || typeof name !== 'string') return false;
 const parts = name.trim().split(/\s+/);
 return parts.length >= 2;
}

const requireAuth = async (req, res, next) => {
 const apiKey = req.headers['x-api-key'];
 if (apiKey) {
 const user = await validateApiKey(apiKey);
 if (!user) {
 return res.status(401).json({ error: 'Invalid API key' });
 }
 req.session.user = user;
 req.session.authenticated = true;
 } else if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 next();
};

router.use(requireAuth);
router.use(async (req, _res, next) => {
 if (req.session.user?.email) {
 const latest = getUserByEmail(req.session.user.email);
 if (latest) {
 req.session.user.plan = latest.plan || 'free';
 req.session.user.id = latest.id;
 req.session.user.billingStatus = latest.xpay_subscription_status || null;
 req.accessState = getUserAccessState(latest);
 }
 } else if (req.session.user?.id) {
 req.accessState = getUserAccessState(req.session.user);
 }
 next();
});

function maskEmail(email) {
 if (!email || typeof email !== 'string') return email;
 const parts = email.split('@');
 if (parts.length < 2) return email;
 const local = parts[0];
 const domain = parts.slice(1).join('@');
 if (!local) return email;
 const first = local[0] || '';
 const last = local.length > 1 ? local[local.length - 1] : local[0];
 return `${first}****${last}@${domain}`;
}

function maskEmailsInText(text) {
 if (!text) return text;
 return String(text).replace(
 /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
 match => maskEmail(match)
 );
}

function maskName(name) {
 if (!name) return name;
 const trimmed = String(name).trim();
 if (trimmed.length <= 2) return trimmed;
 const first = trimmed[0] || '';
 const last = trimmed[trimmed.length - 1] || first;
 return `${first}*****${last}`;
}

function normalizeTenantIdentityValue(value) {
 return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isSameTenantIdentity(left, right) {
 if (!left || !right) return false;

 const leftTenantId = normalizeTenantIdentityValue(left.tenant_id || left.ms_tenant_id);
 const rightTenantId = normalizeTenantIdentityValue(right.tenant_id || right.ms_tenant_id);
 if (leftTenantId && rightTenantId && leftTenantId === rightTenantId) {
 return true;
 }

 const leftAdminEmail = normalizeTenantIdentityValue(left.admin_email);
 const rightAdminEmail = normalizeTenantIdentityValue(right.admin_email);
 return Boolean(leftAdminEmail && rightAdminEmail && leftAdminEmail === rightAdminEmail);
}

function getOrdersForSameTenantIdentity(userId, tenantLike) {
 if (!tenantLike) return [];

 const tenantIds = new Set(
 getTenants(userId)
 .filter(candidate => isSameTenantIdentity(candidate, tenantLike))
 .map(candidate => candidate.id)
 );

 if (!tenantIds.size && tenantLike.id != null) {
 tenantIds.add(tenantLike.id);
 }

 return getOrders(userId)
 .filter(order => tenantIds.has(order.tenant_id) && order.status !== 'cancelled')
 .sort((left, right) => left.id - right.id);
}

function buildTenantConflictMessage(existingOrder, tenantLike) {
 const targetDomain = tenantLike?.domain || tenantLike?.tenant_domain || 'this domain';
 const existingDomain = existingOrder?.tenant_domain || 'another domain';
 return `This Microsoft tenant is already attached to order #${existingOrder.id} for ${existingDomain}. Use a different Microsoft tenant for ${targetDomain}, or restart the existing order instead of creating another one.`;
}

function billingRequiredPayload(accessState, actionLabel) {
 const blockingReason = accessState.blockingReason
 || (accessState.hasBillingIssue
 ? 'payment_overdue'
 : (accessState.needsIntroOffer ? 'needs_intro_offer' : 'needs_paid_subscription'));
 const recommendedCheckoutIntent = accessState.recommendedCheckoutIntent
 || (blockingReason === 'payment_overdue'
 ? 'retry'
 : (blockingReason === 'needs_intro_offer' ? 'intro' : 'standard'));

 let error = `No active trial or subscription found. Start checkout before ${actionLabel}.`;
 if (blockingReason === 'needs_intro_offer') {
 error = `Free trial not found. Start the introductory checkout before ${actionLabel}.`;
 } else if (blockingReason === 'payment_overdue') {
 error = 'A payment is overdue. Pay the open invoice to restore access.';
 }

 return {
 code: 'BILLING_REQUIRED',
 blockingReason,
 recommendedCheckoutIntent,
 error,
 };
}

function sanitizeImplementationText(text) {
 if (!text) return text;
 let output = String(text);

 output = output.replace(/\bshared mailbox\b/gi, 'mailbox');
 output = output.replace(/\bExchange PowerShell\b/gi, 'automatic recovery');
 output = output.replace(/Mailbox API create unavailable; falling back to UI flow \(\d+\)\.?/gi, 'Retrying mailbox creation...');
 output = output.replace(/Mailbox setup screen did not open cleanly \(attempt \d+\/\d+\)\. Reloading Exchange page\.\.\./gi, 'Mailbox setup screen did not open cleanly. Retrying...');
 output = output.replace(/Shared mailbox dialog did not open cleanly \(attempt \d+\/\d+\)\. Reloading Exchange page\.\.\./gi, 'Mailbox setup screen did not open cleanly. Retrying...');
 output = output.replace(/Browser mailbox creation did not complete\.[^.]*$/gi, 'Mailbox creation did not complete in the browser. Trying an automatic recovery step...');
 output = output.replace(/Exchange PowerShell created or confirmed [^\s]+/gi, 'Automatic recovery created or confirmed the mailbox.');
 output = output.replace(/Exchange PowerShell mailbox creation failed[^:]*:\s*.+$/gi, 'Automatic recovery is currently unavailable.');
 output = output.replace(/spawn pwsh ENOENT/gi, 'automatic recovery is currently unavailable');
 output = output.replace(/Create mailbox error:\s*Waiting for selector `[^`]+` failed: Waiting failed: \d+ms exceeded/gi, 'Mailbox setup screen did not load in time.');
 output = output.replace(/Preflight failed during mailbox creation:\s*Waiting for selector `[^`]+` failed: Waiting failed: \d+ms exceeded/gi, 'Mailbox setup screen did not load in time. Please try again.');
 output = output.replace(/Preflight failed during mailbox creation:\s*Mailbox setup screen did not load in time\./gi, 'Mailbox setup screen did not load in time. Please try again.');
 output = output.replace(/Mailbox creation action not found/gi, 'Mailbox creation action was not available in Microsoft 365.');
 output = output.replace(/Email authentication setup failed:\s*DKIM setup failed:\s*/gi, '');
 output = output.replace(/DKIM setup failed:\s*/gi, '');
 output = output.replace(/\|Microsoft\.Exchange\.Management\.Tasks\.ValidationException\|/gi, '');
 output = output.replace(/CNAME record does not exist for this config\.[\s\S]*?Return and retry this step later\./gi, 'DKIM signing is not ready in Microsoft yet. Inboxes are ready to download, and DKIM can be enabled later in Microsoft Defender.');
 output = output.replace(/"DiagnosticContext":"[^"]*"/gi, '');
 output = output.replace(/"Time":"[^"]*"/gi, '');
 output = output.replace(/"ExceptionType":"[^"]*"/gi, '');
 output = output.replace(/\{?\s*"Message":"([^"]+)".*$/gi, '$1');
 output = output.replace(/\s+/g, ' ').trim();

 return output;
}

function maskNamesInText(text) {
 if (!text) return text;
 let output = String(text);

 output = output.replace(/(Creating:\s*)([^()]+)(\s*\()/gi, (_m, prefix, name, suffix) => {
 return `${prefix}${maskName(name)}${suffix}`;
 });

 output = output.replace(/(Creating mailbox\s+)([^.]+)(\.\.\.)/gi, (_m, prefix, name, suffix) => {
 return `${prefix}${maskName(name)}${suffix}`;
 });

 output = output.replace(/(Creating mailbox:\s*)(.+)$/gi, (_m, prefix, name) => {
 return `${prefix}${maskName(name)}`;
 });

 return output;
}

function maskSensitiveText(text) {
 return sanitizeImplementationText(maskEmailsInText(maskNamesInText(text)));
}

function maybeMaskOrder(order, accessState) {
 if (!order) return order;
 if (accessState?.canDownloadAll) {
 return {
 ...order,
 error_message: sanitizeImplementationText(order.error_message)
 };
 }
 const created = Array.isArray(order.created_mailboxes) ? order.created_mailboxes : [];
 return {
 ...order,
 error_message: maskSensitiveText(order.error_message),
 created_mailboxes: created.map((m, idx) => {
 if (accessState?.canDownloadAll) {
 return m;
 }
 return {
 ...m,
 name: m?.name ? maskName(m.name) : m?.name,
 email: '',
 password: ''
 };
 })
 };
}

router.get('/', (req, res) => {
 try {
 const orders = getOrders(req.session.user.id);
 const accessState = req.accessState || getUserAccessState(req.session.user);
 res.json(orders.map(order => maybeMaskOrder({
 ...order,
 created_mailboxes: JSON.parse(order.created_mailboxes || '[]')
 }, accessState)));
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.post('/', async (req, res) => {
 try {
 const { tenant_id, total_mailboxes, mailbox_password, order_name, mailbox_names } = req.body;
 if (!tenant_id) return res.status(400).json({ error: 'Tenant ID is required' });
 if (!isValidMailboxPassword(mailbox_password)) {
 return res.status(400).json({
 error: 'Password must be 8-256 chars and include at least 3 of: uppercase, lowercase, number, symbol.'
 });
 }

 const tenant = getTenantByIdForUser(tenant_id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

 const sameTenantOrders = getOrdersForSameTenantIdentity(req.session.user.id, tenant);
 if (sameTenantOrders.length > 0) {
 return res.status(409).json({
 code: 'TENANT_ALREADY_USED',
 error: buildTenantConflictMessage(sameTenantOrders[0], tenant)
 });
 }

 const accessState = req.accessState || getUserAccessState(req.session.user);
 if (!accessState.canAccessApp) {
 return res.status(403).json(billingRequiredPayload(accessState, 'creating an order'));
 }

 if (!accessState.canCreateInbox) {
 const user = req.session.user;
 if (user.xpay_pm_id && user.xpay_customer_id) {
 const currentPlan = user.xpay_subscription_plan || 'free';
 let nextPlanKey = 'starter';
 if (currentPlan === 'starter') nextPlanKey = 'growth';
 else if (currentPlan === 'growth') nextPlanKey = 'unlimited';
 
 if (nextPlanKey !== currentPlan && nextPlanKey !== 'free') {
 try {
 const nextPlan = PLANS[nextPlanKey];
 const result = await xpay.request('POST', '/payments/charge-tokenised-pm', {
 customer_id: user.xpay_customer_id,
 pm_id: user.xpay_pm_id,
 amount: nextPlan.amountCents,
 currency: 'USD',
 description: `Upgrade to ${nextPlan.name} Plan`,
 });
 
 if (result?.success !== false && result?.status !== 'failed') {
 updateUserBillingById(user.id, {
 xpay_subscription_plan: nextPlanKey,
 plan: nextPlanKey,
 xpay_subscription_status: 'active',
 xpay_trial_ends_at: null
 });
 user.xpay_subscription_plan = nextPlanKey;
 user.plan = nextPlanKey;
 user.xpay_subscription_status = 'active';
 req.accessState = getUserAccessState(user);
 accessState = req.accessState;
 } else {
 return res.status(402).json({
 code: 'PAYMENT_FAILED',
 error: `Your card on file failed to charge for the ${nextPlan.name} upgrade. Please pay the invoice to continue.`,
 reason: result?.message || 'Card declined'
 });
 }
 } catch (err) {
 return res.status(402).json({
 code: 'PAYMENT_FAILED',
 error: `Failed to charge for the ${nextPlanKey} upgrade. Please pay the invoice.`,
 reason: err.message
 });
 }
 } else {
 return res.status(403).json({
 code: 'INBOX_LIMIT_REACHED',
 error: `You have reached your plan's inbox limit (${accessState.inboxesLimit}). Upgrade your plan for more inboxes.`
 });
 }
 } else {
 return res.status(403).json({
 code: 'INBOX_LIMIT_REACHED',
 error: `You have reached your plan's inbox limit (${accessState.inboxesLimit}). Upgrade your plan for more inboxes.`
 });
 }
 }

 const safeName = typeof order_name === 'string' && order_name.trim() ? order_name.trim() : null;
 const mailboxTotal = total_mailboxes || 100;
 const parsedNames = parseMailboxNames(mailbox_names);

 if (parsedNames && !accessState.canUseCustomNames) {
 return res.status(403).json({ error: 'Custom mailbox names are available only on Growth and Unlimited plans.' });
 }

 if (parsedNames) {
 if (parsedNames.length !== mailboxTotal) {
 return res.status(400).json({ error: `Please provide exactly ${mailboxTotal} full names (one per line).` });
 }
 const invalid = parsedNames.find(name => !isValidFullName(name));
 if (invalid) {
 return res.status(400).json({ error: 'Each line must include a first and last name.' });
 }
 }

 const orderId = createOrder(
 tenant_id,
 mailboxTotal,
 mailbox_password,
 safeName,
 req.session.user.id,
 parsedNames
 );
 const order = getOrderById(orderId);

 res.status(201).json({
 ...order,
 created_mailboxes: []
 });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.post('/:id/start', (req, res) => {
 try {
 const order = getOrderByIdForUser(parseInt(req.params.id, 10), req.session.user.id);
 if (!order) return res.status(404).json({ error: 'Order not found' });
 const earlierSameTenantOrder = getOrdersForSameTenantIdentity(req.session.user.id, order)
 .find(existing => existing.id !== order.id && existing.id < order.id);
 if (earlierSameTenantOrder) {
 return res.status(409).json({
 code: 'TENANT_ALREADY_USED',
 error: buildTenantConflictMessage(earlierSameTenantOrder, order)
 });
 }
 const accessState = req.accessState || getUserAccessState(req.session.user);

 if (!accessState.canAccessApp) {
 return res.status(403).json(billingRequiredPayload(accessState, 'processing an order'));
 }

 if (!accessState.canCreateMoreThanOneCompletedOrder) {
 const hasCompleted = getOrders(req.session.user.id).some(existing => existing.status === 'completed');
 if (hasCompleted) {
 return res.status(403).json({
 code: 'ORDER_LIMIT_REACHED',
 error: 'This account has already used its included completed order. Upgrade to continue.'
 });
 }
 }

 if (order.status === 'processing') {
 if (hasActiveJob(order.id)) {
 return res.status(400).json({ error: 'Order is already processing' });
 }

 processOrder(order.id);
 return res.json({ success: true, message: 'Processing resumed' });
 }

 const processingOrders = getOrders(req.session.user.id)
 .filter(existing => existing.id !== order.id && existing.status === 'processing');
 if (accessState.maxConcurrentOrders !== Number.POSITIVE_INFINITY
 && processingOrders.length >= accessState.maxConcurrentOrders) {
 return res.status(409).json({
 code: 'ORDER_CONCURRENCY_LIMIT',
 error: `Only ${accessState.maxConcurrentOrders} order(s) can be processed at a time on the current plan.`
 });
 }

 updateOrderStatus(order.id, 'processing');
 processOrder(order.id);

 res.json({ success: true, message: 'Processing started' });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.post('/:id/cancel', (req, res) => {
 try {
 const order = getOrderByIdForUser(parseInt(req.params.id, 10), req.session.user.id);
 if (!order) return res.status(404).json({ error: 'Order not found' });
 if (!['processing', 'pending'].includes(order.status)) {
 return res.status(400).json({ error: 'Order is not being processed' });
 }
 const success = cancelOrder(order.id);
 if (success) return res.json({ success: true, message: 'Order cancelled' });
 updateOrderStatus(order.id, 'cancelled');
 addOrderLog(order.id, 'Order cancelled by user (no active job found).');
 res.json({ success: true, message: 'Order cancelled' });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.delete('/:id', (req, res) => {
 try {
 const order = getOrderByIdForUser(parseInt(req.params.id, 10), req.session.user.id);
 if (!order) return res.status(404).json({ error: 'Order not found' });

 if (order.status === 'processing') {
 return res.status(400).json({ error: 'Cannot delete order that is being processed' });
 }
 if (hasActiveJob(order.id)) {
 return res.status(400).json({ error: 'Cannot delete order while its background job is still active. Please wait a few seconds after cancelling.' });
 }

 deleteOrder(order.id);
 res.json({ success: true });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.get('/:id/logs', (req, res) => {
 try {
 const orderId = parseInt(req.params.id, 10);
 const order = getOrderByIdForUser(orderId, req.session.user.id);
 if (!order) return res.status(404).json({ error: 'Order not found' });
 const accessState = req.accessState || getUserAccessState(req.session.user);
 const inMemory = getOrderLogs(orderId);
 if (inMemory) {
 const mapped = accessState.canDownloadAll
 ? inMemory
 : inMemory.map(entry => ({ ...entry, message: maskSensitiveText(entry.message) }));
 return res.json(mapped);
 }

 const stored = getStoredLogs(orderId);
 const mapped = accessState.canDownloadAll
 ? stored
 : stored.map(entry => ({ ...entry, message: maskSensitiveText(entry.message) }));
 res.json(mapped);
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

export default router;
