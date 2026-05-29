import { Router } from 'express';
import {
  getOrderByIdForUser,
  getOrders,
  updateOrderStatus
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import { processOrder, hasActiveJob } from '../services/orderProcessor.js';
import { getUserByEmail } from '../db/database.js';

const router = Router();

async function refreshAccessState(req) {
  if (req.session.user?.email) {
    const latest = getUserByEmail(req.session.user.email);
    if (latest) {
      req.session.user.plan = latest.plan || 'free';
      req.session.user.id = latest.id;
      req.session.user.billingStatus = latest.stripe_subscription_status || null;
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

  const { validateApiKey } = await import('../services/apiKey.js');
  const user = await validateApiKey(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

  req.user = user;
  req.session.user = user;
  req.session.authenticated = true;
  await refreshAccessState(req);
  next();
};

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

    if (!['pending', 'failed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot start order in "${order.status}" status` });
    }

    const processingOrders = getOrders(req.session.user.id)
      .filter(o => o.id !== orderId && o.status === 'processing');
    const accessState = req.accessState || getUserAccessState(req.session.user);
    if (
      accessState.maxConcurrentOrders !== Number.POSITIVE_INFINITY
      && processingOrders.length >= accessState.maxConcurrentOrders
    ) {
      return res.status(409).json({
        code: 'ORDER_CONCURRENCY_LIMIT',
        error: 'Only one order can be processed at a time on the current plan.'
      });
    }

    updateOrderStatus(orderId, 'processing');
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
    if (!accessState.canDownloadAll || accessState.downloadAllowance <= 0) {
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