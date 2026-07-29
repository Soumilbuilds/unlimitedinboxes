import { getUserByEmail } from '../db/database.js';
import { getUserAccessState } from '../services/access.js';

export function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function attachAccessState(req, _res, next) {
  if (req.session.user?.email) {
    const latest = getUserByEmail(req.session.user.email);
    if (latest) {
      req.session.user.plan = latest.plan || 'free';
      req.session.user.id = latest.id;
      req.session.user.billingStatus = latest.xpay_subscription_status || null;
      req.accessState = getUserAccessState(latest);
    }
  }
  next();
}