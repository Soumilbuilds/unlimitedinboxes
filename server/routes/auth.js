import { Router } from 'express';
import crypto from 'crypto';
import { createUser, getUserByEmail, updateUserPlanByEmail, updateTenantId } from '../db/database.js';
import { isWhopSyncConfigured, syncUserBillingState } from '../services/whop.js';

const router = Router();

const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 64;
const PASSWORD_DIGEST = 'sha512';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const nextHash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
  const safeA = Buffer.from(hash, 'hex');
  const safeB = Buffer.from(nextHash, 'hex');
  if (safeA.length !== safeB.length) return false;
  return crypto.timingSafeEqual(safeA, safeB);
}

function normalizePlan(plan) {
  const normalized = String(plan || 'free').toLowerCase();
  const allowed = new Set(['free', 'paid', '25', '50', '100']);
  if (allowed.has(normalized)) return normalized;
  return normalized === 'paid' ? 'paid' : 'free';
}

function serializeSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan || 'free',
    billingStatus: user.whop_membership_status || null
  };
}

router.post('/create', (req, res) => {
  const { email, password, plan } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const existing = getUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'Account already exists' });
  }

  const { hash, salt } = hashPassword(password);
  const targetPlan = normalizePlan(plan);
  try {
    const result = createUser(email, hash, salt, targetPlan);
    return res.json({ success: true, id: result.lastInsertRowid, email, plan: targetPlan });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/upgrade', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const existing = getUserByEmail(email);
  if (existing) {
    if (!verifyPassword(password, existing.password_hash, existing.password_salt)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    updateUserPlanByEmail(email, 'paid');
    return res.json({ success: true, email, plan: 'paid', upgraded: true });
  }

  const { hash, salt } = hashPassword(password);
  try {
    const result = createUser(email, hash, salt, 'paid');
    return res.json({ success: true, id: result.lastInsertRowid, email, plan: 'paid', created: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/downgrade', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const existing = getUserByEmail(email);
  if (!existing) {
    return res.status(404).json({ error: 'Account not found' });
  }
  updateUserPlanByEmail(email, 'free');
  return res.json({ success: true, email, plan: 'free', downgraded: true });
});

router.post('/set-plan', (req, res) => {
  const { email, plan } = req.body;
  if (!email || !plan) {
    return res.status(400).json({ error: 'Email and plan are required' });
  }
  const existing = getUserByEmail(email);
  if (!existing) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const targetPlan = normalizePlan(plan);
  updateUserPlanByEmail(email, targetPlan);
  return res.json({ success: true, email, plan: targetPlan, updated: true });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    if (isWhopSyncConfigured()) {
      await syncUserBillingState(user, { forceRecovery: true });
    }

    const latest = getUserByEmail(email) || user;
    req.session.authenticated = true;
    req.session.user = serializeSessionUser(latest);
    return res.json({ success: true, user: req.session.user });
  } catch (error) {
    req.session.authenticated = true;
    req.session.user = serializeSessionUser(user);
    return res.json({ success: true, user: req.session.user, billingWarning: error.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

router.get('/check', async (req, res) => {
  if (req.session.authenticated) {
    if (req.session.user?.email) {
      const current = getUserByEmail(req.session.user.email);
      if (current) {
        try {
          if (isWhopSyncConfigured()) {
            await syncUserBillingState(current, { forceRecovery: true });
          }
        } catch (_error) {
          // Keep the last known local plan if Whop is temporarily unavailable.
        }

        const latest = getUserByEmail(req.session.user.email) || current;
        req.session.user = serializeSessionUser(latest);
      }
    }
    return res.json({ authenticated: true, user: req.session.user });
  }
  return res.json({ authenticated: false });
});

router.get('/callback', (req, res) => {
  const { tenant, error, error_description, state } = req.query;

  if (error) {
    const description = String(error_description || '');
    const alreadyExists = description.includes('service principal name is already present for the tenant');
    if (alreadyExists && state) {
      const match = description.match(/tenant\\s+([0-9a-fA-F-]{36})/);
      if (match && match[1]) {
        try {
          updateTenantId(parseInt(state, 10), match[1]);
          return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: #34d399;">Consent Successful!</h1>
              <p>Tenant ID: <strong>${match[1]}</strong> has been connected.</p>
              <p>You can close this window and refresh the dashboard.</p>
              <script>
                setTimeout(() => window.close(), 3000);
              </script>
            </div>
          `);
        } catch (e) {
          return res.send(`<h1>Error</h1><p>Database Update Failed: ${e.message}</p>`);
        }
      }
    }
    return res.send(`<h1>Error</h1><p>${description}</p>`);
  }

  if (!tenant) {
    return res.send('<h1>Error</h1><p>No tenant ID returned.</p>');
  }

  if (!state) {
    return res.send('<h1>Error</h1><p>No state returned (Unknown Tenant DB ID).</p>');
  }

  const dbId = parseInt(state, 10);
  try {
    updateTenantId(dbId, tenant);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1 style="color: #34d399;">Consent Successful!</h1>
        <p>Tenant ID: <strong>${tenant}</strong> has been connected.</p>
        <p>You can close this window and refresh the dashboard.</p>
        <script>
          setTimeout(() => window.close(), 3000);
        </script>
      </div>
    `);
  } catch (e) {
    res.send(`<h1>Error</h1><p>Database Update Failed: ${e.message}</p>`);
  }
});

export default router;
