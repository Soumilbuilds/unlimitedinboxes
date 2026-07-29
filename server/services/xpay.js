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
 headers['X-Pay-Idempotency-Key'] = idempotencyKey;
 }

 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

 try {
 const response = await fetch(url, {
 method,
 headers,
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 const text = await response.text();
 let data;
 try { data = JSON.parse(text); } catch { data = { raw: text }; }

 if (!response.ok) {
 const err = new Error(data?.message || data?.error || `xPay error ${response.status}`);
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

export function isSubscriptionActive(status) {
 return ['ACTIVE', 'TRIALING'].includes(String(status || '').toUpperCase());
}

export function isSubscriptionPastDue(status) {
 return ['UNPAID', 'PAST_DUE'].includes(String(status || '').toUpperCase());
}
