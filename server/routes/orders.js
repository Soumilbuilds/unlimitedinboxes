import { Router } from 'express';
import {
  createOrder,
  getOrders,
  getOrderById,
  getOrderByIdForUser,
  getTenantByIdForUser,
  getUserByEmail,
  updateOrderStatus,
  addOrderLog,
  deleteOrder,
  getOrderLogs as getStoredLogs
} from '../db/database.js';
import { processOrder, cancelOrder, getOrderLogs } from '../services/orderProcessor.js';

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
router.use((req, _res, next) => {
  if (req.session.user?.email) {
    const latest = getUserByEmail(req.session.user.email);
    if (latest) {
      req.session.user.plan = latest.plan || 'free';
      req.session.user.id = latest.id;
    }
  }
  next();
});

const FREE_PLANS = new Set(['free', '25', '50', '100']);

function isFreePlan(plan) {
  return FREE_PLANS.has(String(plan || 'free'));
}

function getDownloadAllowance(plan) {
  const normalized = String(plan || 'free');
  if (normalized === 'paid') return Number.POSITIVE_INFINITY;
  if (normalized === '100') return 100;
  if (normalized === '50') return 50;
  if (normalized === '25') return 25;
  return 0;
}

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

function maskNamesInText(text) {
  if (!text) return text;
  let output = String(text);

  // Creating: Full Name (email)
  output = output.replace(/(Creating:\s*)([^()]+)(\s*\()/gi, (_m, prefix, name, suffix) => {
    return `${prefix}${maskName(name)}${suffix}`;
  });

  // Creating mailbox Full Name...
  output = output.replace(/(Creating mailbox\s+)([^.]+)(\.\.\.)/gi, (_m, prefix, name, suffix) => {
    return `${prefix}${maskName(name)}${suffix}`;
  });

  // Creating mailbox: Full Name
  output = output.replace(/(Creating mailbox:\s*)(.+)$/gi, (_m, prefix, name) => {
    return `${prefix}${maskName(name)}`;
  });

  return output;
}

function maskSensitiveText(text) {
  return maskEmailsInText(maskNamesInText(text));
}

function maybeMaskOrder(order, plan) {
  if (plan === 'paid' || !order) return order;
  const allowance = getDownloadAllowance(plan);
  const created = Array.isArray(order.created_mailboxes) ? order.created_mailboxes : [];
  return {
    ...order,
    created_mailboxes: created.map((m, idx) => {
      if (allowance > idx) {
        return m;
      }
      return {
        ...m,
        name: m?.name ? maskName(m.name) : m?.name,
        email: m?.email ? maskEmail(m.email) : m?.email
      };
    })
  };
}

router.get('/', (req, res) => {
  try {
    const orders = getOrders(req.session.user.id);
    const plan = req.session.user.plan || 'free';
    res.json(orders.map(order => maybeMaskOrder({
      ...order,
      created_mailboxes: JSON.parse(order.created_mailboxes || '[]')
    }, plan)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { tenant_id, total_mailboxes, mailbox_password, order_name } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'Tenant ID is required' });
    if (!isValidMailboxPassword(mailbox_password)) {
      return res.status(400).json({
        error: 'Password must be 8-256 chars and include at least 3 of: uppercase, lowercase, number, symbol.'
      });
    }

    const tenant = getTenantByIdForUser(tenant_id, req.session.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const plan = req.session.user.plan || 'free';
    if (isFreePlan(plan)) {
      const existing = getOrders(req.session.user.id);
      const hasCompleted = existing.some(o => o.status === 'completed');
      if (hasCompleted) {
        return res.status(403).json({ error: 'Free plan allows only one completed order.' });
      }
    }

    const safeName = typeof order_name === 'string' && order_name.trim() ? order_name.trim() : null;
    const mailboxTotal = isFreePlan(plan) ? 100 : (total_mailboxes || 100);
    const orderId = createOrder(tenant_id, mailboxTotal, mailbox_password, safeName, req.session.user.id);
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

    if (order.status === 'processing') {
      return res.status(400).json({ error: 'Order is already processing' });
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
    const plan = req.session.user.plan || 'free';
    const inMemory = getOrderLogs(orderId);
    if (inMemory) {
      const mapped = plan === 'paid'
        ? inMemory
        : inMemory.map(entry => ({ ...entry, message: maskSensitiveText(entry.message) }));
      return res.json(mapped);
    }

    const stored = getStoredLogs(orderId);
    const mapped = plan === 'paid'
      ? stored
      : stored.map(entry => ({ ...entry, message: maskSensitiveText(entry.message) }));
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
