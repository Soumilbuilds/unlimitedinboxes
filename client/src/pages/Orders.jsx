import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';

function buildCsv(rows) {
 const header = ['email', 'password'];
 const lines = [header.join(',')];
 rows.forEach(r => {
 const email = r.email || '';
 const password = r.password || '';
 lines.push(`${email},${password}`);
 });
 return lines.join('\n');
}

function deriveTenantName(email, domain) {
 if (domain) return domain;
 if (!email) return 'Tenant';
 const prefix = email.split('@')[0];
 return prefix ? `Tenant ${prefix}` : 'Tenant';
}

function formatStatusLabel(status) {
 if (!status) return 'unknown';
 if (status === 'completed') return 'ready';
 return String(status).replace(/_/g, ' ');
}

function formatLogMessage(message) {
 if (!message) return '';
 const text = String(message);

 if (/Ensuring Cloudflare zone/i.test(text)) return 'Connecting domain...';
 if (/Adding domain to Microsoft/i.test(text)) return 'Connecting domain to Microsoft...';
 if (/Adding verification TXT/i.test(text)) return 'Updating DNS records...';
 if (/Waiting for DNS propagation/i.test(text)) return 'Waiting for DNS propagation...';
 if (/Verifying domain/i.test(text)) return 'Verifying domain...';
 if (/Adding Exchange DNS records/i.test(text)) return 'Applying DNS records...';
 if (/Preparing Microsoft Graph admin client/i.test(text)) return 'Preparing admin permissions...';
 if (/Microsoft app prerequisites/i.test(text)) return 'Preparing Microsoft automation...';
 if (/Microsoft Graph app permissions/i.test(text)) return 'Checking Microsoft security permissions...';
 if (/Security Defaults/i.test(text)) return text;
 if (/Using Exchange organization/i.test(text)) return 'Preparing Exchange automation...';
 if (/mailbox login verified/i.test(text)) return text.replace('Preflight: ', '');
 if (/Sign-in enabled/i.test(text)) return text.replace('Preflight: ', '');
 if (/Preflight:/i.test(text)) return 'Initializing mailbox workflow...';
 if (/Creating mailbox/i.test(text)) {
 const match = text.match(/Creating mailbox\s+(.+)$/i);
 return match ? `Creating mailbox ${match[1]}` : 'Creating mailbox...';
 }
 if (/Creating:/i.test(text)) {
 const match = text.match(/Creating:\s*([^(]+)/i);
 if (match && match[1]) return `Creating mailbox: ${match[1].trim()}`;
 }
 if (/SMTP AUTH/i.test(text)) return text;
 if (/Configuring SPF/i.test(text)) return 'Configuring SPF / DKIM / DMARC...';
 if (/SPF record/i.test(text)) return text;
 if (/DMARC record/i.test(text)) return text;
 if (/DKIM/i.test(text)) return text;
 if (/Order completed successfully/i.test(text)) return 'Order completed.';

 return text;
}

const DEFAULT_MAILBOX_TOTAL = 100;

function parseNameLines(text) {
 if (!text) return [];
 return text
 .split(/\r?\n/)
 .map(line => line.trim())
 .filter(Boolean)
 .map(line => line.replace(/\s+/g, ' '));
}

function buildBillingRequiredNotice(billing, responseData = {}) {
 const blockingReason = responseData.blockingReason || billing?.blockingReason;
 if (blockingReason === 'subscription_past_due') {
 return {
 intent: 'retry',
 title: 'Subscription Past Due',
 subtitle: 'Pay the open invoice to restore access.',
 action: 'Pay Invoice'
 };
 }

 return {
 intent: 'starter',
 title: 'No Active Subscription Found',
 subtitle: 'Create the first 100 inboxes for just one dollar.',
 action: 'Create Inboxes'
 };
}

export default function Orders() {
 const { refreshUser } = useAuth();
 const { billing, refreshBilling, openUpgrade } = useBilling();
 const [orders, setOrders] = useState([]);
 const [loading, setLoading] = useState(true);
 const [selectedOrderId, setSelectedOrderId] = useState(null);
 const [logs, setLogs] = useState([]);

 const [wizardOpen, setWizardOpen] = useState(false);
 const [wizardStep, setWizardStep] = useState(0);
 const [wizardError, setWizardError] = useState('');
 const [wizardBusy, setWizardBusy] = useState(false);
 const [upgradeNotice, setUpgradeNotice] = useState(false);
 const [processingLimitNotice, setProcessingLimitNotice] = useState(false);
 const [billingRequiredNotice, setBillingRequiredNotice] = useState(null);

 const [tenantEmail, setTenantEmail] = useState('');
 const [tenantPassword, setTenantPassword] = useState('');
 const [tenantMfaSecret, setTenantMfaSecret] = useState('');
 const [tenantId, setTenantId] = useState(null);
 const [mfaSecretTouched, setMfaSecretTouched] = useState(false);
 const [mfaSecretValid, setMfaSecretValid] = useState(true);

 const [domain, setDomain] = useState('');
 const [nameServers, setNameServers] = useState([]);
 const [redirectChoice, setRedirectChoice] = useState('skip');
 const [redirectUrl, setRedirectUrl] = useState('');

 const [orderName, setOrderName] = useState('');
 const [mailboxPassword, setMailboxPassword] = useState('');
 const [passwordTouched, setPasswordTouched] = useState(false);
 const [nameMode, setNameMode] = useState('random');
 const [customNamesInput, setCustomNamesInput] = useState('');

 const passwordRules = useMemo(() => {
 const lengthOk = mailboxPassword.length >= 8 && mailboxPassword.length <= 256;
 const hasUpper = /[A-Z]/.test(mailboxPassword);
 const hasLower = /[a-z]/.test(mailboxPassword);
 const hasNumber = /[0-9]/.test(mailboxPassword);
 const hasSymbol = /[^A-Za-z0-9]/.test(mailboxPassword);
 const categories = [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length;
 return {
 lengthOk,
 hasUpper,
 hasLower,
 hasNumber,
 hasSymbol,
 categories,
 valid: lengthOk && categories >= 3
 };
 }, [mailboxPassword]);

 const canUseCustomNames = Boolean(billing?.canUseCustomNames);
 const hasUnlimitedOrders = Boolean(billing?.hasUnlimitedOrders);
 const stepTitles = canUseCustomNames
 ? ['Tenant credentials', 'Domain setup', 'Domain redirect', 'Order details', 'Set names']
 : ['Tenant credentials', 'Domain setup', 'Domain redirect', 'Order details'];
 const totalSteps = stepTitles.length;

 const selectedOrder = useMemo(
 () => orders.find(o => o.id === selectedOrderId) || orders[0] || null,
 [orders, selectedOrderId]
 );
 const completedOrderLimitTitle = hasUnlimitedOrders
 ? 'Order Limit Reached'
 : 'Free Trial Order Already Used';

 const hasActiveOrder = useMemo(
 () => orders.some(o => o.status === 'processing'),
 [orders]
 );
 const completedOrderLimitReached = useMemo(
 () => Boolean(billing?.completedOrderQuotaReached) || (!hasUnlimitedOrders && orders.some(o => o.status === 'completed')),
 [billing?.completedOrderQuotaReached, orders, hasUnlimitedOrders]
 );

 const handleBillingRequired = (responseData = {}) => {
 setBillingRequiredNotice(buildBillingRequiredNotice(billing, responseData));
 };

 const fetchOrders = async () => {
 setLoading(true);
 try {
 await refreshUser();
 await refreshBilling();
 const res = await api.get('/orders');
 setOrders(res.data);
 if (res.data.length > 0) {
 setSelectedOrderId(prev => {
 if (prev && res.data.some(o => o.id === prev)) return prev;
 return res.data[0].id;
 });
 }
 } catch (e) {
 console.error(e);
 } finally {
 setLoading(false);
 }
 };

 const fetchLogs = async (orderId) => {
 if (!orderId) return;
 try {
 const res = await api.get(`/orders/${orderId}/logs`);
 setLogs(res.data || []);
 } catch (e) {
 console.error(e);
 }
 };

 useEffect(() => {
 fetchOrders();
 const interval = setInterval(fetchOrders, 5000);
 return () => clearInterval(interval);
 }, []);

 useEffect(() => {
 if (!selectedOrder?.id) return;
 fetchLogs(selectedOrder.id);
 const interval = setInterval(() => fetchLogs(selectedOrder.id), 2000);
 return () => clearInterval(interval);
 }, [selectedOrder?.id]);

 const resetWizard = () => {
 setWizardStep(0);
 setWizardError('');
 setWizardBusy(false);
 setTenantEmail('');
 setTenantPassword('');
 setTenantMfaSecret('');
 setMfaSecretTouched(false);
 setMfaSecretValid(true);
 setTenantId(null);
 setDomain('');
 setNameServers([]);
 setRedirectChoice('skip');
 setRedirectUrl('');
 setOrderName('');
 setMailboxPassword('');
 setPasswordTouched(false);
 setNameMode('random');
 setCustomNamesInput('');
 };

 const closeWizard = () => {
 setWizardOpen(false);
 resetWizard();
 };

 const handleCreateTenant = async () => {
 const cleanMfaSecret = tenantMfaSecret.replace(/\s+/g, '').toUpperCase();
 if (!validateMfaSecret(cleanMfaSecret)) {
 setMfaSecretTouched(true);
 setMfaSecretValid(false);
 setWizardError('Enter a valid MFA secret.');
 return;
 }

 setWizardBusy(true);
 setWizardError('');
 try {
 const tempDomain = `pending-${Date.now()}.local`;
 const name = deriveTenantName(tenantEmail, '');
 const res = await api.post('/tenants', {
 name,
 domain: tempDomain,
 admin_email: tenantEmail,
 admin_password: tenantPassword,
 mfa_secret: cleanMfaSecret
 });
 setTenantId(res.data.id);
 setWizardStep(1);
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Failed to save tenant details');
 } finally {
 setWizardBusy(false);
 }
 };

 const validateMfaSecret = (secret) => {
 if (!secret || secret.trim() === '') return false;
 const cleaned = secret.replace(/\s+/g, '').toUpperCase();
 if (!/^[A-Z2-7]+=*$/.test(cleaned)) return false;
 return cleaned.length >= 16 && cleaned.length <= 128;
 };

 const handleGetNameServers = async () => {
 if (!tenantId || !domain) return;
 setWizardBusy(true);
 setWizardError('');
 try {
 await api.patch(`/tenants/${tenantId}`, {
 domain,
 name: deriveTenantName(tenantEmail, domain)
 });
 const res = await api.post(`/tenants/${tenantId}/nameservers`);
 setNameServers(res.data.name_servers || []);
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Failed to get name servers');
 } finally {
 setWizardBusy(false);
 }
 };

 const handleCheckNameServers = async () => {
 if (!tenantId) return;
 setWizardBusy(true);
 setWizardError('');
 try {
 const res = await api.post(`/tenants/${tenantId}/nameservers/check`);
 if (res.data.active) {
 await api.patch(`/tenants/${tenantId}/status`, { status: 'ready' });
 setWizardStep(2);
 } else {
 setWizardError('Name servers are not active yet. Please update them at your domain registrar and try again.');
 }
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Failed to check name servers');
 } finally {
 setWizardBusy(false);
 }
 };

 const handleRedirectStepNext = async () => {
 if (!tenantId) return;
 setWizardError('');

 if (redirectChoice === 'skip') {
 setWizardStep(3);
 return;
 }

 if (!redirectUrl.trim()) {
 setWizardError('Enter the redirect URL.');
 return;
 }

 setWizardBusy(true);
 try {
 const res = await api.put(`/redirects/${tenantId}`, {
 redirect_url: redirectUrl
 });
 setRedirectUrl(res.data?.redirect_url || redirectUrl.trim());
 setWizardStep(3);
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Failed to save the redirect');
 } finally {
 setWizardBusy(false);
 }
 };

 const handleStartOrder = async (customNames = null) => {
 if (!tenantId) return;
 if (!passwordRules.valid) {
 setPasswordTouched(true);
 return;
 }
 if (!orderName.trim()) {
 setWizardError('Please add an order name.');
 return;
 }

 setWizardBusy(true);
 setWizardError('');
 try {
 const payload = {
 tenant_id: tenantId,
 mailbox_password: mailboxPassword,
 order_name: orderName.trim()
 };
 if (Array.isArray(customNames) && customNames.length > 0) {
 payload.mailbox_names = customNames;
 }
 const res = await api.post('/orders', payload);
 setSelectedOrderId(res.data.id);
 try {
 await api.post(`/orders/${res.data.id}/start`);
 } catch (error) {
 if (error.response?.data?.code === 'ORDER_CONCURRENCY_LIMIT') {
 setProcessingLimitNotice(true);
 } else if (error.response?.data?.code === 'BILLING_REQUIRED') {
 handleBillingRequired(error.response.data);
 } else {
 throw error;
 }
 }
 closeWizard();
 await fetchOrders();
 } catch (e) {
 if (e.response?.data?.code === 'PAYMENT_FAILED') {
 setWizardOpen(false);
 openUpgrade('retry');
 return;
 }
 if (e.response?.data?.code === 'BILLING_REQUIRED') {
 handleBillingRequired(e.response.data);
 return;
 }
 setWizardError(e.response?.data?.error || 'Failed to start order');
 } finally {
 setWizardBusy(false);
 }
 };

 const handleOrderDetailsNext = () => {
 if (!passwordRules.valid) {
 setPasswordTouched(true);
 return;
 }
 if (!orderName.trim()) {
 setWizardError('Please add an order name.');
 return;
 }
 setWizardError('');
 if (canUseCustomNames) {
 setWizardStep(4);
 } else {
 handleStartOrder();
 }
 };

 const handleStartOrderWithNames = () => {
 if (!canUseCustomNames) {
 handleStartOrder();
 return;
 }
 setWizardError('');
 if (nameMode === 'random') {
 handleStartOrder();
 return;
 }

 const parsed = parseNameLines(customNamesInput);
 if (parsed.length !== DEFAULT_MAILBOX_TOTAL) {
 setWizardError(`Please enter exactly ${DEFAULT_MAILBOX_TOTAL} names (one per line).`);
 return;
 }
 const invalid = parsed.find(name => name.split(' ').length < 2);
 if (invalid) {
 setWizardError('Each line must include a first and last name.');
 return;
 }
 handleStartOrder(parsed);
 };

 const startOrder = async (id) => {
 try {
 await api.post(`/orders/${id}/start`);
 fetchOrders();
 } catch (e) {
 if (e.response?.data?.code === 'PAYMENT_FAILED') {
 openUpgrade('retry');
 return;
 }
 if (e.response?.data?.code === 'ORDER_CONCURRENCY_LIMIT') {
 setProcessingLimitNotice(true);
 return;
 }
 if (e.response?.data?.code === 'BILLING_REQUIRED') {
 handleBillingRequired(e.response.data);
 return;
 }
 alert(e.response?.data?.error || 'Failed to start');
 }
 };

 const cancelOrder = async (id) => {
 if (!confirm('Stop processing this order?')) return;
 try {
 await api.post(`/orders/${id}/cancel`);
 setOrders(prev => prev.map(order => (
 order.id === id ? { ...order, status: 'cancelled' } : order
 )));
 fetchOrders();
 } catch (e) {
 alert(e.response?.data?.error || 'Failed to stop');
 }
 };

 const deleteOrder = async (id) => {
 if (!confirm('Delete this order? This cannot be undone.')) return;
 try {
 await api.delete(`/orders/${id}`);
 setOrders(prev => prev.filter(order => order.id !== id));
 setSelectedOrderId(prev => (prev === id ? null : prev));
 fetchOrders();
 } catch (e) {
 alert(e.response?.data?.error || 'Failed to delete');
 }
 };

 const downloadCsv = (order) => {
 const rows = order?.created_mailboxes || [];
 const csv = buildCsv(rows);
 const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
 const url = URL.createObjectURL(blob);
 const link = document.createElement('a');
 link.href = url;
 link.setAttribute('download', `mailboxes-${order?.order_name || order?.id}-${new Date().toISOString().slice(0,10)}.csv`);
 document.body.appendChild(link);
 link.click();
 document.body.removeChild(link);
 URL.revokeObjectURL(url);
 };

 const stepTitle = stepTitles[wizardStep] || 'Order setup';

 return (
 <div className="app-layout">
 <Sidebar />
 <main className="main-content">
 <div className="page-header">
 <div>
 <h1>Orders</h1>
 <p>{hasUnlimitedOrders ? 'Create and process unlimited orders at once.' : 'Create orders freely and process one at a time on your current plan.'}</p>
 </div>
 <div className="page-actions">
 <button className="btn ghost" onClick={fetchOrders}>Refresh</button>
 <button
 className="btn primary"
 onClick={() => {
 if (!billing?.canAccessApp) {
 handleBillingRequired();
 return;
 }
 if (completedOrderLimitReached) {
 setUpgradeNotice(true);
 return;
 }
 setWizardOpen(true);
 }}
 title="Create a new order"
 >
 New Order
 </button>
 </div>
 </div>

 {hasActiveOrder && (
 <div className="alert info" style={{ marginBottom: 16 }}>
 An order is already processing. You can still prepare more orders, but only one can run at a time on this plan.
 </div>
 )}

 {loading ? (
 <div className="center-screen"><div className="spinner" /></div>
 ) : orders.length === 0 ? (
 <div className="empty-state">
 <h3>No orders yet</h3>
 <p>Create your first order to get started.</p>
 </div>
 ) : (
 <div className="orders-layout">
 <section className="orders-list">
 {orders.map(order => (
 <button
 key={order.id}
 className={`order-row ${selectedOrder?.id === order.id ? 'active' : ''}`}
 onClick={() => setSelectedOrderId(order.id)}
 >
 <div className="order-row-main">
 <strong>{order.order_name || `Order #${order.id}`}</strong>
 <span className="order-sub">{order.tenant_domain || order.tenant_name}</span>
 </div>
 <span className={`status ${order.status}`}>{formatStatusLabel(order.status)}</span>
 </button>
 ))}
 </section>

 <section className="orders-panel">
 {selectedOrder ? (
 <>
 <div className="order-header">
 <div>
 <h2>{selectedOrder.order_name || `Order #${selectedOrder.id}`}</h2>
 <p>{selectedOrder.tenant_domain || selectedOrder.tenant_name}</p>
 </div>
 <span className={`status ${selectedOrder.status}`}>{formatStatusLabel(selectedOrder.status)}</span>
 </div>

 <div className="progress">
 <div className="progress-bar">
 <div className="progress-fill" style={{ width: `${selectedOrder.progress || 0}%` }} />
 </div>
 <div className="progress-meta">
 <span>{selectedOrder.progress || 0}%</span>
 <span>{selectedOrder.created_mailboxes?.length || 0}/{selectedOrder.total_mailboxes || 100}</span>
 </div>
 </div>

 {selectedOrder.error_message && selectedOrder.status !== 'processing' && (
 <div className="alert error">{selectedOrder.error_message}</div>
 )}

 <div className="order-actions">
 {selectedOrder.status === 'pending' && (
 <button className="btn primary" onClick={() => startOrder(selectedOrder.id)}>Start Order</button>
 )}
 {selectedOrder.status === 'processing' && (
 <button className="btn danger" onClick={() => cancelOrder(selectedOrder.id)}>Stop Order</button>
 )}
 {(selectedOrder.status === 'failed' || selectedOrder.status === 'cancelled') && (
 <>
 <button className="btn primary" onClick={() => startOrder(selectedOrder.id)}>Try Again</button>
 <button className="btn ghost" onClick={() => deleteOrder(selectedOrder.id)}>Delete Order</button>
 </>
 )}
 {selectedOrder.status === 'completed' && (
 <button className="btn success" onClick={() => downloadCsv(selectedOrder)}>
 Download Inboxes
 </button>
 )}
 </div>

 <div className="logs-panel">
 {logs.length === 0 ? (
 <div className="empty-state">No logs yet.</div>
 ) : (
 logs.map((log, idx) => (
 <div key={idx} className="log-line">
 <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
 <span>{formatLogMessage(log.message)}</span>
 </div>
 ))
 )}
 </div>
 </>
 ) : (
 <div className="empty-state">
 <h3>Select an order</h3>
 <p>Choose an order to view progress and logs.</p>
 </div>
 )}
 </section>
 </div>
 )}

 {wizardOpen && (
 <div className="modal-overlay" onClick={closeWizard}>
 <div className="modal wide" onClick={(e) => e.stopPropagation()}>
 <div className="wizard-header">
 <div>
 <h2>New Order</h2>
 <p>Step {wizardStep + 1} of {totalSteps} · {stepTitle}</p>
 </div>
 <button className="icon-btn" onClick={closeWizard} title="Close">✕</button>
 </div>

 {wizardError && <div className="alert error">{wizardError}</div>}

 {wizardStep === 0 && (
 <div className="form">
 <label>
 Tenant admin email
 <input
 type="email"
 value={tenantEmail}
 onChange={(e) => setTenantEmail(e.target.value)}
 placeholder="admin@tenant.onmicrosoft.com"
 required
 />
 </label>
 <label>
 Tenant admin password
 <input
 type="password"
 value={tenantPassword}
 onChange={(e) => setTenantPassword(e.target.value)}
 required
 />
 </label>
 <label>
 MFA Secret
 <input
 type="text"
 value={tenantMfaSecret}
 onChange={(e) => {
 setTenantMfaSecret(e.target.value);
 setMfaSecretTouched(true);
 setMfaSecretValid(validateMfaSecret(e.target.value));
 }}
 onBlur={() => {
 setMfaSecretTouched(true);
 setMfaSecretValid(validateMfaSecret(tenantMfaSecret));
 }}
 placeholder="MFA secret"
 required
 />
 </label>
 {mfaSecretTouched && !mfaSecretValid && (
 <span className="error">Enter a valid Base32 secret (A-Z, 2-7, 16-128 chars)</span>
 )}
 <div className="modal-actions">
 <button className="btn ghost" onClick={closeWizard}>Cancel</button>
 <button
 className="btn primary"
 onClick={handleCreateTenant}
 disabled={wizardBusy || !tenantEmail || !tenantPassword || !validateMfaSecret(tenantMfaSecret)}
 >
 {wizardBusy ? 'Saving...' : 'Continue'}
 </button>
 </div>
 </div>
 )}


 {wizardStep === 1 && (
 <div className="form">
 <label>
 Domain to connect
 <input
 value={domain}
 onChange={(e) => setDomain(e.target.value)}
 placeholder="example.com"
 required
 />
 </label>
 {nameServers.length > 0 && (
 <div className="ns-list" style={{ background: '#1a1a1a', padding: '12px', borderRadius: '6px', marginTop: '12px' }}>
 <div className="helper-text" style={{ marginBottom: '8px', color: '#4ade80' }}>
 Add these name servers at your domain registrar:
 </div>
 {nameServers.map((server) => (
 <div key={server} className="ns-item" style={{ fontFamily: 'monospace', padding: '4px 0' }}>{server}</div>
 ))}
 </div>
 )}
 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(0)}>Back</button>
 <button
 className="btn primary"
 onClick={handleGetNameServers}
 disabled={wizardBusy || !domain}
 >
 {wizardBusy ? 'Fetching...' : 'Get Name Servers'}
 </button>
 {nameServers.length > 0 && (
 <button className="btn success" onClick={handleCheckNameServers} disabled={wizardBusy}>
 Check Status
 </button>
 )}
 </div>
 </div>
 )}

 {wizardStep === 2 && (
 <div className="form">
 <div className="helper-text" style={{ marginBottom: 12 }}>
 Do you want to redirect <strong>{domain}</strong> to another URL? You can skip this now and set it later from Redirects.
 </div>

 <div className="radio-group">
 <label className={`radio-card ${redirectChoice === 'skip' ? 'active' : ''}`}>
 <input
 type="radio"
 name="redirectChoice"
 value="skip"
 checked={redirectChoice === 'skip'}
 onChange={() => setRedirectChoice('skip')}
 />
 <div>
 <strong>Skip for now</strong>
 <div className="helper-text">Continue with mailbox creation and set the redirect later if you need it.</div>
 </div>
 </label>
 <label className={`radio-card ${redirectChoice === 'redirect' ? 'active' : ''}`}>
 <input
 type="radio"
 name="redirectChoice"
 value="redirect"
 checked={redirectChoice === 'redirect'}
 onChange={() => setRedirectChoice('redirect')}
 />
 <div>
 <strong>Set up redirect</strong>
 <div className="helper-text">We'll point {domain} and www.{domain} to the destination you choose.</div>
 </div>
 </label>
 </div>

 {redirectChoice === 'redirect' && (
 <label style={{ marginTop: 12 }}>
 Redirect URL
 <input
 type="url"
 value={redirectUrl}
 onChange={(e) => setRedirectUrl(e.target.value)}
 placeholder="https://yourdestination.com"
 required
 />
 </label>
 )}

 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(1)}>Back</button>
 <button className="btn primary" onClick={handleRedirectStepNext} disabled={wizardBusy}>
 {wizardBusy ? 'Saving...' : 'Continue'}
 </button>
 </div>
 </div>
 )}

 {wizardStep === 3 && (
 <div className="form">
 <label>
 Order name
 <input
 value={orderName}
 onChange={(e) => setOrderName(e.target.value)}
 placeholder="January batch"
 required
 />
 </label>
 <label>
 Mailbox password (applies to all)
 <input
 type="password"
 value={mailboxPassword}
 onChange={(e) => setMailboxPassword(e.target.value)}
 onBlur={() => setPasswordTouched(true)}
 placeholder="Enter a strong password"
 required
 />
 <div className="helper-text">
 Must be 8-256 chars and include at least 3 of: uppercase, lowercase, number, symbol.
 </div>
 {passwordTouched && !passwordRules.valid && (
 <div className="alert error">
 Password does not meet Microsoft complexity requirements.
 </div>
 )}
 </label>
 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(2)}>Back</button>
 <button className="btn primary" onClick={handleOrderDetailsNext} disabled={wizardBusy || !passwordRules.valid}>
 {wizardBusy ? 'Starting...' : (canUseCustomNames ? 'Continue' : 'Start Order')}
 </button>
 </div>
 </div>
 )}

 {wizardStep === 4 && canUseCustomNames && (
 <div className="form">
 <div className="helper-text" style={{ marginBottom: 12 }}>
 Choose how mailbox names should be created for this order.
 </div>
 <div className="radio-group">
 <label className={`radio-card ${nameMode === 'random' ? 'active' : ''}`}>
 <input
 type="radio"
 name="nameMode"
 value="random"
 checked={nameMode === 'random'}
 onChange={() => setNameMode('random')}
 />
 <div>
 <strong>Random names</strong>
 <div className="helper-text">We'll generate names automatically (current behavior).</div>
 </div>
 </label>
 <label className={`radio-card ${nameMode === 'custom' ? 'active' : ''}`}>
 <input
 type="radio"
 name="nameMode"
 value="custom"
 checked={nameMode === 'custom'}
 onChange={() => setNameMode('custom')}
 />
 <div>
 <strong>Define names</strong>
 <div className="helper-text">
 Enter {DEFAULT_MAILBOX_TOTAL} full names, one per line (First Last).
 </div>
 </div>
 </label>
 </div>

 {nameMode === 'custom' && (
 <label style={{ marginTop: 12 }}>
 Names list
 <textarea
 rows={10}
 value={customNamesInput}
 onChange={(e) => setCustomNamesInput(e.target.value)}
 placeholder={`John Doe\nJane Smith\n...`}
 />
 <div className="helper-text">
 {parseNameLines(customNamesInput).length}/{DEFAULT_MAILBOX_TOTAL} names entered.
 </div>
 </label>
 )}

 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(3)}>Back</button>
 <button className="btn primary" onClick={handleStartOrderWithNames} disabled={wizardBusy}>
 {wizardBusy ? 'Starting...' : 'Start Order'}
 </button>
 </div>
 </div>
 )}
 </div>
 </div>
 )}

 {upgradeNotice && (
 <div className="modal-overlay" onClick={() => setUpgradeNotice(false)}>
 <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
 <div className="wizard-header">
 <div>
 <h2>{completedOrderLimitTitle}</h2>
 </div>
 <button className="icon-btn" onClick={() => setUpgradeNotice(false)} title="Close">✕</button>
 </div>
 <p className="modal-subtitle">
 Upgrade your plan to continue
 </p>
 <div className="modal-actions centered">
 <button className="btn accent" onClick={() => void openUpgrade('starter')}>
 Upgrade
 </button>
 </div>
 </div>
 </div>
 )}

 {billingRequiredNotice && (
 <div className="modal-overlay" onClick={() => setBillingRequiredNotice(null)}>
 <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
 <div className="wizard-header">
 <div>
 <h2>{billingRequiredNotice.title}</h2>
 </div>
 <button className="icon-btn" onClick={() => setBillingRequiredNotice(null)} title="Close">✕</button>
 </div>
 <p className="modal-subtitle">
 {billingRequiredNotice.subtitle}
 </p>
 <div className="modal-actions centered">
 <button
 className="btn accent"
 onClick={() => void openUpgrade(billingRequiredNotice.intent)}
 >
 {billingRequiredNotice.action}
 </button>
 </div>
 </div>
 </div>
 )}

 {processingLimitNotice && (
 <div className="modal-overlay" onClick={() => setProcessingLimitNotice(false)}>
 <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
 <div className="wizard-header">
 <div>
 <h2>Only Multi-Order Plan Not Detected</h2>
 </div>
 <button className="icon-btn" onClick={() => setProcessingLimitNotice(false)} title="Close">✕</button>
 </div>
 <p className="modal-subtitle">
 Right now you can only run one order at once. If you want to run multiple orders together, add multiple order processing for just $29.
 </p>
 <div className="modal-actions centered">
 <button className="btn accent" onClick={() => void openUpgrade('concurrent')}>
 Upgrade
 </button>
 </div>
 </div>
 </div>
 )}
 </main>
 </div>
 );
}
