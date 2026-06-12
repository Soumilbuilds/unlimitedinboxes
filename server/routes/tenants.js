import express from 'express';
import { Resolver as DnsResolver } from 'dns/promises';
import {
  createTenant,
  createTenantPurchaseRecord,
  getTenants,
  getTenantByIdForUser,
  getUserByEmail,
  updateTenantCloudflare,
  updateTenantStatus,
  updateTenantDetails,
  updateTenantId,
  deleteTenant
} from '../db/database.js';
import { createZone } from '../services/cloudflare.js';
import { ensureSpfRecord, ensureDmarcRecord, ensureDkimRecords } from '../services/emailAuth.js';
import { isValidTotpSecret } from '../services/totp.js';
import {
  chargeSavedPaymentMethodForTenantPurchase,
  createTenantCheckoutSession,
  getTenantPurchaseAmountCents,
  isStripeConfigured
} from '../services/stripe.js';
import {
  loginToSecurityCenter,
  ensureDkimSelectors,
  retryEnableDkimSigning
} from '../services/securityCenterDkim.js';
import { discoverMicrosoftTenantId } from '../services/tenantDiscovery.js';

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

function normalizeTenantPurchase(body = {}) {
  const quantity = Number.parseInt(body.quantity, 10);
  const licenseType = String(body.licenseType || '').trim().toLowerCase();
  const tenantType = licenseType === 'premium'
    ? 'usTenant'
    : (licenseType === 'normal' ? 'asiaTenant' : null);

  return {
    quantity,
    licenseType,
    tenantType,
  };
}

router.post('/purchase-checkout', async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }

  const user = getUserByEmail(req.session.user.email);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { quantity, tenantType } = normalizeTenantPurchase(req.body);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !tenantType) {
    return res.status(400).json({ error: 'Choose a valid tenant type and quantity.' });
  }

  const amountCents = getTenantPurchaseAmountCents(tenantType, quantity);

  try {
    const savedCardCharge = await chargeSavedPaymentMethodForTenantPurchase(user, tenantType, quantity);
    if (savedCardCharge.paid) {
      createTenantPurchaseRecord({
        user_id: user.id,
        tenant_type: tenantType,
        quantity,
        amount_cents: amountCents,
        status: 'paid',
        stripe_payment_intent_id: savedCardCharge.paymentIntent.id,
        stripe_customer_id: user.stripe_customer_id,
      });

      return res.json({
        success: true,
        paid: true,
        provider: 'stripe',
        paymentIntentId: savedCardCharge.paymentIntent.id,
      });
    }

    const checkout = await createTenantCheckoutSession(user, tenantType, quantity, {
      appBaseUrl: getRequestBaseUrl(req),
      metadata: {
        fallback_reason: savedCardCharge.reason || 'checkout_required',
      },
    });

    createTenantPurchaseRecord({
      user_id: user.id,
      tenant_type: tenantType,
      quantity,
      amount_cents: amountCents,
      status: 'pending',
      stripe_checkout_session_id: checkout.sessionId,
      stripe_customer_id: checkout.customerId || user.stripe_customer_id || null,
      error_message: savedCardCharge.error?.message || null,
    });

    return res.json({
      success: true,
      paid: false,
      provider: 'stripe',
      sessionId: checkout.sessionId,
      purchaseUrl: checkout.url,
      checkoutUrl: checkout.url,
    });
  } catch (error) {
    console.error('[tenants] Stripe tenant purchase failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to start tenant purchase.' });
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

router.post('/', async (req, res) => {
  try {
    const { name, admin_email, admin_password, domain, mfa_secret } = req.body;

    if (!name || !domain || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'Name, Domain, Email, and Password are required' });
    }

    const normalizedMfa = typeof mfa_secret === 'string' && mfa_secret.trim()
      ? mfa_secret.trim().replace(/\s+/g, '')
      : null;
    if (normalizedMfa !== null && !isValidTotpSecret(normalizedMfa)) {
      return res.status(400).json({ error: 'Invalid 2FA secret format. It should be a base32 string (e.g. cgynpk62rpgznlxh from Microsoft Entra).' });
    }

    const result = createTenant({
      user_id: req.session.user.id,
      name,
      admin_email,
      admin_password,
      domain,
      mfa_secret: normalizedMfa
    });
    const tenantId = result.lastInsertRowid;

    // Try to discover Microsoft tenant ID from admin email domain
    try {
      const discoveredTenantGuid = await discoverMicrosoftTenantId(admin_email);
      if (discoveredTenantGuid) {
        updateTenantId(tenantId, discoveredTenantGuid);
        console.log(`[tenants] Discovered and set MS tenant ID ${discoveredTenantGuid} for new tenant ${tenantId}`);
      } else {
        console.log(`[tenants] Could not discover MS tenant ID for new tenant ${tenantId} (domain: ${admin_email.split('@')[1]}). It will be re-attempted at order time.`);
      }
    } catch (discoveryError) {
      console.error(`[tenants] Tenant discovery failed for new tenant ${tenantId}:`, discoveryError.message);
    }

    res.json({ success: true, id: tenantId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const { name, domain, admin_email, admin_password, mfa_secret } = req.body;
    const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const sanitizedMfa = typeof mfa_secret === 'string' && mfa_secret.trim()
      ? mfa_secret.trim().replace(/\s+/g, '')
      : mfa_secret;
    if (typeof sanitizedMfa === 'string' && sanitizedMfa.length > 0 && !isValidTotpSecret(sanitizedMfa)) {
      return res.status(400).json({ error: 'Invalid 2FA secret format. It should be a base32 string (e.g. cgynpk62rpgznlxh from Microsoft Entra).' });
    }
    const result = updateTenantDetails(req.params.id, {
      name,
      domain,
      admin_email,
      admin_password,
      mfa_secret: sanitizedMfa
    });
    if (result.changes === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/connect', (req, res) => {
  try {
    const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!MASTER_CLIENT_ID || !MASTER_REDIRECT_URI) {
      return res.status(500).json({ error: 'Server misconfigured (Missing Master App Env Vars)' });
    }

    const consentUrl = `https://login.microsoftonline.com/common/adminconsent?client_id=${MASTER_CLIENT_ID}&state=${req.params.id}&redirect_uri=${encodeURIComponent(MASTER_REDIRECT_URI)}`;

    res.json({ success: true, consentUrl });
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

    res.json({ success: true, name_servers: zone.name_servers, zone_active: true });
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

router.post('/:id/email-auth', async (req, res) => {
  try {
    const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.tenant_id) {
      return res.status(400).json({ error: 'Tenant not connected to Microsoft (missing tenant_id)' });
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

router.get('/:id/nameservers/check', async (req, res) => {
  try {
    const tenant = getTenantByIdForUser(req.params.id, req.session.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    let expected = [];
    if (tenant.cloudflare_ns) {
      try {
        expected = JSON.parse(tenant.cloudflare_ns);
      } catch {
        expected = [];
      }
    }
    const expectedNormalized = expected
      .map(s => String(s || '').trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean);

    const resolvers = [
      new DnsResolver().setServers(['1.1.1.1']),
      new DnsResolver().setServers(['8.8.8.8'])
    ];

    const aggregate = new Set();
    const errors = [];
    for (const resolver of resolvers) {
      try {
        const records = await resolver.resolveNs(tenant.domain);
        records.forEach(r => {
          aggregate.add(String(r || '').trim().toLowerCase().replace(/\.$/, ''));
        });
      } catch (err) {
        errors.push(err?.message || String(err));
      }
    }

    const actual = Array.from(aggregate);
    const matched = expectedNormalized.filter(s => actual.includes(s));
    const verified = expectedNormalized.length > 0 && matched.length === expectedNormalized.length;

    return res.json({
      success: true,
      verified,
      expected: expectedNormalized,
      actual,
      matched,
      errors: errors.length ? errors : undefined
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to check nameservers' });
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
