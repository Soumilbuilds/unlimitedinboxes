import { Router } from 'express';
import {
  getRedirectableDomains,
  getTenantByIdForUser,
  updateTenantCloudflare,
  updateTenantRedirect
} from '../db/database.js';
import { createZone, getZoneStatus, upsertZoneRedirect } from '../services/cloudflare.js';

const router = Router();

function safeParseNameServers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function normalizeRedirectUrl(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) {
    throw new Error('Redirect URL is required');
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Redirect URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('Redirect URL cannot include a username or password');
  }

  return url.toString();
}

router.use(requireAuth);

router.get('/', (req, res) => {
  try {
    const domains = getRedirectableDomains(req.session.user.id);
    res.json(domains);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load redirect domains' });
  }
});

router.put('/:tenantId', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId, 10);
    const tenant = getTenantByIdForUser(tenantId, req.session.user.id);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    if (!tenant.domain) {
      return res.status(400).json({ error: 'Tenant domain is missing' });
    }

    let redirectUrl;
    try {
      redirectUrl = normalizeRedirectUrl(req.body?.redirect_url);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const redirectHost = new URL(redirectUrl).hostname.toLowerCase();
    const rootHost = tenant.domain.toLowerCase();
    const wwwHost = `www.${rootHost}`;

    if (redirectHost === rootHost || redirectHost === wwwHost) {
      return res.status(400).json({
        error: 'Redirect URL must use a different hostname to avoid an infinite redirect loop.'
      });
    }

    let zoneId = tenant.cloudflare_zone_id;
    if (!zoneId) {
      try {
        const zone = await createZone(tenant.domain);
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

    const zoneStatus = await getZoneStatus(zoneId);
    const ns = zoneStatus?.name_servers?.length
      ? zoneStatus.name_servers
      : safeParseNameServers(tenant.cloudflare_ns);

    if (!zoneStatus || zoneStatus.status !== 'active') {
      const nsText = ns.length ? ns.join(', ') : 'check Cloudflare for assigned name servers';
      return res.status(400).json({
        error: `Cloudflare zone not active. Update nameservers at your registrar: ${nsText}`
      });
    }

    const result = await upsertZoneRedirect(zoneId, tenant.domain, redirectUrl);
    updateTenantRedirect(tenant.id, redirectUrl);

    res.json({
      success: true,
      tenant_id: tenant.id,
      domain: tenant.domain,
      redirect_url: redirectUrl,
      action: result.action
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update redirect' });
  }
});

export default router;
