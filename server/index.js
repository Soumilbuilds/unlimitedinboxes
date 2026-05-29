import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import tenantRoutes from './routes/tenants.js';
import orderRoutes from './routes/orders.js';
import redirectRoutes from './routes/redirects.js';
import apiRoutes from './routes/api.js';
import apiKeyRoutes from './routes/apiKeys.js';
import { resumeInterruptedOrders } from './services/orderProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';
const orderResumeIntervalMs = Math.max(Number(process.env.ORDER_RESUME_INTERVAL_MS || 30000) || 30000, 5000);
const orderResumeEnabled = process.env.ORDER_RESUME_ENABLED !== 'false';
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);
const useSecureCookie = !isProd || process.env.FORCE_HTTPS === 'true';
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = buffer.toString('utf8');
  }
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'unlimited-mailboxes-secret',
  resave: false,
  saveUninitialized: false,
  proxy: isProd,
  cookie: {
    secure: useSecureCookie,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/redirects', redirectRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api', apiRoutes);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
      }

      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  app.get('*', (req, res) => {
    // Only return 404 for /api/* paths that didn't match a route, not /api-docs or other /api-xxx paths
    if (req.path.startsWith('/api/') || req.path === '/api') {
      return res.status(404).json({ error: 'API route not found' });
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../client/dist', 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);

  if (!orderResumeEnabled) {
    console.log('Order resume worker disabled.');
    return;
  }

  resumeInterruptedOrders();

  const resumer = setInterval(() => {
    resumeInterruptedOrders();
  }, orderResumeIntervalMs);

  if (typeof resumer.unref === 'function') {
    resumer.unref();
  }
});
