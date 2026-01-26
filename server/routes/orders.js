import { Router } from 'express';
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
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
  next();
};

router.use(requireAuth);

router.get('/', (req, res) => {
  try {
    const orders = getOrders();
    res.json(orders.map(order => ({
      ...order,
      created_mailboxes: JSON.parse(order.created_mailboxes || '[]')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { tenant_id, total_mailboxes, mailbox_password } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'Tenant ID is required' });
    if (!isValidMailboxPassword(mailbox_password)) {
      return res.status(400).json({
        error: 'Password must be 8-256 chars and include at least 3 of: uppercase, lowercase, number, symbol.'
      });
    }

    const orderId = createOrder(tenant_id, total_mailboxes || 100, mailbox_password);
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
    const order = getOrderById(parseInt(req.params.id, 10));
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
    const success = cancelOrder(parseInt(req.params.id, 10));
    if (success) return res.json({ success: true, message: 'Order cancelled' });
    res.status(400).json({ error: 'Order is not being processed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const order = getOrderById(parseInt(req.params.id, 10));
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
    const inMemory = getOrderLogs(orderId);
    if (inMemory) return res.json(inMemory);

    const stored = getStoredLogs(orderId);
    res.json(stored);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
