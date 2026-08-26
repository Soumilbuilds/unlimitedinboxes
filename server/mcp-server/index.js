import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import * as z from 'zod/v3';
import cors from 'cors';

const PORT = Number(process.env.PORT || 3001);
const INTERNAL = 'http://127.0.0.1:3000';

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();

async function apiCall(path, apiKey, opts = {}) {
 const res = await fetch(`${INTERNAL}${path}`, {
 method: opts.method || 'GET',
 headers: { Authorization: `Bearer ${apiKey}`, ...(opts.headers || {}) },
 body: opts.body ? JSON.stringify(opts.body) : undefined,
 });
 const text = await res.text();
 let data;
 try { data = JSON.parse(text); } catch { data = text; }
 if (!res.ok) {
 const msg = typeof data === 'string' ? data : (data?.error?.message || JSON.stringify(data));
 throw new Error(`API ${res.status}: ${msg}`);
 }
 return data;
}

const mcp = new Server({ name: 'unlimited-inboxes', version: '1.0.0' }, { capabilities: { tools: {} } });

function getKey() {
 try { return sessions.get(mcp._transport?.sessionId) ?? null; }
 catch { return null; }
}

// Zod schemas (required by SDK's setRequestHandler validation)
const ListToolsSchema = z.object({ method: z.literal('tools/list') });
const CallToolSchema = z.object({
 method: z.literal('tools/call'),
 params: z.object({
 name: z.string(),
 arguments: z.record(z.any()).optional(),
 }),
});

mcp.setRequestHandler(ListToolsSchema, async () => ({
 tools: [
 { name: 'get_account', description: 'Get your account plan, inbox limits, rate limit, and quota.', inputSchema: { type: 'object', properties: {} } },
 { name: 'list_orders', description: 'List all provisioning orders. Optionally filter by domain.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Filter by domain (optional)' } } } },
 {
 name: 'create_order',
 description: 'Create a new mailbox provisioning order.',
 inputSchema: {
 type: 'object',
 required: ['domain', 'tenant_email', 'tenant_password', 'quantity', 'mailbox_password'],
 properties: {
 domain: { type: 'string', description: 'Domain (e.g. acme.com)' },
 tenant_email: { type: 'string', description: 'Microsoft 365 admin email' },
 tenant_password: { type: 'string', description: 'Microsoft 365 admin password' },
 quantity: { type: 'integer', description: 'Number of mailboxes' },
 mailbox_password: { type: 'string', description: 'Password for created mailboxes' },
 order_name: { type: 'string', description: 'Optional display name' },
 naming_mode: { type: 'string', enum: ['random', 'custom'], description: 'Naming mode' },
 mailbox_names: { type: 'array', items: { type: 'string' }, description: 'Custom names when mode=custom' },
 redirect_url: { type: 'string', description: 'Optional redirect URL' },
 },
 },
 },
 { name: 'get_order', description: 'Get order details by ID.', inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer', description: 'Order ID' } } } },
 { name: 'prepare_nameservers', description: 'Prepare Cloudflare nameservers for a domain.', inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer', description: 'Order ID' } } } },
 { name: 'check_nameservers', description: 'Check domain nameserver delegation status.', inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer', description: 'Order ID' } } } },
 { name: 'start_order', description: 'Start provisioning mailboxes (requires nameservers accepted).', inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer', description: 'Order ID' } } } },
 { name: 'download_csv', description: 'Download completed order credentials as CSV.', inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer', description: 'Order ID' } } } },
 ],
}));

mcp.setRequestHandler(CallToolSchema, async (req) => {
 const apiKey = getKey();
 if (!apiKey) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Session expired. Reconnect with ?api_key=ui_live_...' }) }] };

 try {
 let result;
 const name = req.params.name;
 const a = req.params.arguments || {};

 switch (name) {
 case 'get_account': result = await apiCall('/v1/account', apiKey); break;
 case 'list_orders': result = await apiCall(`/v1/orders${a.domain ? `?domain=${encodeURIComponent(a.domain)}` : ''}`, apiKey); break;
 case 'create_order': {
 const idem = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
 result = await apiCall('/v1/orders', apiKey, {
 method: 'POST',
 body: { domain: a.domain, tenant_email: a.tenant_email, tenant_password: a.tenant_password, quantity: Number(a.quantity), mailbox_password: a.mailbox_password, order_name: a.order_name || '', naming: { mode: a.naming_mode || 'random', names: a.mailbox_names || [] }, redirect_url: a.redirect_url || '' },
 headers: { 'Idempotency-Key': idem, 'Content-Type': 'application/json' },
 });
 break;
 }
 case 'get_order': result = await apiCall(`/v1/orders/${a.order_id}`, apiKey); break;
 case 'prepare_nameservers': result = await apiCall(`/v1/orders/${a.order_id}/nameservers/prepare`, apiKey, { method: 'POST' }); break;
 case 'check_nameservers': result = await apiCall(`/v1/orders/${a.order_id}/nameservers`, apiKey); break;
 case 'start_order': result = await apiCall(`/v1/orders/${a.order_id}/start`, apiKey, { method: 'POST' }); break;
 case 'download_csv': result = await apiCall(`/v1/orders/${a.order_id}/download`, apiKey); break;
 default: return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] };
 }
 return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
 } catch (err) {
 return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
 }
});

app.get('/mcp', async (req, res) => {
 const apiKey = String(req.query.api_key || '').trim();
 if (!apiKey) return res.status(400).json({ error: 'Missing ?api_key=. Get one at https://app.unlimitedinboxes.com' });

 try { const check = await apiCall('/v1/account', apiKey); if (check?.error) return res.status(401).json({ error: 'Invalid API key.' }); }
 catch { return res.status(401).json({ error: 'Invalid API key.' }); }

 res.setHeader('Content-Type', 'text/event-stream');
 res.setHeader('Cache-Control', 'no-cache');
 res.setHeader('Connection', 'keep-alive');
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Headers', 'content-type');

 const transport = new SSEServerTransport({ sessionEndpoint: '/mcp' }, res);
 await mcp.connect(transport);
 sessions.set(transport.sessionId, apiKey);
 res.on('close', () => { sessions.delete(transport.sessionId); try { mcp.close(); } catch {} });
});

app.post('/mcp', async (req, res) => {
 const transport = new SSEServerTransport({ sessionEndpoint: '/mcp' }, res);
 try { await transport.handlePostMessage(req.body); }
 catch (err) { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32603, message: err.message } }); }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mcp', port: PORT }));

app.listen(PORT, '127.0.0.1', () => console.log(`[mcp] → http://127.0.0.1:${PORT}/mcp`));
