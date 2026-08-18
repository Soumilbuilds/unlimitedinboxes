import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolveNs } from 'node:dns/promises';
import {
 createTenant,
 createTenantPurchaseRecord,
 getTenants,
 getTenantByIdForUser,
 getTenantPurchaseByIdForUser,
 getTenantPurchaseByRequestToken,
 getUserByEmail,
 updateTenantPurchaseById,
 updateUserBillingById,
 updateTenantCloudflare,
 updateTenantStatus,
 updateTenantDetails,
 deleteTenant
} from '../db/database.js';
import { createZone } from '../services/cloudflare.js';
import { ensureSpfRecord, ensureDmarcRecord, ensureDkimRecords } from '../services/emailAuth.js';
import {
 loginToSecurityCenter,
 ensureDkimSelectors,
 retryEnableDkimSigning
} from '../services/securityCenterDkim.js';
import { isValidTotpSecret } from '../services/totp.js';
import { whop, isWhopPaymentFailed, isWhopPaymentPaid, serializeBillingAddress } from '../services/whop.js';
import {
 TENANT_OFFERS,
 createTenantCheckoutConfiguration,
 createTenantSavedCardPayment,
 normalizeTenantSelection,
 tenantSubtotalCents,
 validateTenantPaymentForPurchase,
 validateTenantPromoCode,
} from '../services/tenantBilling.js';

const router = express.Router();
const { MASTER_CLIENT_ID, MASTER_REDIRECT_URI } = process.env;

const requireAuth = (req, res, next) => {
 if (!req.session.authenticated) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 if (!req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 next();
};

router.use(requireAuth);

function getRequestBaseUrl(req) {
 const origin = req.get('origin');
 const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
 .split(',')
 .map(value => value.trim())
 .filter(Boolean);

 if (
 origin
 && (
 allowedOrigins.includes(origin)
 || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
 )
 ) {
 return origin;
 }

 return process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';
}

function requestToken(req) {
 const value = String(req.get('idempotency-key') || req.body?.requestToken || randomUUID()).trim();
 if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error('Invalid Purchase Request Token.');
 return value;
}

function tenantPurchaseResponse(purchase, user = null) {
 let billingAddress = null;
 try { billingAddress = user?.whop_billing_address ? JSON.parse(user.whop_billing_address) : null; } catch { /* Ignore corrupt legacy data. */ }
 return {
 success: purchase.status === 'paid',
 confirmed: purchase.status === 'paid',
 failed: purchase.status === 'failed',
 status: purchase.status,
 purchaseId: Number(purchase.id),
 paid: purchase.status === 'paid',
 paymentPending: purchase.status === 'pending' && Boolean(purchase.whop_payment_id),
 paymentId: purchase.whop_payment_id || null,
 sessionId: purchase.whop_checkout_id || null,
 planId: purchase.whop_plan_id || null,
 promoCode: purchase.promo_code || null,
 amountCents: purchase.amount_cents,
 email: user?.email || null,
 billingAddress,
 };
}

async function ensureTenantFallback(user, purchase, selection, req) {
 if (purchase.whop_checkout_id) return purchase;
 const checkout = await createTenantCheckoutConfiguration(whop, {
 user,
 purchase,
 selection,
 promoCode: purchase.promo_code,
 redirectUrl: `${getRequestBaseUrl(req)}/tenants/checkout?purchase_id=${purchase.id}`,
 });
 updateTenantPurchaseById(purchase.id, {
 status: 'checkout_required',
 whop_checkout_id: checkout.sessionId,
 whop_plan_id: checkout.planId,
 });
 return getTenantPurchaseByIdForUser(purchase.id, user.id);
}

router.get('/offers', (_req, res) => res.json({
 currency: 'USD',
 offers: Object.values(TENANT_OFFERS).map((offer) => ({
 licenseType: offer.licenseType,
 tenantType: offer.tenantType,
 label: offer.label,
 unitPriceCents: offer.unitPriceCents,
 })),
}));

router.post('/coupon', async (req, res) => {
 if (!whop.configured) return res.status(503).json({ error: 'Whop Is Not Configured.' });
 try {
 const selection = normalizeTenantSelection(req.body);
 const promo = await validateTenantPromoCode(whop, {
 code: req.body?.code || req.body?.couponCode,
 subtotalCents: tenantSubtotalCents(selection),
 });
 return res.json({ success: true, promo });
 } catch (error) {
 return res.status(400).json({ error: error.message || 'Coupon Could Not Be Applied.' });
 }
});

router.post('/purchase-checkout', async (req, res) => {
 if (!whop.configured) return res.status(503).json({ error: 'Whop Is Not Configured.' });

 const user = getUserByEmail(req.session.user.email);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 try {
 const selection = normalizeTenantSelection(req.body);
 const token = requestToken(req);
 const existing = getTenantPurchaseByRequestToken(user.id, token);
 const subtotalCents = tenantSubtotalCents(selection);
 if (existing && (
 Number(existing.quantity) !== selection.quantity
 || existing.tenant_type !== selection.tenantType
 || Number(existing.subtotal_cents) !== subtotalCents
 || String(existing.promo_code || '') !== String(req.body?.couponCode || '').trim().toUpperCase()
 )) return res.status(409).json({ error: 'This Purchase Token Is Already Bound To A Different Order.' });
 if (existing && (existing.whop_checkout_id || existing.status === 'paid'
 || (existing.whop_payment_id && existing.status !== 'failed'))) {
 return res.status(existing.status === 'pending' ? 202 : 200).json(tenantPurchaseResponse(existing, user));
 }

 const promo = existing?.promo_code_id ? {
 id: existing.promo_code_id,
 code: existing.promo_code,
 totalCents: existing.amount_cents,
 discountCents: existing.discount_cents,
 } : (req.body?.couponCode
 ? await validateTenantPromoCode(whop, { code: req.body.couponCode, subtotalCents })
 : null);
 let purchase = existing;
 if (!purchase) {
 const result = createTenantPurchaseRecord({
 user_id: user.id,
 tenant_type: selection.tenantType,
 quantity: selection.quantity,
 amount_cents: promo?.totalCents ?? subtotalCents,
 unit_price_cents: selection.unitPriceCents,
 subtotal_cents: subtotalCents,
 discount_cents: promo?.discountCents || 0,
 promo_code_id: promo?.id || null,
 promo_code: promo?.code || null,
 request_token: token,
 status: 'pending',
 });
 purchase = getTenantPurchaseByIdForUser(Number(result.lastInsertRowid), user.id);
 }

 if (user.whop_member_id && user.whop_payment_method_id) {
 try {
 const payment = await createTenantSavedCardPayment(whop, {
 user, purchase, selection, promoCodeId: promo?.id || null,
 });
 updateTenantPurchaseById(purchase.id, {
 whop_payment_id: String(payment.id),
 whop_plan_id: payment.plan?.id || null,
 status: isWhopPaymentPaid(payment) ? 'paid' : (isWhopPaymentFailed(payment) ? 'failed' : 'pending'),
 error_message: payment.failure_message || null,
 });
 purchase = getTenantPurchaseByIdForUser(purchase.id, user.id);
 if (purchase.status === 'paid') return res.json(tenantPurchaseResponse(purchase, user));
 if (purchase.status === 'pending') return res.status(202).json(tenantPurchaseResponse(purchase, user));
 } catch (error) {
 // A transport error can occur after Whop accepted the idempotent charge.
 // Keep the purchase retryable and never open a second checkout until Whop
 // returns a definitive failed payment object or webhook.
 updateTenantPurchaseById(purchase.id, { status: 'pending', error_message: error.message });
 return res.status(503).json({
 error: 'Whop Could Not Confirm The Saved-Card Attempt. Please Try Again.',
 retryable: true,
 purchaseId: Number(purchase.id),
 });
 }
 }

 purchase = await ensureTenantFallback(user, purchase, selection, req);
 return res.json(tenantPurchaseResponse(purchase, user));
 } catch (error) {
 console.error('[tenants] Whop tenant purchase failed:', error);
 const status = /valid|coupon|expired|usage|configured/i.test(error.message) ? 400 : 500;
 return res.status(status).json({ error: error.message || 'Failed To Start Tenant Purchase.' });
 }
});

router.get('/purchase/:id', (req, res) => {
 const user = getUserByEmail(req.session.user.email);
 const purchase = user && getTenantPurchaseByIdForUser(Number(req.params.id), user.id);
 if (!purchase) return res.status(404).json({ error: 'Tenant Purchase Not Found.' });
 return res.json(tenantPurchaseResponse(purchase, user));
});

router.post('/purchase/:id/confirm', async (req, res) => {
 if (!whop.configured) return res.status(503).json({ error: 'Whop Is Not Configured.' });
 const user = getUserByEmail(req.session.user.email);
 const purchase = user && getTenantPurchaseByIdForUser(Number(req.params.id), user.id);
 if (!purchase) return res.status(404).json({ error: 'Tenant Purchase Not Found.' });
 if (purchase.status === 'paid') return res.json(tenantPurchaseResponse(purchase, user));

 try {
 const requestedPaymentId = String(req.body?.paymentId || req.body?.receiptId || purchase.whop_payment_id || '').trim();
 if (requestedPaymentId) {
 const payment = await whop.payments.retrieve(requestedPaymentId);
 if (!validateTenantPaymentForPurchase(payment, purchase)) {
 return res.status(400).json({ error: 'Payment Does Not Match This Tenant Purchase.' });
 }
 if (isWhopPaymentPaid(payment)) {
 const updates = { status: 'paid', whop_payment_id: String(payment.id), error_message: null };
 updateTenantPurchaseById(purchase.id, updates);
 const address = serializeBillingAddress(payment.billing_address || req.body?.billingAddress);
 updateUserBillingById(user.id, {
 whop_member_id: payment.member?.id ? String(payment.member.id) : undefined,
 whop_payment_method_id: payment.payment_method?.id ? String(payment.payment_method.id) : undefined,
 whop_billing_address: address || undefined,
 });
 return res.json(tenantPurchaseResponse(getTenantPurchaseByIdForUser(purchase.id, user.id), user));
 }
 if (isWhopPaymentFailed(payment)) {
 updateTenantPurchaseById(purchase.id, { status: 'failed', error_message: payment.failure_message || 'Payment Failed.' });
 }
 }

 const latest = getTenantPurchaseByIdForUser(purchase.id, user.id);
 if (latest.status === 'pending') return res.status(202).json(tenantPurchaseResponse(latest, user));
 const selection = normalizeTenantSelection({
 licenseType: latest.tenant_type === 'usTenant' ? 'premium' : 'normal',
 quantity: latest.quantity,
 });
 return res.json(tenantPurchaseResponse(await ensureTenantFallback(user, latest, selection, req), user));
 } catch (error) {
 console.error('[tenants] Whop tenant confirmation failed:', error);
 return res.status(500).json({ error: error.message || 'Failed To Confirm Tenant Purchase.' });
 }
});

router.get('/', (req, res) => {
 try {
 const tenants = getTenants(req.session.user.id);
 const processed = tenants.map(t => ({
 ...t,
 cloudflare_ns: t.cloudflare_ns ? JSON.parse(t.cloudflare_ns) : null
 }));
 res.json(processed);
 } catch (error) {
 res.status(500).json({ error: 'Failed to fetch tenants' });
 }
});

router.post('/', (req, res) => {
 try {
 const { name, admin_email, admin_password, mfa_secret, domain } = req.body;

 if (!name || !admin_email || !admin_password) {
 return res.status(400).json({ error: 'Name, admin email, and admin password are required' });
 }

 if (!mfa_secret) {
 return res.status(400).json({ error: 'MFA secret is required' });
 }

 const normalizedMfaSecret = String(mfa_secret).replace(/\s+/g, '').toUpperCase();
 if (!isValidTotpSecret(normalizedMfaSecret)) {
 return res.status(400).json({ error: 'Enter a valid MFA secret' });
 }

 const result = createTenant({
 user_id: req.session.user.id,
 name,
 admin_email,
 admin_password,
 mfa_secret: normalizedMfaSecret,
 domain: domain || null
 });
 res.json({ success: true, id: result.lastInsertRowid });
 } catch (error) {
 res.status(500).json({ error: 'Failed to create tenant' });
 }
});

router.patch('/:id', (req, res) => {
 try {
 const { name, domain, admin_email, admin_password, mfa_secret } = req.body;
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
 let normalizedMfaSecret;
 if (mfa_secret !== undefined) {
 normalizedMfaSecret = String(mfa_secret).replace(/\s+/g, '').toUpperCase();
 if (!isValidTotpSecret(normalizedMfaSecret)) {
 return res.status(400).json({ error: 'Enter a valid MFA secret' });
 }
 }
 const result = updateTenantDetails(req.params.id, {
 name,
 domain,
 admin_email,
 admin_password,
 mfa_secret: normalizedMfaSecret
 });
 if (result.changes === 0) return res.status(404).json({ error: 'Tenant not found' });
 res.json({ success: true });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

// NOTE: Consent is now handled automatically by the order processor via puppeteer.
// This endpoint is kept as a no-op for backward compatibility.
router.post('/:id/connect', (req, res) => {
 try {
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
 res.json({ success: true, message: 'Consent will be handled automatically during order processing.' });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.post('/:id/nameservers', async (req, res) => {
 try {
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

 if (tenant.cloudflare_zone_id && tenant.cloudflare_ns) {
 return res.json({
 success: true,
 name_servers: JSON.parse(tenant.cloudflare_ns),
 zone_active: false
 });
 }

 const zone = await createZone(tenant.domain);
 updateTenantCloudflare(tenant.id, zone.id, zone.name_servers);

 res.json({ success: true, name_servers: zone.name_servers, zone_active: false });
 } catch (error) {
 const errorData = error.response?.data;
 if (errorData?.errors?.[0]?.code === 0 &&
 errorData.errors[0].message?.includes('zone.create')) {
 return res.status(403).json({
 error: 'Cloudflare token is missing the "Zone: Create" permission. Please update your Cloudflare API token to include zone creation access and try again.'
 });
 }
 res.status(500).json({ error: error.message });
 }
});

router.post('/:id/nameservers/check', async (req, res) => {
 try {
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

 if (!tenant.cloudflare_zone_id) {
 return res.status(400).json({ error: 'No Cloudflare zone found for this tenant' });
 }

 const { getZoneStatus } = await import('../services/cloudflare.js');
 const status = await getZoneStatus(tenant.cloudflare_zone_id);

 const normalizeNameServer = value => String(value || '')
 .trim()
 .toLowerCase()
 .replace(/\.$/, '');
 const expectedNameServers = (tenant.cloudflare_ns ? JSON.parse(tenant.cloudflare_ns) : [])
 .map(normalizeNameServer)
 .sort();
 let liveNameServers = [];
 try {
 liveNameServers = (await resolveNs(tenant.domain))
 .map(normalizeNameServer)
 .sort();
 } catch {
 try {
 const dnsResponse = await fetch(
 `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(tenant.domain)}&type=NS`,
 { headers: { accept: 'application/dns-json' } }
 );
 if (dnsResponse.ok) {
 const dnsResult = await dnsResponse.json();
 liveNameServers = (dnsResult.Answer || [])
 .filter(answer => answer.type === 2)
 .map(answer => normalizeNameServer(answer.data))
 .sort();
 }
 } catch {
 // Cloudflare status remains the fallback while public DNS is unavailable.
 }
 }

 const delegationActive = expectedNameServers.length >= 2
 && expectedNameServers.length === liveNameServers.length
 && expectedNameServers.every((nameServer, index) => nameServer === liveNameServers[index]);
 const active = status === 'active' || delegationActive;
 res.json({
 success: true,
 active,
 status: active && status !== 'active' ? 'delegated' : status,
 cloudflare_status: status,
 delegation_active: delegationActive,
 live_name_servers: liveNameServers
 });
 } catch (error) {
 res.status(500).json({ error: error.message || 'Failed to check name servers' });
 }
});

router.post('/:id/email-auth', async (req, res) => {
 try {
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

 // tenant_id (ms_tenant_id) can be discovered during order processing;
 // email-auth requires it to be known at this point.
 if (!tenant.tenant_id) {
 return res.status(400).json({ error: 'Tenant not connected to Microsoft (missing tenant_id). Start an order to auto-discover and grant consent.' });
 }

 const domain = tenant.domain;
 if (!domain) {
 return res.status(400).json({ error: 'Tenant missing domain' });
 }

 let zoneId = tenant.cloudflare_zone_id;
 if (!zoneId) {
 try {
 const zone = await createZone(domain);
 zoneId = zone.id;
 updateTenantCloudflare(tenant.id, zone.id, zone.name_servers);
 } catch (zoneError) {
 const errorData = zoneError.response?.data;
 if (errorData?.errors?.[0]?.code === 0 &&
 errorData.errors[0].message?.includes('zone.create')) {
 return res.status(403).json({
 error: 'Cloudflare token is missing the "Zone: Create" permission. Please update your Cloudflare API token to include zone creation access and try again.'
 });
 }
 throw zoneError;
 }
 }

 const spfValue = process.env.SPF_VALUE || 'v=spf1 include:spf.protection.outlook.com -all';
 const dmarcValue = process.env.DMARC_VALUE || 'v=DMARC1; p=none; pct=100';

 const spf = await ensureSpfRecord(zoneId, domain, spfValue);
 const dmarc = await ensureDmarcRecord(zoneId, domain, dmarcValue);

 const dkim = { selectors: null, dns: null, enable: null };
 let securitySession = null;
 try {
 const log = msg => console.log(`[EmailAuth DKIM] ${msg}`);
 securitySession = await loginToSecurityCenter(tenant.admin_email, tenant.admin_password);
 if (!securitySession.success) {
 throw new Error(`Security Center login failed: ${securitySession.error}`);
 }

 const cfg = await ensureDkimSelectors(securitySession.page, tenant.tenant_id, domain, log);
 dkim.selectors = {
 Selector1CNAME: cfg.Selector1CNAME,
 Selector2CNAME: cfg.Selector2CNAME,
 Enabled: cfg.Enabled
 };

 dkim.dns = await ensureDkimRecords(zoneId, domain, cfg.Selector1CNAME, cfg.Selector2CNAME);

 if (cfg.Enabled === true) {
 dkim.enable = { success: true, message: 'DKIM already enabled' };
 } else {
 dkim.enable = await retryEnableDkimSigning(securitySession.page, tenant.tenant_id, domain, log);
 if (!dkim.enable?.success) {
 throw new Error(dkim.enable?.error || 'Failed to enable DKIM signing');
 }
 }
 } catch (dkimError) {
 dkim.error = dkimError.message;
 } finally {
 if (securitySession?.page) {
 try { await securitySession.page.close(); } catch { /* ignore */ }
 }
 if (securitySession?.context) {
 try { await securitySession.context.close(); } catch { /* ignore */ }
 }
 }

 return res.json({
 success: true,
 spf,
 dmarc,
 dkim
 });
 } catch (error) {
 return res.status(500).json({ error: error.message });
 }
});

router.patch('/:id/status', (req, res) => {
 try {
 const { status } = req.body;
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
 updateTenantStatus(req.params.id, status);
 res.json({ success: true });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

router.delete('/:id', (req, res) => {
 try {
 const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
 if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
 const result = deleteTenant(req.params.id);
 if (result.changes === 0) return res.status(404).json({ error: 'Tenant not found' });
 res.json({ success: true });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

export default router;
