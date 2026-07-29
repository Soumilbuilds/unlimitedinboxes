import { Router } from 'express';
import crypto from 'crypto';
import https from 'https';
import { createUser, getUserByEmail, updateTenantId } from '../db/database.js';
import { generateApiKey, hashApiKey } from '../services/apiKey.js';
import { createApiKey } from '../db/database.js';

const router = Router();

const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 64;
const PASSWORD_DIGEST = 'sha512';
const SIGNUP_WEBHOOK_URL = 'https://services.leadconnectorhq.com/hooks/6jbkkZvIM2UYuqLG0b6v/webhook-trigger/a6efae18-81e7-4ac8-b7b5-d8934ca19d1d';

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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function serializeSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan || 'free',
    billingStatus: user.xpay_subscription_status || null
  };
}

async function sendSignupWebhook(email) {
  const payload = JSON.stringify({ email });
  const target = new URL(SIGNUP_WEBHOOK_URL);
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'user-agent': 'UnlimitedInboxesSignupWebhook/1.0'
    }
  };

  const executeAttempt = () => new Promise((resolve, reject) => {
    const request = https.request(requestOptions, (response) => {
      let responseBody = '';

      response.on('data', (chunk) => {
        responseBody += chunk.toString();
      });

      response.on('end', () => {
        const statusCode = response.statusCode || 0;
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ statusCode, responseBody });
          return;
        }

        reject(new Error(`Webhook returned ${statusCode}: ${responseBody || 'empty response'}`));
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(new Error('Webhook request timed out after 15000ms'));
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await executeAttempt();
      return true;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  return false;
}

async function createAccount(req, res, { authenticate = false } = {}) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = normalizeEmail(email);
  const existing = getUserByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'Account already exists. Sign in instead.' });
  }

  const { hash, salt } = hashPassword(password);
  const targetPlan = 'free';

  try {
    const result = createUser(normalizedEmail, hash, salt, targetPlan);
    const createdUser = getUserByEmail(normalizedEmail);

    let rawApiKey = null;
    // Auto-generate API key for new user
    if (createdUser) {
      rawApiKey = generateApiKey();
      const hashedApiKey = hashApiKey(rawApiKey);
      createApiKey(createdUser.id, hashedApiKey);
    }

    try {
      await sendSignupWebhook(normalizedEmail);
    } catch (webhookError) {
      console.error(`Signup webhook failed for ${normalizedEmail}: ${webhookError.message}`);
    }

    if (authenticate && createdUser) {
      req.session.authenticated = true;
      req.session.user = serializeSessionUser(createdUser);
      return res.json({ success: true, user: req.session.user, apiKey: rawApiKey });
    }

    return res.json({ success: true, id: result.lastInsertRowid, email: normalizedEmail, plan: targetPlan, apiKey: rawApiKey });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

router.post('/create', (req, res) => createAccount(req, res));
router.post('/signup', (req, res) => createAccount(req, res, { authenticate: true }));

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = normalizeEmail(email);
  const user = getUserByEmail(normalizedEmail);
  if (!user) {
    return res.status(404).json({ error: 'Account not found. Sign up instead.' });
  }
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  req.session.authenticated = true;
  req.session.user = serializeSessionUser(user);
  return res.json({ success: true, user: req.session.user });
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

  const extractTenantId = (description = '') => {
    const text = String(description);
    const match = text.match(/tenant\s*[:=]?\s*([0-9a-fA-F-]{36})/i);
    return match && match[1] ? match[1] : null;
  };

  const resolveDbId = () => {
    const rawState = Array.isArray(state) ? state[0] : state;
    const parsedState = Number.parseInt(rawState, 10);
    if (Number.isFinite(parsedState)) return parsedState;
    const fallback = Number.parseInt(req.session?.pendingConsentTenantId, 10);
    return Number.isFinite(fallback) ? fallback : null;
  };

  if (error) {
    const description = String(error_description || '');
    const normalized = description.toLowerCase();
    const alreadyExists = normalized.includes('service principal name is already present for the tenant')
      || normalized.includes('service principal name is already present for tenant')
      || normalized.includes('aadsts650051');

    if (alreadyExists) {
      const tenantId = (Array.isArray(tenant) ? tenant[0] : tenant) || extractTenantId(description);
      const dbId = resolveDbId();
      if (tenantId && dbId) {
        try {
          updateTenantId(dbId, tenantId);
          req.session.pendingConsentTenantId = null;
          return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: #34d399;">Consent Successful!</h1>
              <p>Tenant ID: <strong>${tenantId}</strong> has been connected.</p>
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
      const missing = [
        !tenantId ? 'tenant id' : null,
        !dbId ? 'state' : null
      ].filter(Boolean).join(' and ');
      return res.send(`<h1>Error</h1><p>Consent appears to have already been granted, but the ${missing} could not be resolved. Close this window and try again from the app.</p>`);
    }

    return res.send(`<h1>Error</h1><p>${description}</p>`);
  }

  if (!tenant) {
    return res.send('<h1>Error</h1><p>No tenant ID returned.</p>');
  }

  const dbId = resolveDbId();
  if (!dbId) {
    return res.send('<h1>Error</h1><p>No state returned (Unknown Tenant DB ID).</p>');
  }

  try {
    updateTenantId(dbId, tenant);
    req.session.pendingConsentTenantId = null;
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
