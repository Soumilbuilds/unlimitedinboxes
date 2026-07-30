import crypto from 'crypto';

const XPAY_BASE_URL = (process.env.XPAY_BASE_URL || 'https://api.xpaycheckout.com').replace(/\/+$/, '');

function stableKey(value) {
 const hash = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
 const key = `lci.${hash}`;
 return key.length > 255 ? key.slice(0, 255) : key;
}

export class XPayClient {
 constructor(publicKey, privateKey, baseUrl = XPAY_BASE_URL, timeoutMs = 30000) {
 this.publicKey = (publicKey || '').trim();
 this.privateKey = (privateKey || '').trim();
 this.baseUrl = baseUrl;
 this.timeoutMs = timeoutMs;
 }

 get configured() {
 return Boolean(this.publicKey && this.privateKey);
 }

 authHeader() {
 return `Basic ${Buffer.from(`${this.publicKey}:${this.privateKey}`).toString('base64')}`;
 }

 async request(method, path, body = {}, idempotencyKey = undefined) {
 const url = `${this.baseUrl}${path}`;
 const headers = {
 Authorization: this.authHeader(),
 'Content-Type': 'application/json',
 Accept: 'application/json',
 };
 if (idempotencyKey) {
 headers['Idempotency-Key'] = idempotencyKey;
 }

 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

 try {
 const options = {
 method,
 headers,
 signal: controller.signal,
 };
 if (method !== 'GET' && method !== 'HEAD') {
 options.body = JSON.stringify(body);
 }

 const response = await fetch(url, options);
 const text = await response.text();
 let data;
 try { data = JSON.parse(text); } catch { data = { raw: text }; }

 if (!response.ok) {
 const err = new Error(
 data?.errorDescription
 || data?.message
 || data?.error
 || `xPay error ${response.status}`
 );
 err.status = response.status;
 err.body = data;
 throw err;
 }
 return data;
 } finally {
 clearTimeout(timeout);
 }
 }

 verifyWebhookSignature(payload, signatureHeader, secret) {
 if (!signatureHeader || !secret) return false;
 const expected = crypto
 .createHmac('sha512', secret)
 .update(payload)
 .digest('base64');
 try {
 return crypto.timingSafeEqual(
 Buffer.from(expected),
 Buffer.from(signatureHeader)
 );
 } catch {
 return expected === signatureHeader;
 }
 }
}

export const xpay = new XPayClient(process.env.XPAY_PUBLIC_KEY, process.env.XPAY_PRIVATE_KEY);

export const PLANS = {
 starter: { name: 'Starter', amountCents: 4999, interval: 'WEEK', intervalCount: 4, displayPrice: '$49.99 every 4 weeks', monthlyPrice: '$49.99' },
 growth: { name: 'Growth', amountCents: 9999, interval: 'WEEK', intervalCount: 4, displayPrice: '$99.99 every 4 weeks', monthlyPrice: '$99.99' },
 unlimited: { name: 'Unlimited', amountCents: 19999, interval: 'WEEK', intervalCount: 4, displayPrice: '$199.99 every 4 weeks', monthlyPrice: '$199.99' },
};

export const ADDON_CONCURRENT_ORDERS = {
 name: 'Concurrent Orders',
 amountCents: 2900,
 interval: 'MONTH',
 intervalCount: 1,
 displayPrice: '$29/month',
};

export const TRIAL_DAYS = 7;
export const TRIAL_AUTH_CHARGE_CENTS = 100; // $1.00 auth charge
export const SUBSCRIPTION_CYCLE_COUNT = 120;

export function getPlanByKey(key) {
 return PLANS[key] || null;
}

export function buildProfile(user) {
 const email = String(user.email || '').trim();
 const name = String(user.full_name || user.name || '').trim() || (email ? email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Customer');
 const phone = String(user.phone || '').trim() || '+14155552671';
 const country = String(user.country || 'US').trim().toUpperCase();

 return {
 name: name.slice(0, 120),
 email,
 contactNumber: /^\+[1-9]\d{7,14}$/.test(phone) ? phone : '+14155552671',
 customerAddress: { country: /^[A-Z]{2}$/.test(country) ? country : 'US' },
 };
}

export function buildOneTimeCheckoutPayload({
 user,
 customerId,
 amount,
 description,
 callbackUrl,
 cancelUrl,
 metadata = {},
 receiptId,
}) {
 return {
 amount,
 currency: 'USD',
 receiptId,
 customerDetails: buildProfile(user),
 customerId,
 description,
 callbackUrl,
 cancelUrl,
 paymentMethods: ['CARD', 'APPLE_PAY', 'GOOGLE_PAY'],
 metadata,
 phoneNumberRequired: false,
 tokenise: true,
 productPage: {
 name: 'Unlimited Mailboxes Starter',
 description: 'Create the first 100 inboxes for $1.',
 },
 };
}

export async function createOneTimeCheckout(client, options) {
 const payload = buildOneTimeCheckoutPayload(options);
 const response = await client.request(
 'POST',
 '/payments/create-intent',
 payload,
 stableKey(options.receiptId)
 );
 const intent = response?.data || response;
 const intentId = intent?.xIntentId || intent?.intentId || intent?.id;
 const redirectUrl = intent?.fwdUrl || intent?.redirectUrl || intent?.url;

 if (!intentId || !redirectUrl) {
 throw new Error(intent?.errorDescription || intent?.message || 'Failed to create payment intent.');
 }

 return {
 intentId: String(intentId),
 redirectUrl,
 };
}

export function buildStarterSubscriptionPayload({
 user,
 customerId,
 callbackUrl,
 cancelUrl,
 receiptId,
 plan = PLANS.starter,
}) {
 return {
 amount: plan.amountCents,
 currency: 'USD',
 receiptId,
 customerDetails: buildProfile(user),
 customerId,
 interval: plan.interval,
 intervalCount: plan.intervalCount,
 cycleCount: SUBSCRIPTION_CYCLE_COUNT,
 trialPeriodCount: TRIAL_DAYS,
 trialPeriodInterval: 'DAY',
 metadata: {
 purpose: 'starter_subscription',
 plan_key: 'starter',
 user_id: String(user.id),
 },
 callbackUrl,
 cancelUrl,
 phoneNumberRequired: false,
 productPage: {
 name: `${plan.name} Subscription`,
 description: `${plan.displayPrice} after a ${TRIAL_DAYS}-day trial.`,
 },
 };
}

export async function createStarterSubscriptionCheckout(client, options) {
 const payload = buildStarterSubscriptionPayload(options);
 const response = await client.request(
 'POST',
 '/subscription/create',
 payload,
 stableKey(options.receiptId)
 );
 const subscription = response?.data || response;
 const subscriptionId = subscription?.subscriptionId || subscription?.id;
 const redirectUrl = subscription?.fwdUrl || subscription?.redirectUrl || subscription?.url;

 if (!subscriptionId) {
 throw new Error(
 subscription?.errorDescription
 || subscription?.message
 || 'Failed to create starter subscription.'
 );
 }

 return {
 subscriptionId: String(subscriptionId),
 redirectUrl: redirectUrl || null,
 status: String(subscription?.status || 'CREATED').toUpperCase(),
 };
}

export function isSubscriptionActive(status) {
 return ['ACTIVE', 'TRIALING'].includes(String(status || '').toUpperCase());
}

export function isSubscriptionPastDue(status) {
 return ['UNPAID', 'PAST_DUE'].includes(String(status || '').toUpperCase());
}
