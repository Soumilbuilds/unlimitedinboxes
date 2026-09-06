import { Router } from 'express';
import {
  getOrderByIdForUser,
  getOrders,
  updateOrderStatus,
  createTenant,
  getTenants,
  updateTenantDetails,
  createOrderWithinQuota,
  claimOrderForProcessing,
  getOrderById
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import { chargeSavedPaymentMethodForQuota } from '../services/stripe.js';
import { processOrder, hasActiveJob } from '../services/orderProcessor.js';
import { getUserByEmail } from '../db/database.js';
import { validateApiKey } from '../services/apiKey.js';
import { isValidTotpSecret } from '../services/totp.js';

const router = Router();

async function refreshAccessState(req) {
  if (req.session.user?.email) {
    const latest = getUserByEmail(req.session.user.email);
    if (latest) {
      req.session.user.plan = latest.plan || 'free';
      req.session.user.id = latest.id;
      req.session.user.billingStatus = latest.whop_membership_status || latest.xpay_subscription_status || null;
      req.accessState = getUserAccessState(latest);
    }
  }
}

router.get('/', (req, res) => {
  res.json({
    name: 'Unlimited Inboxes API',
    version: '1.0',
    description: 'Manage orders, status checks, and downloads programmatically.',
    documentation: '/api'
  });
});

const requireApiKey = async (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing API key' });

  const user = await validateApiKey(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

  req.user = user;
  req.session.user = user;
  req.session.authenticated = true;
  await refreshAccessState(req);
  next();
};

router.get('/orders/stats', requireApiKey, async (req, res) => {
  try {
    const accessState = req.accessState || getUserAccessState(req.session.user);
    if (!accessState.canAccessApi) {
      return res.status(403).json({ error: 'API is not available on your plan.' });
    }

    const orders = getOrders(req.session.user.id);
    const stats = {
      total: orders.length,
      by_status: {
        pending: orders.filter(o => o.status === 'pending').length,
        processing: orders.filter(o => o.status === 'processing').length,
        completed: orders.filter(o => o.status === 'completed').length,
        failed: orders.filter(o => o.status === 'failed').length,
        cancelled: orders.filter(o => o.status === 'cancelled').length
      },
      total_mailboxes: orders.reduce((sum, o) => sum + (o.total_mailboxes || 0), 0),
      completed_mailboxes: orders.reduce((sum, o) => {
        const mailboxes = JSON.parse(o.created_mailboxes || '[]');
        return sum + mailboxes.length;
      }, 0)
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/by-domain/:domain', requireApiKey, async (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();
    const orders = getOrders(req.session.user.id);
    const order = orders.find(o => o.tenant_domain?.toLowerCase() === domain);
    if (!order) return res.status(404).json({ error: 'No order found for this domain' });

    // Get tenant for nameservers
    const { getTenantByIdForUser } = await import('../db/database.js');
    const tenant = getTenantByIdForUser(order.tenant_id, req.session.user.id);
    const nameServers = tenant?.cloudflare_ns ? JSON.parse(tenant.cloudflare_ns) : null;

    const mailboxes = JSON.parse(order.created_mailboxes || '[]');
    res.json({
      id: order.id,
      status: order.status,
      progress: order.progress,
      total_mailboxes: order.total_mailboxes,
      created_mailboxes_count: mailboxes.length,
      tenant_domain: order.tenant_domain,
      tenant_name: order.tenant_name,
      order_name: order.order_name,
      error_message: order.error_message,
      name_servers: nameServers,
      nameservers_updated: order.status !== 'pending_ns',
      created_at: order.created_at,
      updated_at: order.updated_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/by-domain/:domain/download', requireApiKey, async (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();
    const orders = getOrders(req.session.user.id);
    const order = orders.find(o => o.tenant_domain?.toLowerCase() === domain);
    if (!order) return res.status(404).json({ error: 'No order found for this domain' });

    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Order is not completed yet' });
    }

    const accessState = req.accessState || getUserAccessState(req.session.user);
    if (accessState.downloadAllowance <= 0) {
      return res.status(403).json({
        code: 'API_DOWNLOAD_NOT_ALLOWED',
        error: 'Download is available on paid plans only.'
      });
    }

    const mailboxes = JSON.parse(order.created_mailboxes || '[]');
    const limit = Number.isFinite(accessState.downloadAllowance)
      ? accessState.downloadAllowance
      : mailboxes.length;
    const rows = mailboxes.slice(0, limit);

    const csvLines = ['email,password'];
    rows.forEach(m => {
      const email = (m.email || '').replace(/"/g, '""');
      const password = (m.password || '').replace(/"/g, '""');
      csvLines.push(`"${email}","${password}"`);
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${domain}-mailboxes.csv"`);
    res.send(csvLines.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders', requireApiKey, async (req, res) => {
  try {
    const {
      tenant_domain,
      admin_email,
      admin_password,
      mfa_secret,
      total_mailboxes,
      mailbox_password,
      order_name
    } = req.body;

    // Validate required fields
    if (!tenant_domain) {
      return res.status(400).json({ error: 'tenant_domain is required' });
    }
    if (!admin_email) {
      return res.status(400).json({ error: 'admin_email is required' });
    }
    if (!admin_password) {
      return res.status(400).json({ error: 'admin_password is required' });
    }
    if (!mfa_secret) {
      return res.status(400).json({ error: 'mfa_secret is required' });
    }
    if (!mailbox_password) {
      return res.status(400).json({ error: 'mailbox_password is required' });
    }

    const normalizedMfaSecret = String(mfa_secret).replace(/\s+/g, '').toUpperCase();
    if (!isValidTotpSecret(normalizedMfaSecret)) {
      return res.status(400).json({ error: 'Enter a valid mfa_secret' });
    }

    // Validate password strength
    if (!validateMailboxPassword(mailbox_password)) {
      return res.status(400).json({
        error: 'Password must be 8-256 chars and include at least 3 of: uppercase, lowercase, number, symbol.'
      });
    }

    // Validate total_mailboxes
    const mailboxTotal = parseInt(total_mailboxes, 10) || 100;
    if (mailboxTotal < 1 || mailboxTotal > 500) {
      return res.status(400).json({ error: 'total_mailboxes must be between 1 and 500' });
    }

    // Check billing access
    const accessState = req.accessState || getUserAccessState(req.session.user);
    if (!accessState.canAccessApp) {
      return res.status(403).json({
        code: 'BILLING_REQUIRED',
        error: 'No active trial or subscription found.'
      });
    }

    // Check API access
    if (!accessState.canAccessApi) {
      return res.status(403).json({
        code: 'API_NOT_AVAILABLE',
        error: 'API is not available on your plan. Upgrade to Reseller or Pay As You Go plan.',
      });
    }

    // Check perOrder quota
    if (accessState.effectivePlan === 'perOrder') {
      const { getAvailableOrders } = await import('../db/database.js');
      const available = getAvailableOrders(req.session.user.id);
      if (available <= 0) {
        // Attempt auto-charge
        try {
          const chargeResult = await chargeSavedPaymentMethodForQuota(req.session.user, 3);
          if (chargeResult.paid) {
            // Credit added, allow order to proceed
          } else {
            return res.status(402).json({
              code: 'NO_ORDER_QUOTA',
              error: 'No order credits remaining. Please top up to continue.',
              topUpRequired: true,
            });
          }
        } catch (e) {
          return res.status(402).json({
            code: 'NO_ORDER_QUOTA',
            error: 'No order credits remaining. Please top up to continue.',
            topUpRequired: true,
          });
        }
      }
    }

    // Check completed order limit
    if (!accessState.canCreateMoreThanOneCompletedOrder) {
      const existingOrders = getOrders(req.session.user.id);
      const hasCompleted = existingOrders.some(o => o.status === 'completed');
      if (hasCompleted) {
        return res.status(403).json({
          error: 'This account has already used its included completed order. Upgrade to continue.'
        });
      }
    }

    // Check for existing tenant with same domain
    const existingTenants = getTenants(req.session.user.id);
    let tenant = existingTenants.find(t => t.domain?.toLowerCase() === tenant_domain.toLowerCase());

    if (tenant) {
      // Check if this tenant already has an active (non-cancelled) order
      const existingOrders = getOrders(req.session.user.id).filter(
        o => o.tenant_id === tenant.id && !['cancelled', 'failed'].includes(o.status)
      );
      if (existingOrders.length > 0) {
        return res.status(409).json({
          code: 'TENANT_ALREADY_USED',
          error: `Domain ${tenant_domain} already has an active order (#${existingOrders[0].id}). Use a different domain or restart the existing order.`
        });
      }
      updateTenantDetails(tenant.id, {
        admin_email: admin_email.toLowerCase(),
        admin_password,
        mfa_secret: normalizedMfaSecret
      });
      tenant = {
        ...tenant,
        admin_email: admin_email.toLowerCase(),
        admin_password,
        mfa_secret: normalizedMfaSecret
      };
    } else {
      // Create new tenant
      const tenantName = tenant_domain.split('.')[0];
      const newTenant = {
        user_id: req.session.user.id,
        name: tenantName,
        domain: tenant_domain.toLowerCase(),
        admin_email: admin_email.toLowerCase(),
        admin_password,
        mfa_secret: normalizedMfaSecret
      };
      const tenantId = createTenant(newTenant);
      tenant = { id: tenantId, ...newTenant };
    }

    // Generate order name
    const safeName = typeof order_name === 'string' && order_name.trim()
      ? order_name.trim()
      : `${new Date().toLocaleString('default', { month: 'short', year: 'numeric' })}-${tenant_domain}`;

    // Create order
    const orderId = createOrderWithinQuota({ tenantId: tenant.id, totalMailboxes: mailboxTotal, mailboxPassword: mailbox_password, orderName: safeName, userId: req.session.user.id, inboxesLimit: accessState.inboxesLimit });

    const order = getOrderById(orderId);

    // Get nameservers for the tenant
    const { createZone } = await import('../services/cloudflare.js');
    let nameServers = null;
    let zoneId = null;
    let zoneActive = false;

    try {
      const zone = await createZone(tenant_domain.toLowerCase());
      nameServers = zone.name_servers;
      zoneId = zone.id;
      zoneActive = true;

      // Update tenant with Cloudflare info
      const { updateTenantCloudflare } = await import('../db/database.js');
      updateTenantCloudflare(tenant.id, zone.id, nameServers);
    } catch (zoneError) {
      console.log('[API] Cloudflare zone creation skipped:', zoneError.message);
    }

    res.status(201).json({
      id: order.id,
      status: order.status,
      progress: order.progress,
      total_mailboxes: order.total_mailboxes,
      tenant_domain: order.tenant_domain,
      tenant_name: order.tenant_name,
      order_name: order.order_name,
      created_at: order.created_at,
      name_servers: nameServers,
      next_step: 'Update your domain\'s nameservers to the values above, then call POST /api/orders/:id/start to begin processing.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function validateMailboxPassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8 || password.length > 256) return false;
  let categories = 0;
  if (/[A-Z]/.test(password)) categories += 1;
  if (/[a-z]/.test(password)) categories += 1;
  if (/[0-9]/.test(password)) categories += 1;
  if (/[^A-Za-z0-9]/.test(password)) categories += 1;
  return categories >= 3;
}

router.get('/orders', requireApiKey, async (req, res) => {
  try {
    const orders = getOrders(req.session.user.id);
    res.json(orders.map(order => ({
      id: order.id,
      status: order.status,
      progress: order.progress,
      total_mailboxes: order.total_mailboxes,
      tenant_domain: order.tenant_domain,
      tenant_name: order.tenant_name,
      order_name: order.order_name,
      created_at: order.created_at,
      updated_at: order.updated_at
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id', requireApiKey, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = getOrderByIdForUser(orderId, req.session.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const mailboxes = JSON.parse(order.created_mailboxes || '[]');
    res.json({
      id: order.id,
      status: order.status,
      progress: order.progress,
      total_mailboxes: order.total_mailboxes,
      created_mailboxes_count: mailboxes.length,
      tenant_domain: order.tenant_domain,
      tenant_name: order.tenant_name,
      order_name: order.order_name,
      error_message: order.error_message,
      created_at: order.created_at,
      updated_at: order.updated_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/start', requireApiKey, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = getOrderByIdForUser(orderId, req.session.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status === 'processing') {
      if (hasActiveJob(order.id)) {
        return res.status(400).json({ error: 'Order is already processing' });
      }
      processOrder(order.id);
      return res.json({ success: true, message: 'Processing resumed' });
    }

    if (!['pending', 'failed'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot start order in "${order.status}" status` });
    }

    const processingOrders = getOrders(req.session.user.id)
      .filter(o => o.id !== orderId && o.status === 'processing');
    const accessState = req.accessState || getUserAccessState(req.session.user);

    // Check API access
    if (!accessState.canAccessApi) {
      return res.status(403).json({
        code: 'API_NOT_AVAILABLE',
        error: 'API is not available on your plan.',
      });
    }

    // Check perOrder quota
    if (accessState.effectivePlan === 'perOrder') {
      const { getAvailableOrders } = await import('../db/database.js');
      const available = getAvailableOrders(req.session.user.id);
      if (available <= 0) {
        return res.status(402).json({
          code: 'NO_ORDER_QUOTA',
          error: 'No order credits remaining. Please top up to continue.',
          topUpRequired: true,
        });
      }
    }

    if (
      accessState.maxConcurrentOrders !== Number.POSITIVE_INFINITY
      && processingOrders.length >= accessState.maxConcurrentOrders
    ) {
      return res.status(409).json({
        code: 'ORDER_CONCURRENCY_LIMIT',
        error: 'Only one order can be processed at a time on the current plan.'
      });
    }

    const claim = claimOrderForProcessing({ orderId, userId: req.session.user.id, maxConcurrentOrders: accessState.maxConcurrentOrders, inboxesLimit: accessState.inboxesLimit });
    if (!claim.claimed) return res.status(409).json({ code: 'ORDER_START_BLOCKED', error: `Order cannot start: ${claim.reason}` });
    processOrder(orderId);

    res.json({ success: true, message: 'Processing started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id/download', requireApiKey, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = getOrderByIdForUser(orderId, req.session.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Order is not completed yet' });
    }

    const accessState = req.accessState || getUserAccessState(req.session.user);
    if (accessState.downloadAllowance <= 0) {
      return res.status(403).json({
        code: 'API_DOWNLOAD_NOT_ALLOWED',
        error: 'Download is available on paid plans only.'
      });
    }

    const mailboxes = JSON.parse(order.created_mailboxes || '[]');
    const limit = Number.isFinite(accessState.downloadAllowance)
      ? accessState.downloadAllowance
      : mailboxes.length;
    const rows = mailboxes.slice(0, limit);

    const csvLines = ['email,password'];
    rows.forEach(m => {
      const email = (m.email || '').replace(/"/g, '""');
      const password = (m.password || '').replace(/"/g, '""');
      csvLines.push(`"${email}","${password}"`);
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="order-${orderId}-mailboxes.csv"`);
    res.send(csvLines.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
