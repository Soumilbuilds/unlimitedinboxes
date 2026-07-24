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
const useSecureCookie = isProd || process.env.FORCE_HTTPS === 'true';
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
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
  secret: process.env.SESSION_SECRET || 'development-only-session-secret',
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
app.use('/api/keys', apiKeyRoutes);
app.use('/api', apiRoutes);

// LLM documentation endpoint for AI agents
app.get('/api-docs/llms.txt', (req, res) => {
  const doc = `# Unlimited Inboxes API Documentation
# Version: 1.0
# Base URL: https://app.unlimitedinboxes.com

## Overview

Unlimited Inboxes is a SaaS platform that provisions Microsoft 365 shared mailboxes at scale. Users connect their Microsoft 365 tenant, configure their domain's nameservers, and the system automatically creates hundreds of mailboxes with randomized female names and secure passwords.

The API allows programmatic access to:
- Create orders to provision mailboxes
- Check order status and progress
- Download completed mailbox credentials as CSV
- Manage tenants and domains

## Authentication

All API endpoints (except this documentation) require authentication via API key.

### Header Format
\`\`\`
x-api-key: YOUR_API_KEY
\`\`\`

### Getting Your API Key
1. Log in to https://app.unlimitedinboxes.com
2. Navigate to API section (/api-docs)
3. Your API key is displayed there (or generate one if not existing)

## Endpoints

### 1. Create Order
**POST** \`/api/orders\`

Creates a new order, sets up Cloudflare DNS zone, and returns nameservers for domain configuration.

**Request Body:**
\`\`\`json
{
  "tenant_domain": "mycompany.com",
  "admin_email": "admin@mycompany.com",
  "admin_password": "YourAdminPassword123!",
  "mailbox_password": "SecureMailboxPassword123!",
  "total_mailboxes": 100,
  "order_name": "My First Batch"
}
\`\`\`

**Required Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| tenant_domain | string | Your domain (e.g., mycompany.com) - must be purchasable and configurable |
| admin_email | string | Microsoft 365 admin email (Global Admin role required) |
| admin_password | string | Microsoft 365 admin password |
| mailbox_password | string | Password for ALL mailboxes (8-256 chars, must have 3 of: uppercase, lowercase, number, symbol) |
| total_mailboxes | integer | Optional, default 100, range 1-500 |
| order_name | string | Optional custom name for the order |

**Response:**
\`\`\`json
{
  "id": 148,
  "status": "pending",
  "progress": 0,
  "total_mailboxes": 100,
  "tenant_domain": "mycompany.com",
  "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"],
  "next_step": "Update your domain's nameservers, then call POST /api/orders/:id/start"
}
\`\`\`

**Next Steps After Creating Order:**
1. Update your domain's nameservers to the values returned in \`name_servers\`
2. Wait for DNS propagation (typically 5-30 minutes)
3. Call \`POST /api/orders/:id/start\` to begin mailbox creation

---

### 2. List Orders
**GET** \`/api/orders\`

Returns all orders for the authenticated user.

**Response:**
\`\`\`json
[
  {
    "id": 1,
    "status": "completed",
    "progress": 100,
    "total_mailboxes": 100,
    "tenant_domain": "example.com",
    "order_name": "May-2026-1"
  }
]
\`\`\`

---

### 3. Get Order Statistics
**GET** \`/api/orders/stats\`

Returns aggregated statistics across all orders.

**Response:**
\`\`\`json
{
  "total": 5,
  "by_status": {
    "pending": 1,
    "processing": 0,
    "completed": 3,
    "failed": 1,
    "cancelled": 0
  },
  "total_mailboxes": 500,
  "completed_mailboxes": 300
}
\`\`\`

---

### 4. Get Order by ID
**GET** \`/api/orders/:id\`

Returns detailed information about a specific order.

**Parameters:**
- \`id\` (path) - Order ID (integer)

**Response:**
\`\`\`json
{
  "id": 1,
  "status": "completed",
  "progress": 100,
  "total_mailboxes": 100,
  "created_mailboxes_count": 100,
  "tenant_domain": "example.com",
  "error_message": null
}
\`\`\`

---

### 5. Get Order by Domain
**GET** \`/api/orders/by-domain/:domain\`

Find an order by its tenant domain name. Use this to check if nameservers are configured.

**Parameters:**
- \`domain\` (path) - Tenant domain (e.g., example.com)

**Response:**
\`\`\`json
{
  "id": 1,
  "status": "processing",
  "progress": 45,
  "tenant_domain": "example.com",
  "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"],
  "nameservers_updated": false
}
\`\`\`

**Status Values:**
- \`pending\` - Order created, waiting for nameserver configuration
- \`pending_ns\` - Nameservers detected but not yet verified
- \`processing\` - Mailbox creation in progress
- \`completed\` - All mailboxes created successfully
- \`failed\` - Order failed (check \`error_message\`)

---

### 6. Start/Resume Order Processing
**POST** \`/api/orders/:id/start\`

Starts or resumes processing for an order. Call this AFTER updating nameservers.

**Parameters:**
- \`id\` (path) - Order ID (integer)

**Response:**
\`\`\`json
{
  "success": true,
  "message": "Processing started"
}
\`\`\`

---

### 7. Download Mailboxes as CSV (by ID)
**GET** \`/api/orders/:id/download\`

Downloads mailbox credentials as a CSV file. Only works for completed orders.

**Parameters:**
- \`id\` (path) - Order ID (integer)

**Response:** CSV file download
\`\`\`
email,password
mailbox1@example.com,SecurePass123!
mailbox2@example.com,SecurePass123!
\`\`\`

---

### 8. Download Mailboxes as CSV (by Domain)
**GET** \`/api/orders/by-domain/:domain/download\`

Downloads mailbox credentials using the tenant domain. Only works for completed orders.

**Parameters:**
- \`domain\` (path) - Tenant domain (e.g., example.com)

**Response:** CSV file download

---

## Error Codes

| HTTP Code | Error | Description |
|-----------|-------|-------------|
| 400 | Bad Request | Missing or invalid parameters |
| 401 | Unauthorized | Missing or invalid API key |
| 403 | Forbidden | Billing required or plan limit reached |
| 404 | Not Found | Order or domain not found |
| 409 | Conflict | Domain already has an active order |

---

## Example Workflow

### Complete Order Creation Flow:

\`\`\`bash
# 1. Create order and get nameservers
curl -X POST https://app.unlimitedinboxes.com/api/orders \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tenant_domain": "mycompany.com",
    "admin_email": "admin@mycompany.com",
    "admin_password": "AdminPass123!",
    "mailbox_password": "SecureMail123!",
    "total_mailboxes": 100
  }'

# Response includes: id, name_servers, next_step

# 2. Update domain nameservers at your registrar to:
# - ns1.cloudflare.com
# - ns2.cloudflare.com

# 3. Wait 5-30 minutes for DNS propagation

# 4. Start the order
curl -X POST https://app.unlimitedinboxes.com/api/orders/148/start \\
  -H "x-api-key: YOUR_API_KEY"

# 5. Poll for status
curl https://app.unlimitedinboxes.com/api/orders/by-domain/mycompany.com \\
  -H "x-api-key: YOUR_API_KEY"

# 6. When status is "completed", download CSV
curl https://app.unlimitedinboxes.com/api/orders/148/download \\
  -H "x-api-key: YOUR_API_KEY" \\
  -o mailboxes.csv
\`\`\`

---

## Data Format

### Mailbox Name Generation
Mailboxes are automatically created with randomized female first + last names (e.g., "Emma Johnson", "Sophia Williams"). The system uses a pool of 100+ common female names and 70+ last names to generate unique combinations.

### Password Requirements
- Minimum 8 characters, maximum 256 characters
- Must contain at least 3 of:
  - Uppercase letter (A-Z)
  - Lowercase letter (a-z)
  - Number (0-9)
  - Symbol (!@#$%^&* etc.)

### Email Format
\`\`\`
{firstname}{lastname}@{tenant_domain}
\`\`\`

Example: \`emmajohnson@mycompany.com\`

---

## Tenant Management

### What is a Tenant?
A "tenant" represents your Microsoft 365 organization. When you create an order, the system creates a tenant record that stores:
- Domain name
- Admin credentials (for mailbox creation)
- Cloudflare DNS configuration

### Tenants Section in App
In the web UI at /tenants, users can:
- View all their Microsoft 365 tenants
- See tenant status (pending consent, ready, etc.)
- Configure nameservers
- Set up email authentication (SPF, DKIM, DMARC)

---

## Billing Notes

- Active trial/subscription required to access the API
- Free tier: Can complete 1 order
- Paid plans: Unlimited orders, concurrent processing
- Downloads limited on some plans (check your subscription)

---

## Support

For issues or questions:
- Email: support@unlimitedinboxes.com
- Documentation: https://app.unlimitedinboxes.com/api-docs
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="llms.txt"');
  res.send(doc);
});

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
