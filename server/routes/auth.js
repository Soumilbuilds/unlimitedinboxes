import { Router } from 'express';
import { updateTenantId } from '../db/database.js';

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@unlimitedinboxes.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin account';

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.user = { email };
    return res.json({ success: true, user: { email } });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

router.get('/check', (req, res) => {
  if (req.session.authenticated) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  return res.json({ authenticated: false });
});

router.get('/callback', (req, res) => {
  const { tenant, error, error_description, state } = req.query;

  if (error) {
    return res.send(`<h1>Error</h1><p>${error_description}</p>`);
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
