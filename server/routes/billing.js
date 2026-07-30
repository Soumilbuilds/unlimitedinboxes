import { Router } from 'express';
import {
 getUserByEmail,
 getUserById,
 getUserByXpayCheckoutId,
 getUserByXpayCustomerId,
 getUserByXpaySubscriptionId,
 updateUserBillingById,
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import {
 xpay,
 PLANS,
 ADDON_CONCURRENT_ORDERS,
 TRIAL_DAYS,
 TRIAL_AUTH_CHARGE_CENTS,
 buildProfile,
 createOneTimeCheckout,
 createStarterSubscriptionCheckout,
 isSubscriptionActive,
 isSubscriptionPastDue,
} from '../services/xpay.js';

const router = Router();

function serializeSessionUser(user) {
 return {
 id: user.id,
 email: user.email,
 plan: user.plan || 'free',
 billingStatus: user.xpay_subscription_status || null,
 };
}

function getCurrentUser(req) {
 const id = req.session?.user?.id;
 if (id) return getUserById(id);
 if (req.session?.user?.email) return getUserByEmail(req.session.user.email);
 return null;
}

function getRequestBaseUrl(req) {
 const origin = req.get('origin');
 const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
 .split(',')
 .map((value) => value.trim())
 .filter(Boolean);

 if (
 origin
 && (allowedOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))
 ) {
 return origin;
 }

 return process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';
}

function isSuccessfulIntroIntent(intent, user, intentId) {
 const metadata = intent?.metadata || {};
 return String(intent?.intentId || intent?.xIntentId || intentId) === String(intentId)
 && String(intent?.status || '').toUpperCase() === 'SUCCESS'
 && Number(intent?.amount) === TRIAL_AUTH_CHARGE_CENTS
 && String(intent?.currency || '').toUpperCase() === 'USD'
 && String(metadata?.purpose || '') === 'trial_auth'
 && String(metadata?.user_id || '') === String(user.id);
}

function activateIntroOffer(user) {
 if (user.xpay_intro_offer_used && isSubscriptionActive(user.xpay_subscription_status)) {
 return getUserById(user.id) || user;
 }

 const trialEnd = new Date();
 trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
 updateUserBillingById(user.id, {
 plan: 'trial',
 xpay_subscription_plan: 'trial',
 xpay_subscription_status: 'TRIALING',
 xpay_trial_ends_at: trialEnd.toISOString(),
 xpay_intro_offer_used: 1,
 xpay_last_payment_status: 'paid',
 inboxes_limit: 100,
 });
 return getUserById(user.id) || user;
}

function isOwnedStarterSubscription(subscription, user, subscriptionId) {
 const metadata = subscription?.metadata || {};
 return String(subscription?.subscriptionId || subscription?.id || subscriptionId) === String(subscriptionId)
 && Number(subscription?.amount) === PLANS.starter.amountCents
 && String(subscription?.currency || '').toUpperCase() === 'USD'
 && String(metadata?.purpose || '') === 'starter_subscription'
 && String(metadata?.plan_key || '') === 'starter'
 && String(metadata?.user_id || '') === String(user.id);
}

function activateStarterSubscription(user, subscription) {
 const status = String(subscription?.status || '').toUpperCase();
 if (!isSubscriptionActive(status)) {
 return getUserById(user.id) || user;
 }

 const nextPaymentMs = Number(subscription?.nextPaymentDate);
 const fallbackTrialEnd = new Date();
 fallbackTrialEnd.setDate(fallbackTrialEnd.getDate() + TRIAL_DAYS);
 const trialEnd = Number.isFinite(nextPaymentMs) && nextPaymentMs > Date.now()
 ? new Date(nextPaymentMs)
 : fallbackTrialEnd;

 updateUserBillingById(user.id, {
 plan: status === 'TRIALING' ? 'trial' : 'starter',
 xpay_subscription_status: status,
 xpay_subscription_plan: 'starter',
 xpay_trial_ends_at: status === 'TRIALING' ? trialEnd.toISOString() : null,
 xpay_subscription_checkout_url: null,
 xpay_last_payment_status: status === 'ACTIVE' ? 'paid' : user.xpay_last_payment_status,
 inboxes_limit: status === 'TRIALING' ? 100 : 500,
 });
 return getUserById(user.id) || user;
}

async function ensureStarterSubscriptionCheckout(user, baseUrl) {
 const latest = getUserById(user.id) || user;
 if (latest.xpay_subscription_id) {
 return {
 subscriptionId: latest.xpay_subscription_id,
 redirectUrl: latest.xpay_subscription_checkout_url || null,
 status: String(latest.xpay_subscription_status || 'CREATED').toUpperCase(),
 };
 }

 const customerId = await ensureXpayCustomer(latest, baseUrl);
 const checkout = await createStarterSubscriptionCheckout(xpay, {
 user: latest,
 customerId,
 receiptId: `starter_subscription_${latest.id}`,
 callbackUrl: `${baseUrl}/billing?billing=subscription-success&intent=starter`,
 cancelUrl: `${baseUrl}/billing?billing=subscription-cancelled&intent=starter`,
 });

 updateUserBillingById(latest.id, {
 xpay_subscription_id: checkout.subscriptionId,
 xpay_subscription_status: latest.xpay_intro_offer_used
 ? latest.xpay_subscription_status
 : checkout.status,
 xpay_subscription_plan: 'starter',
 xpay_subscription_checkout_url: checkout.redirectUrl,
 });
 return checkout;
}

async function ensureXpayCustomer(user, baseUrl) {
 if (user.xpay_customer_id) {
 return user.xpay_customer_id;
 }

 const response = await xpay.request(
 'POST',
 '/customer/create',
 { customerDetails: buildProfile(user) },
 `customer.${user.id}`
 );

 const customerId = response?.data?.customerId || response?.customerId || response?.data?.id || response?.id;
 if (customerId) {
 updateUserBillingById(user.id, { xpay_customer_id: String(customerId) });
 }

 return customerId;
}

async function autoSetupBilling(user, baseUrl) {
 if (!xpay.configured) {
 throw new Error('xPay is not configured.');
 }

 return {
 success: false,
 reason: 'Complete the secure $1 checkout before creating inboxes.',
 invoiceUrl: null,
 };
}

router.post('/checkout', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!xpay.configured) {
 return res.status(503).json({ error: 'xPay is not configured.' });
 }

 if (
 user.xpay_subscription_status
 && isSubscriptionActive(user.xpay_subscription_status)
 && user.xpay_subscription_checkout_url
 ) {
 return res.json({
 redirectUrl: user.xpay_subscription_checkout_url,
 subscriptionId: user.xpay_subscription_id,
 provider: 'xpay',
 });
 }

 if (user.xpay_subscription_status && isSubscriptionActive(user.xpay_subscription_status)) {
 return res.status(409).json({ error: 'Your subscription is already active.' });
 }

 try {
 const baseUrl = getRequestBaseUrl(req);
 const customerId = await ensureXpayCustomer(user, baseUrl);

 const receiptId = `trial_auth_${user.id}_${Date.now()}`;
 const checkout = await createOneTimeCheckout(xpay, {
 user,
 customerId,
 amount: TRIAL_AUTH_CHARGE_CENTS,
 description: 'Starter Plan Trial - $1 for 100 Inboxes',
 receiptId,
 metadata: {
 purpose: 'trial_auth',
 user_id: String(user.id),
 },
 callbackUrl: `${baseUrl}/billing?billing=success&intent=starter`,
 cancelUrl: `${baseUrl}/billing?intent=starter`,
 });

 updateUserBillingById(user.id, {
 xpay_checkout_id: checkout.intentId,
 xpay_checkout_url: checkout.redirectUrl,
 xpay_subscription_plan: 'trial',
 });

 return res.json({
 redirectUrl: checkout.redirectUrl,
 sessionId: checkout.intentId,
 provider: 'xpay',
 });
 } catch (error) {
 console.error('[billing] xPay checkout failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to create payment session.' });
 }
});

router.post('/subscribe', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!xpay.configured) {
 return res.status(503).json({ error: 'xPay is not configured.' });
 }

 let intentVal = req.body?.intent; let planKey = req.body?.plan || (intentVal === 'retry' ? user.xpay_subscription_plan : intentVal) || 'starter';
 if (planKey !== 'starter' || !PLANS[planKey]) {
 return res.status(400).json({ error: `Unknown plan: ${planKey}` });
 }

 if (user.xpay_subscription_status && isSubscriptionActive(user.xpay_subscription_status)) {
 return res.status(409).json({ error: 'Your subscription is already active.' });
 }

 try {
 const baseUrl = getRequestBaseUrl(req);
 const checkout = await ensureStarterSubscriptionCheckout(user, baseUrl);

 return res.json({
 success: true,
 subscriptionId: checkout.subscriptionId,
 status: checkout.status,
 plan: planKey,
 redirectUrl: checkout.redirectUrl,
 message: checkout.status === 'CREATED'
 ? 'Complete subscription setup to start the 7-day trial.'
 : 'Starter subscription is active.',
 });
 } catch (error) {
 console.error('[billing] xPay subscription failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to create subscription.' });
 }
});

router.get('/status', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 const billingStatus = serializeXpayBillingState(user);

 req.session.user = serializeSessionUser(user);
 return res.json(billingStatus);
});

router.post('/cancel', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!user.xpay_subscription_id) {
 return res.status(400).json({ error: 'No active subscription to cancel.' });
 }

 try {
 const subResponse = await xpay.request('POST', '/subscription/merchant/cancel', {
 subscription_id: user.xpay_subscription_id,
 });

 const sub = subResponse?.data || subResponse;

 updateUserBillingById(user.id, {
 xpay_subscription_status: sub?.status || 'cancelled',
 });

 const latest = getUserById(user.id) || user;
 req.session.user = serializeSessionUser(latest);

 return res.json({
 success: true,
 message: 'Subscription will be cancelled. Access continues until the end of the billing period.',
 });
 } catch (error) {
 console.error('[billing] xPay cancel failed:', error);
 return res.status(500).json({ error: error.message });
 }
});

router.post('/return', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 const requestedSessionId = req.body?.sessionId
 || req.body?.setupId
 || req.body?.subscriptionId
 || req.query?.xpay_intent_id
 || req.query?.xIntentId
 || req.query?.x_intent_id
 || req.query?.intentId
 || req.query?.subscriptionId
 || req.query?.subscription_id
 || req.query?.session_id
 || null;
 const sessionId = requestedSessionId === '__stored_checkout__'
 ? user.xpay_checkout_id
 : (requestedSessionId === '__stored_subscription__'
 ? user.xpay_subscription_id
 : requestedSessionId);
 if (!sessionId) {
 return res.status(400).json({ error: 'Missing payment session.' });
 }

 try {
 const latest = getUserById(user.id) || user;

 if (
 String(sessionId).startsWith('sub_')
 || String(sessionId) === String(latest.xpay_subscription_id || '')
 ) {
 if (String(latest.xpay_subscription_id || '') !== String(sessionId)) {
 return res.status(400).json({ error: 'Subscription does not match this account.' });
 }
 const response = await xpay.request(
 'GET',
 `/subscription/get-subscription/${encodeURIComponent(sessionId)}`
 );
 const subscription = response?.data || response;
 if (!isOwnedStarterSubscription(subscription, latest, sessionId)) {
 return res.status(400).json({ error: 'Invalid starter subscription.' });
 }
 if (!isSubscriptionActive(subscription?.status)) {
 return res.status(409).json({ error: 'Subscription setup is not complete yet.' });
 }
 const refreshed = activateStarterSubscription(latest, subscription);
 req.session.user = serializeSessionUser(refreshed);
 return res.json({
 success: true,
 subscriptionId: sessionId,
 status: refreshed.xpay_subscription_status,
 plan: refreshed.plan,
 provider: 'xpay',
 });
 }

 if (latest.xpay_checkout_id !== String(sessionId)) {
 return res.status(400).json({ error: 'Payment session does not match this account.' });
 }

 const intentResponse = await xpay.request(
 'GET',
 `/payments/v2/get-intent/${encodeURIComponent(sessionId)}`
 );
 const intent = intentResponse?.data || intentResponse;
 if (!isSuccessfulIntroIntent(intent, latest, sessionId)) {
 return res.status(409).json({ error: 'Payment is not complete yet.' });
 }

 const introUser = activateIntroOffer(latest);
 const baseUrl = getRequestBaseUrl(req);
 const subscription = await ensureStarterSubscriptionCheckout(introUser, baseUrl);
 const refreshed = getUserById(introUser.id) || introUser;
 req.session.user = serializeSessionUser(refreshed);

 return res.json({
 success: true,
 sessionId,
 status: refreshed.xpay_subscription_status,
 plan: refreshed.plan,
 redirectUrl: subscription.redirectUrl,
 subscriptionId: subscription.subscriptionId,
 provider: 'xpay',
 });
 } catch (error) {
 console.error('[billing] xPay return failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to finalize payment.' });
 }
});

router.get('/quota', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 return res.json({
 plan: user.xpay_subscription_plan || user.plan || 'free',
 inboxesUsed: user.inboxes_used || 0,
 inboxesLimit: user.inboxes_limit || 0,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 subscriptionStatus: user.xpay_subscription_status || null,
 });
});

router.post('/auto-charge-quota', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!user.xpay_default_payment_method_id) {
 return res.status(400).json({ error: 'No payment method on file.' });
 }

 if (!isSubscriptionActive(user.xpay_subscription_status)) {
 return res.status(400).json({ error: 'Active subscription required.' });
 }

 try {
 const result = await xpay.request('POST', '/payments/charge-tokenised-pm', {
 customer_id: user.xpay_customer_id,
 pm_id: user.xpay_default_payment_method_id,
 amount: ADDON_CONCURRENT_ORDERS.amountCents,
 currency: 'USD',
 description: 'Concurrent Orders Add-on',
 });

 const success = result?.success !== false && result?.status !== 'failed';

 if (success) {
 updateUserBillingById(user.id, { has_concurrent_orders: 1 });
 return res.json({ success: true, message: 'Concurrent orders add-on activated.' });
 }

 updateUserBillingById(user.id, { xpay_last_payment_status: 'failed' });
 return res.status(402).json({ error: 'Payment failed', reason: result?.message || 'Card declined' });
 } catch (error) {
 console.error('[billing] xPay auto-charge failed:', error);
 return res.status(500).json({ error: error.message || 'Payment processing failed.' });
 }
});

router.post('/webhook', async (req, res) => {
 if (!xpay.configured) {
 return res.status(503).json({ error: 'xPay not configured.' });
 }

 const rawBody = req.rawBody || JSON.stringify(req.body || {});
 const signature = req.headers['xpay-signature'] || '';

 let event;
 try {
 const isValid = xpay.verifyWebhookSignature(rawBody, signature, process.env.XPAY_WEBHOOK_SECRET);
 if (!isValid) {
 return res.status(400).json({ error: 'Invalid signature.' });
 }
 event = req.body || {};
 } catch (error) {
 console.error('[xpay-webhook] Signature verification failed:', error.message);
 return res.status(400).json({ error: 'Invalid signature.' });
 }

 try {
 const eventType = event?.eventType || event?.type || event?.event_type || event?.action || '';

 switch (true) {
 case eventType === 'intent.success': {
 const intentId = event?.intentId || event?.xIntentId;
 if (!intentId) break;
 const user = getUserByXpayCheckoutId(String(intentId));
 if (!user || !isSuccessfulIntroIntent(event, user, intentId)) break;
 const introUser = activateIntroOffer(user);
 await ensureStarterSubscriptionCheckout(
 introUser,
 process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com'
 );
 break;
 }

 case eventType === 'intent.failed': {
 const intentId = event?.intentId || event?.xIntentId;
 if (!intentId) break;
 const user = getUserByXpayCheckoutId(String(intentId));
 if (!user) break;
 updateUserBillingById(user.id, { xpay_last_payment_status: 'failed' });
 break;
 }

 case eventType === 'subscription.trialing'
 || eventType === 'subscription.active'
 || eventType === 'subscription.cycle_charged': {
 const subscriptionId = event?.subscriptionId || event?.id;
 if (!subscriptionId) break;
 const user = getUserByXpaySubscriptionId(String(subscriptionId));
 if (!user) break;
 const metadata = event?.metadata || {};
 if (
 metadata?.user_id
 && String(metadata.user_id) !== String(user.id)
 ) break;
 activateStarterSubscription(user, {
 ...event,
 subscriptionId,
 status: eventType === 'subscription.trialing' ? 'TRIALING' : 'ACTIVE',
 });
 if (eventType === 'subscription.cycle_charged') {
 updateUserBillingById(user.id, { xpay_last_payment_status: 'paid' });
 }
 break;
 }

 case eventType === 'subscription.unpaid': {
 const subscriptionId = event?.subscriptionId || event?.id;
 if (!subscriptionId) break;
 const user = getUserByXpaySubscriptionId(String(subscriptionId));
 if (!user) break;
 updateUserBillingById(user.id, {
 plan: 'free',
 xpay_subscription_status: 'UNPAID',
 xpay_last_payment_status: 'failed',
 });
 break;
 }

 case eventType === 'payment_method' || eventType === 'payment_method.added': {
 const customerId = event?.data?.customerId || event?.data?.customer?.customerId || event?.data?.customer_id || event?.data?.customer?.id;
 const pmId = event?.data?.paymentMethodId || event?.data?.id || event?.data?.pm_id;
 if (customerId && pmId) {
 const user = getUserByXpayCustomerId(String(customerId));
 if (user) {
 updateUserBillingById(user.id, {
 xpay_default_payment_method_id: String(pmId),
 xpay_last_payment_status: 'active',
 });
 }
 }
 break;
 }

 case eventType === 'subscription' || eventType === 'subscription.created': {
 const subData = event?.data || event;
 const customerId = subData?.customerId || subData?.customer_id || subData?.customer?.customerId || subData?.customer?.id;
 const subId = subData?.subscriptionId || subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'active';

 let user = customerId ? getUserByXpayCustomerId(String(customerId)) : null;
 if (!user && subId) {
 user = getUserByXpaySubscriptionId(String(subId));
 }
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : (user.plan || 'free'),
 xpay_subscription_id: subId ? String(subId) : user.xpay_subscription_id,
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: subData?.last_payment_status || 'paid',
 });

 if (subData?.trial_end_date) {
 updateUserBillingById(user.id, { xpay_trial_ends_at: subData.trial_end_date });
 }
 break;
 }

 case eventType === 'subscription.updated' || eventType === 'subscription.status_changed': {
 const subData = event?.data || event;
 const subId = subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'unknown';

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : 'free',
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: subData?.last_payment_status || user.xpay_last_payment_status || 'unknown',
 });
 break;
 }

 case eventType === 'subscription.cancelled' || eventType === 'subscription.ended': {
 const subData = event?.data || event;
 const subId = subData?.subscriptionId || subData?.id;
 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: 'free',
 xpay_subscription_status: 'cancelled',
 xpay_subscription_id: null,
 });
 break;
 }

 case eventType === 'payment_method_token.created' || eventType === 'setup_method.success': {
 const pmData = event?.data || event;
 const newPmId = pmData?.pmId;
 const customerId = pmData?.customerId;
 if (!newPmId || !customerId) break;
 const user = getUserByXpayCustomerId(String(customerId));
 if (!user) break;

 updateUserBillingById(user.id, {
 xpay_default_payment_method_id: String(newPmId),
 xpay_last_payment_status: 'active',
 });
 break;
 }

 case eventType === 'payment.failed' || eventType === 'subscription.payment_failed': {
 const subData = event?.data?.subscription || event?.data || event;
 const subId = subData?.id;
 let user = null;

 // Try to find by subscription ID first
 if (subId) {
 user = getUserByXpaySubscriptionId(String(subId));
 }

 // Fall back to customer_id for one-time payment failures (e.g., $1 trial auth)
 if (!user) {
 const customerId = subData?.customerId || subData?.customer_id || event?.data?.customerId;
 if (customerId) {
 user = getUserByXpayCustomerId(String(customerId));
 }
 }

 if (!user) break;

 const invoiceId = subData?.invoice?.id || subData?.invoiceId || subData?.invoice_id;
 const invoiceUrl = subData?.invoice?.url || subData?.invoiceUrl || subData?.invoice_url;
 const invoiceStatus = subData?.invoice?.status || subData?.invoice_status;

 const updates = {
 xpay_subscription_status: 'past_due',
 xpay_last_payment_status: 'failed',
 };
 if (invoiceId) updates.xpay_last_invoice_id = String(invoiceId);
 if (invoiceStatus) updates.xpay_last_invoice_status = String(invoiceStatus);
 if (invoiceUrl) updates.xpay_last_invoice_url = String(invoiceUrl);

 updateUserBillingById(user.id, updates);
 break;
 }

 case eventType === 'payment.succeeded' || eventType === 'subscription.payment_succeeded': {
 const subData = event?.data?.subscription || event?.data || event;
 const subId = subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'active';

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : user.plan,
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: 'paid',
 });
 break;
 }

 case eventType === 'intent' || eventType === 'subscription.intent': {
 const intentData = event?.data || event;
 const subId = intentData?.id;
 const status = intentData?.status;

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 const statusMap = {
 active: 'ACTIVE',
 trialing: 'TRIALING',
 created: 'CREATED',
 cycle_charged: 'ACTIVE',
 unpaid: 'UNPAID',
 cancelled: 'CANCELLED',
 ended: 'ENDED',
 paused: 'PAUSED',
 };

 const mappedStatus = statusMap[status] || status;

 const invoiceId = intentData?.invoice?.id || intentData?.invoiceId || intentData?.invoice_id;
 const invoiceUrl = intentData?.invoice?.url || intentData?.invoiceUrl || intentData?.invoice_url;
 const invoiceStatus = intentData?.invoice?.status || intentData?.invoice_status;

 const updates = { xpay_subscription_status: mappedStatus };
 if (invoiceId) updates.xpay_last_invoice_id = String(invoiceId);
 if (invoiceUrl) updates.xpay_last_invoice_url = String(invoiceUrl);
 if (invoiceStatus) updates.xpay_last_invoice_status = String(invoiceStatus);

 updateUserBillingById(user.id, updates);
 break;
 }

 default:
 break;
 }

 return res.json({ received: true, event_type: eventType });
 } catch (error) {
 console.error('[xpay-webhook] Handler error:', error.message);
 return res.status(500).json({ error: 'Webhook handler failed.' });
 }
});

export function serializeXpayBillingState(user) {
 const access = getUserAccessState(user);
 const status = user.xpay_subscription_status
 ? String(user.xpay_subscription_status).toUpperCase()
 : null;
 const plan = access.effectivePlan;

 const isActive = isSubscriptionActive(status);
 const isPastDue = ['UNPAID', 'PAST_DUE'].includes(status);

 const trialEnd = user.xpay_trial_ends_at ? new Date(user.xpay_trial_ends_at) : null;
 const isTrialing = trialEnd && trialEnd > new Date() && status === 'TRIALING';

 return {
 ...access,
 provider: 'xpay',
 plan,
 status,
 isActive,
 isTrialing,
 isPastDue,
 trialEndsAt: user.xpay_trial_ends_at || null,
 customerId: user.xpay_customer_id || null,
 subscriptionId: user.xpay_subscription_id || null,
 paymentMethodStatus: user.xpay_last_payment_status || null,
 lastPaymentStatus: user.xpay_last_payment_status || null,
 invoiceId: user.xpay_last_invoice_id || null,
 invoiceStatus: user.xpay_last_invoice_status || null,
 invoiceUrl: user.xpay_last_invoice_url || null,
 inboxesUsed: access.inboxesUsed,
 inboxesLimit: access.inboxesLimit,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 };
}

export { autoSetupBilling };
export default router;
