import express from 'express';
import { createTenant, getTenants, getTenantById, updateTenantCloudflare, updateTenantStatus, deleteTenant } from '../db/database.js';
import { createZone } from '../services/cloudflare.js';
import { ensureSpfRecord, ensureDmarcRecord, ensureDkimRecords } from '../services/emailAuth.js';
import {
  loginToSecurityCenter,
  ensureDkimSelectors,
  retryEnableDkimSigning
} from '../services/securityCenterDkim.js';

const router = express.Router();
const { MASTER_CLIENT_ID, MASTER_REDIRECT_URI } = process.env;

const requireAuth = (req, res, next) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(requireAuth);

router.get('/', (req, res) => {
  try {
    const tenants = getTenants();
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
    const { name, admin_email, admin_password, domain } = req.body;

    if (!name || !domain || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'Name, Domain, Email, and Password are required' });
    }

    const result = createTenant({ name, admin_email, admin_password, domain });
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

router.post('/:id/connect', (req, res) => {
  try {
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
    const tenant = getTenantById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    if (tenant.cloudflare_zone_id && tenant.cloudflare_ns) {
      return res.json({
        success: true,
        name_servers: JSON.parse(tenant.cloudflare_ns)
      });
    }

    const zone = await createZone(tenant.domain);
    updateTenantCloudflare(tenant.id, zone.id, zone.name_servers);

    res.json({ success: true, name_servers: zone.name_servers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/email-auth', async (req, res) => {
  try {
    const tenant = getTenantById(req.params.id);
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
      const zone = await createZone(domain);
      zoneId = zone.id;
      updateTenantCloudflare(tenant.id, zone.id, zone.name_servers);
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
    updateTenantStatus(req.params.id, status);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = deleteTenant(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
