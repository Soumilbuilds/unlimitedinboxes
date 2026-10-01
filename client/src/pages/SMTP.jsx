import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useBilling } from '../context/BillingContext';
import './smtp.css';

const ACTIVE = new Set(['processing', 'waiting_dns', 'waiting_verification']);
const POLLING = new Set(['draft', 'preparing', ...ACTIVE]);
const SETUP = new Set(['pending_nameservers', 'ready']);
const LABELS = { draft: 'Preparing Domain', preparing: 'Preparing Domain', pending_nameservers: 'Waiting For Nameservers', ready: 'Ready', processing: 'Processing', waiting_dns: 'Waiting For DNS', waiting_verification: 'Waiting For Authentication', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' };
const STEPS = ['Domain', 'Nameservers', 'Inbox Names', 'Review'];
const FRIENDLY = ['This API key is invalid.', 'This API key does not have Full Access. Create a Full Access key in Resend and try again.', 'Resend could not be reached. Try again.', 'Your Resend connection is no longer valid. Reconnect your account.', 'This domain is already connected to another Resend account.', 'Nameservers have not propagated yet.', 'Email authentication is still propagating.', 'One or more inboxes could not be created. Try provisioning again.'];
const ERRORS = { RESEND_INVALID_KEY: FRIENDLY[0], RESEND_PERMISSION_DENIED: FRIENDLY[1], RESEND_FULL_ACCESS_REQUIRED: FRIENDLY[1], RESEND_UNAVAILABLE: FRIENDLY[2], RESEND_RATE_LIMITED: 'Resend is busy. Wait a moment, then try again.', RESEND_NOT_CONNECTED: 'Connect Resend before continuing.', RESEND_CONNECTION_INVALID: FRIENDLY[3], DOMAIN_CONFLICT: FRIENDLY[4], INBOX_LIMIT_EXCEEDED: 'This order exceeds your available inbox allocation. Review your plan.', ORDER_CONCURRENCY_LIMIT: 'Another order is processing. Wait for it to finish or upgrade your plan.' };
Object.assign(ERRORS, {
  BILLING_REQUIRED: 'An active subscription is required. Get access to continue.',
  PAYMENT_REQUIRED: 'An active subscription is required. Get access to continue.',
  UNAUTHORIZED: 'Sign in to continue.',
  NOT_FOUND: 'Order not found.',
  RESEND_CONNECTION_REQUIRED: 'Connect Resend before creating an order.',
  RESEND_DOMAIN_CONFLICT: FRIENDLY[4],
  INBOX_LIMIT_REACHED: 'This order exceeds your inbox allowance. Upgrade your plan or request fewer inboxes.',
  DOMAIN_UNAVAILABLE: 'This domain is already in use. Choose another domain or continue its existing order.',
  INVALID_DOMAIN: 'Enter a valid domain, such as example.com.',
  INVALID_MAILBOX_NAMES: 'Enter valid inbox names, one per line. Full addresses must belong to this domain.',
  DUPLICATE_MAILBOX_NAMES: 'Each inbox name must be unique. Remove duplicate names and try again.',
  INVALID_MAILBOX_QUANTITY: 'Request between 1 and 500 inboxes per order.',
  NAMESERVERS_PENDING: 'Nameservers have not propagated yet. Update them at your registrar, then check again.',
  ORDER_STATE_CONFLICT: 'The order state changed. Refresh and try again.',
  CONNECTION_BUSY: 'An order is running. Stop the order before replacing or disconnecting Resend.',
  ORDER_NOT_DELETABLE: 'This order has prepared infrastructure and cannot be deleted.',
  DOWNLOAD_NOT_READY: 'Your inboxes are still being provisioned. Try again when the order is complete.',
  DOWNLOAD_ALLOWANCE_REACHED: 'Your trial credential allowance has been used. Upgrade to download more inboxes.',
  MAIL_INFRASTRUCTURE_UNAVAILABLE: 'Mail infrastructure could not be reached. Try provisioning again.',
  MAILBOX_PROVISIONING_FAILED: FRIENDLY[7],
  EMAIL_AUTHENTICATION_PENDING: FRIENDLY[6],
  DNS_UNAVAILABLE: 'DNS could not be checked. Try again.',
  SERVICE_UNAVAILABLE: 'Provisioning is temporarily unavailable. Try again.',
});
const LOG_MESSAGES = new Set([
  'Preparing Domain', 'Waiting For Nameservers', 'Nameservers Connected', 'Applying DNS Records',
  'Configuring Email Authentication', 'Testing SMTP', 'Testing IMAP', 'Running Final Checks',
  'Provisioning Complete', 'Waiting For Email Authentication', 'Waiting For DNS', 'Order Stopped',
  'Provisioning Paused', 'Provisioning Started', 'Provisioning Could Not Be Completed',
]);
function safeLog(message) {
  return LOG_MESSAGES.has(message) || /^Creating Inbox [1-9]\d{0,2} Of [1-9]\d{0,2}$/.test(message)
    ? message : 'Provisioning Paused';
}
function needsSetup(order) {
  return !order.nameservers_connected || !order.total_mailboxes;
}
// Render only intentional customer messages, never arbitrary upstream error bodies.
function friendly(error, fallback = 'This action could not be completed. Try again.') {
  const data = error?.response?.data;
  const message = data?.error || data?.message || data?.error_message;
  return ERRORS[data?.code] || (FRIENDLY.includes(message) ? message : fallback);
}
function parseNames(text, domain) {
  const names = [];
  text = text.replace(/\r\n/g, '\n');
  if (text.length > 128000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return { names, error: 'Enter valid inbox names, one per line.' };
  const input = text.replace(/\r\n/g, '\n').trim();
  if (!input) return { names, error: '' };
  for (const line of input.split('\n')) {
    const value = line.trim().toLowerCase();
    if (!value) return { names, error: 'Remove empty lines between inbox names.' };
    const parts = value.split('@');
    if (parts.length > 2 || (parts.length === 2 && parts[1] !== domain.toLowerCase())) return { names, error: 'Every email address must belong to this domain.' };
    const name = parts[0];
    if (name.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(name) || name.endsWith('.') || name.includes('..')) return { names, error: 'Use valid inbox names with letters, numbers, dots, hyphens, underscores, or plus signs.' };
    if (names.includes(name)) return { names, error: 'Remove duplicate inbox names.' };
    names.push(name);
  }
  return { names, error: names.length > 500 ? 'Enter no more than 500 inbox names per order.' : '' };
}

function Wizard({ initialOrder, onClose, onUpdate, onError, connected }) {
  const [order, setOrder] = useState(initialOrder);
  const [step, setStep] = useState(initialOrder ? (SETUP.has(initialOrder.status) && initialOrder.nameservers_connected ? 2 : 1) : 0);
  const [domain, setDomain] = useState(initialOrder?.domain || '');
  const [names, setNames] = useState((initialOrder?.mailbox_names || []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const modalRef = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  const latestRef = useRef({ onUpdate, onError });
  latestRef.current = { onUpdate, onError };
  const preparing = !!order && !SETUP.has(order.status);
  const preparationFailed = order?.status === 'failed' || order?.status === 'cancelled';
  const parsed = parseNames(names, order?.domain || domain);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => modalRef.current?.querySelector('input, textarea, button')?.focus(), 0);
    const keydown = event => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const items = [...modalRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]')];
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(timer); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); previousFocus?.focus(); };
  }, []);
  const update = next => { setOrder(next); onUpdate(next); };
  useEffect(() => {
    if (!order?.id || step !== 1 || !POLLING.has(order.status)) return undefined;
    let disposed = false;
    let timer;
    const poll = async () => {
      try {
        const { data } = await api.get(`/smtp/orders/${order.id}`);
        if (disposed) return;
        setOrder(data); latestRef.current.onUpdate(data); setError('');
        if (data.nameservers_connected && SETUP.has(data.status)) setStep(2);
        if (!POLLING.has(data.status)) return;
      } catch (e) {
        if (disposed) return;
        if (latestRef.current.onError(e)) return;
        setError(friendly(e, 'Domain preparation could not be checked. Retrying automatically.'));
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [order?.id, order?.status, step]);
  const perform = async task => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await task(); } catch (e) { if (!onError(e)) setError(friendly(e)); } finally { busyRef.current = false; setBusy(false); }
  };
  const next = () => perform(async () => {
    if (step === 0) {
      const clean = domain.trim().toLowerCase().replace(/\.$/, '');
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) { setError('Enter a valid domain, such as example.com.'); return; }
      update((await api.post('/smtp/orders', { domain: clean })).data); setStep(1);
    } else if (step === 1) {
      if (preparationFailed) { const { data } = await api.post(`/smtp/orders/${order.id}/start`); update(data); if (data.nameservers_connected && SETUP.has(data.status)) setStep(2); return; }
      if (preparing || !order?.name_servers?.length) return;
      if (order.nameservers_connected) { setStep(2); return; }
      const { data } = await api.post(`/smtp/orders/${order.id}/nameservers/check`);
      if (data.order) update(data.order);
      if (data.connected || data.order?.nameservers_connected) setStep(2);
      else setError('Nameservers are not active yet. DNS changes can take some time. Update them at your registrar, then check again.');
    } else if (step === 2) {
      if (parsed.error || !parsed.names.length) { setError(parsed.error || 'Enter at least one inbox name.'); return; }
      update((await api.patch(`/smtp/orders/${order.id}/mailboxes`, { names: parsed.names.join('\n') })).data); setStep(3);
    } else { update((await api.post(`/smtp/orders/${order.id}/start`)).data); onClose(); }
  });
  const copy = async value => { try { await navigator.clipboard.writeText(value); setCopied(value); } catch { setError('Copy the nameserver from the field below.'); } };
  return <div className="smtp-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="smtp-modal" role="dialog" aria-modal="true" aria-labelledby="smtp-wizard-title" ref={modalRef}>
      <header className="smtp-modal-header"><div><span className="smtp-eyebrow">New SMTP Order</span><h2 id="smtp-wizard-title">{['Connect Your Domain', 'Update Your Nameservers', 'Create Inboxes', 'Ready To Provision'][step]}</h2></div><button className="icon-btn" disabled={busy} onClick={onClose} aria-label="Close Wizard">✕</button></header>
      <ol className="smtp-steps" aria-label="Setup Progress">{STEPS.map((label, i) => <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i < step ? '✓' : i + 1}</span>{label}</li>)}</ol>
      {error && <div className="alert error" role="alert">{error}</div>}
      {preparationFailed && <div className="alert error" role="alert">{ERRORS[order.error_code] || 'Domain preparation could not be completed. Try again to resume setup.'}</div>}
      <form onSubmit={e => { e.preventDefault(); next(); }}><div className="smtp-modal-body">
        {step === 0 && <><p>Connect your domain to prepare DNS and email authentication.</p><label htmlFor="smtp-domain">Domain</label><input id="smtp-domain" value={domain} onChange={e => setDomain(e.target.value)} placeholder="example.com" autoComplete="off" spellCheck={false} required disabled={busy} /></>}
        {step === 1 && <><p>{preparationFailed ? 'Domain preparation paused. Retry preparation to continue setup.' : preparing ? 'Your domain and email authentication are being prepared. Setup will update automatically.' : 'Replace your current nameservers at your domain registrar with these nameservers.'}</p><div className="smtp-nameservers">{(order?.name_servers || []).map((ns, i) => <div className="smtp-nameserver" key={ns}><label className="smtp-sr-only" htmlFor={`smtp-ns-${i}`}>Nameserver {i + 1}</label><input id={`smtp-ns-${i}`} value={ns} readOnly onFocus={e => e.target.select()} /><button className="btn ghost" type="button" onClick={() => copy(ns)}>{copied === ns ? 'Copied' : 'Copy'}</button></div>)}</div>{!order?.name_servers?.length && <div className="smtp-preparing" role="status">{preparationFailed ? 'Preparation Paused' : <><span className="spinner" aria-hidden="true" />Preparing Nameservers…</>}</div>}{order?.nameservers_connected && <div className="smtp-confirmation">✓ Nameservers Connected</div>}<p className="smtp-help">You can close this window and continue setup later.</p></>}
        {step === 2 && <><div className="smtp-confirmation">✓ Nameservers Connected</div><p>Enter one inbox name per line. You can also paste email addresses belonging to {order?.domain}.</p><div className="smtp-label-row"><label htmlFor="smtp-names">Inbox Names</label><span>{parsed.names.length} {parsed.names.length === 1 ? 'Inbox' : 'Inboxes'}</span></div><textarea id="smtp-names" rows={7} placeholder={'stacy\namy\nsam\njake\nmia'} value={names} onChange={e => setNames(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} required aria-invalid={!!parsed.error} aria-describedby={parsed.error ? 'smtp-names-help smtp-names-error' : 'smtp-names-help'} />{parsed.error && <div id="smtp-names-error" className="smtp-input-error">{parsed.error}</div>}<p className="smtp-help" id="smtp-names-help">Each inbox receives a unique secure password. Your plan’s existing inbox allowance applies.</p></>}
        {step === 3 && <><p>Your inboxes will be provisioned with standard SMTP + IMAP credentials.</p><dl className="smtp-review"><div><dt>Domain</dt><dd>{order?.domain}</dd></div><div><dt>Inboxes</dt><dd>{order?.total_mailboxes}</dd></div><div><dt>Resend</dt><dd className="smtp-positive">{connected ? 'Connected' : 'Reconnect Required'}</dd></div><div><dt>DNS</dt><dd className="smtp-positive">Nameservers Connected</dd></div></dl><p className="smtp-help">Download your credentials securely when provisioning is complete.</p></>}
      </div><footer className="smtp-modal-actions"><button type="button" className="btn ghost" disabled={busy} onClick={() => step > 1 ? setStep(step - 1) : onClose()}>{step > 1 ? 'Back' : 'Close'}</button><button type="submit" className="btn primary" disabled={busy || !connected || (step === 1 && !preparationFailed && (preparing || !order?.name_servers?.length)) || (step === 2 && (!parsed.names.length || !!parsed.error))}>{busy ? 'Please Wait…' : step === 1 && preparationFailed ? 'Retry Preparation' : step === 1 && preparing ? 'Preparing Nameservers…' : ['Continue', order?.nameservers_connected ? 'Continue' : 'Check Nameservers', 'Continue', 'Start Provisioning'][step]}</button></footer></form>
    </section>
  </div>;
}

export default function SMTP() {
  const { billing, openUpgrade, refreshBilling } = useBilling();
  const [connection, setConnection] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [wizard, setWizard] = useState(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const keyRef = useRef(null);
  const loadRef = useRef(false);
  const revisionRef = useRef(0);
  const actionRef = useRef(false);
  const selected = orders.find(order => order.id === selectedId) || orders[0];
  const hasActive = orders.some(order => POLLING.has(order.status));
  const handleError = e => {
    const data = e?.response?.data;
    if (data?.code === 'BILLING_REQUIRED' || data?.code === 'PAYMENT_REQUIRED') { openUpgrade(data.recommendedCheckoutIntent || (billing?.isPastDue ? 'retry' : 'starter')); return true; }
    return false;
  };
  const handleErrorRef = useRef(handleError);
  handleErrorRef.current = handleError;
  const load = useCallback(async () => {
    if (loadRef.current) return;
    loadRef.current = true;
    const revision = revisionRef.current;
    const [c, o] = await Promise.allSettled([api.get('/smtp/connection'), api.get('/smtp/orders')]);
    loadRef.current = false;
    if (revision !== revisionRef.current) return;
    if (c.status === 'fulfilled') { setConnection(c.value.data); setConnectionError(''); }
    else if (!handleErrorRef.current(c.reason)) setConnectionError(friendly(c.reason, 'Your Resend connection could not be loaded. Try refreshing.'));
    if (o.status === 'fulfilled') setOrders(o.value.data);
    else if (c.status === 'rejected' && ['BILLING_REQUIRED', 'PAYMENT_REQUIRED'].includes(c.reason?.response?.data?.code)) { /* The connection request already opened billing. */ }
    else if (!handleErrorRef.current(o.reason)) setError(friendly(o.reason, 'Your SMTP orders could not be loaded. Try refreshing.'));
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => clearInterval(timer);
  }, [hasActive, load]);
  useEffect(() => {
    if (!selected?.id) { setLogs([]); return undefined; }
    let disposed = false; let fetching = false; setLogs([]);
    const fetchLogs = async () => { if (fetching) return; fetching = true; try { const { data } = await api.get(`/smtp/orders/${selected.id}/logs`); if (!disposed) setLogs(data); } catch { /* Retry with order refresh. */ } finally { fetching = false; } };
    void fetchLogs();
    const timer = POLLING.has(selected.status) ? setInterval(() => { if (!document.hidden) void fetchLogs(); }, 10000) : null;
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selected?.status, refreshVersion]);
  const updateOrder = order => { revisionRef.current += 1; setOrders(current => [order, ...current.filter(item => item.id !== order.id)]); setSelectedId(order.id); };
  const action = async task => {
    if (actionRef.current) return; actionRef.current = true; revisionRef.current += 1; setBusy(true); setError('');
    try { await task(); } catch (e) { if (!handleError(e)) setError(friendly(e)); } finally { revisionRef.current += 1; actionRef.current = false; setBusy(false); }
  };
  const connectionAction = async task => {
    if (actionRef.current) return; actionRef.current = true; revisionRef.current += 1; setBusy(true); setConnectionError('');
    try { await task(); } catch (e) { if (!handleError(e)) setConnectionError(friendly(e, 'Resend could not be connected. Check that your key has Full Access and try again.')); } finally { revisionRef.current += 1; actionRef.current = false; setKey(''); setBusy(false); }
  };
  const newOrder = () => {
    if (billing && !billing.canAccessApp) { openUpgrade(billing.recommendedCheckoutIntent || (billing.isPastDue ? 'retry' : 'starter')); return; }
    if (!connection?.connected) { keyRef.current?.focus(); return; }
    setWizard({ order: null });
  };
  const download = () => action(async () => {
    const response = await api.get(`/smtp/orders/${selected.id}/download`, { responseType: 'blob' }).catch(async e => {
      if (e.response?.data instanceof Blob) { try { e.response.data = JSON.parse(await e.response.data.text()); } catch { /* Safe fallback. */ } }
      throw e;
    });
    const url = URL.createObjectURL(response.data); const link = document.createElement('a');
    link.href = url; link.download = `inboxes-${selected.domain}.csv`; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); void refreshBilling();
  });
  const progress = Math.min(100, Math.max(0, Number(selected?.progress) || 0));
  return <div className="app-layout smtp-layout"><Sidebar /><main className="main-content smtp-page">
    <div className="page-header"><div><h1>SMTP</h1><p>Provision SMTP + IMAP inboxes on your domains.</p></div><div className="page-actions"><button className="btn ghost" disabled={busy || loading} onClick={() => action(async () => { setConnectionError(''); await load(); setRefreshVersion(n => n + 1); })}>Refresh</button><button className="btn primary" disabled={busy || loading || (!connection?.connected && billing?.canAccessApp !== false)} onClick={newOrder}>New SMTP Order</button></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    <section className="smtp-connection" aria-labelledby="smtp-connection-title"><div className="smtp-connection-heading"><div><h2 id="smtp-connection-title">{connection?.connected ? 'Resend — Connected' : 'Connect Resend'}</h2><p>{connection?.connected ? 'Your account is connected for domain setup and provisioning.' : 'Connect your Resend account to automate domain setup and provisioning.'}</p></div><span className={`status ${connection?.connected ? 'completed' : 'draft'}`}>{connection?.connected ? 'Connected ✓' : loading ? 'Loading' : 'Disconnected'}</span></div>
      {connectionError && <div className="alert error" role="alert">{connectionError}</div>}
      {connection?.connected && <><div className="smtp-connection-meta"><span>Domains Connected: <strong>{Number.isFinite(Number(connection.connected_domain_count)) && connection.connected_domain_count != null ? Number(connection.connected_domain_count) : 'Unavailable'}</strong></span><span>Plan Limit: <a href="https://resend.com/settings/billing" target="_blank" rel="noreferrer">Check Resend Plan ↗</a></span></div><div className="smtp-connection-actions"><button className="btn ghost" disabled={busy} onClick={() => connectionAction(async () => setConnection((await api.post('/smtp/connection/refresh')).data))}>Refresh</button><button className="btn ghost" disabled={busy} onClick={() => { setReplacing(true); setTimeout(() => keyRef.current?.focus(), 0); }}>Replace Key</button><button className="btn ghost" disabled={busy} onClick={() => { if (window.confirm('Disconnect Resend? Your Resend account and existing inboxes will be preserved. Active orders will need a connection to continue.')) void connectionAction(async () => { await api.delete('/smtp/connection'); setConnection({ connected: false }); setReplacing(false); }); }}>Disconnect</button></div></>}
      {(!connection?.connected || replacing) && !loading && <form className="smtp-key-form" onSubmit={e => { e.preventDefault(); void connectionAction(async () => { const { data } = await api.post('/smtp/connection', { api_key: key.trim() }); setConnection(data); setReplacing(false); }); }}><label htmlFor="smtp-resend-key">Resend API Key</label><div className="smtp-key-input"><input ref={keyRef} id="smtp-resend-key" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} required disabled={busy} aria-describedby="smtp-key-help" /><button className="btn primary" disabled={busy || !key.trim()}>{busy ? 'Testing…' : 'Test & Save'}</button>{replacing && <button type="button" className="btn ghost" disabled={busy} onClick={() => { setReplacing(false); setKey(''); }}>Cancel</button>}</div><p id="smtp-key-help" className="smtp-help">A Full Access API key is required for domain management.</p></form>}
    </section>
    {loading ? <div className="center-screen" aria-label="Loading SMTP Orders"><div className="spinner" /></div> : !orders.length ? <section className="empty-state smtp-empty"><div className="smtp-empty-mark" aria-hidden="true">@</div><h2>No SMTP Orders Yet</h2><p>Connect Resend and provision your first SMTP inboxes.</p><button className="btn primary" disabled={busy || (!connection?.connected && billing?.canAccessApp !== false)} onClick={newOrder}>New SMTP Order</button></section> : <div className="orders-layout smtp-orders"><section className="orders-list" aria-label="SMTP Orders">{orders.map(order => <button key={order.id} className={`order-row ${selected?.id === order.id ? 'active' : ''}`} aria-pressed={selected?.id === order.id} onClick={() => setSelectedId(order.id)}><div className="order-row-main"><strong>{order.domain}</strong><span className="order-sub">{order.total_mailboxes || 0} Inboxes</span><span className={`status ${order.status}`}>{LABELS[order.status] || 'Preparing'}</span></div></button>)}</section>
      {selected && <section className="orders-panel"><div className="order-header"><div><h2>{selected.domain}</h2><p>{selected.domain}</p></div><span className={`status ${selected.status}`}>{LABELS[selected.status] || 'Preparing'}</span></div><div className="progress"><div className="progress-bar" role="progressbar" aria-label="Provisioning Progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{progress}%</span><span>{selected.created_mailboxes_count || 0} / {selected.total_mailboxes || 0} Inboxes</span></div></div>
        {selected.status === 'failed' && <div className="alert error" role="alert">{FRIENDLY.includes(selected.error_message) ? selected.error_message : ERRORS[selected.error_code] || 'Provisioning could not be completed. Try again to resume your order.'}</div>}
        {['waiting_dns', 'waiting_verification'].includes(selected.status) && <p className="smtp-help">Email authentication is still propagating. Your order will continue automatically.</p>}
        <div className="order-actions">{['draft', 'preparing', 'pending_nameservers', 'ready'].includes(selected.status) && <button className="btn primary" disabled={busy || !connection?.connected} onClick={() => setWizard({ order: selected })}>Continue Setup</button>}{ACTIVE.has(selected.status) && <button className="btn danger" disabled={busy} onClick={() => { if (window.confirm('Stop this order? Existing inboxes will be preserved.')) void action(async () => updateOrder((await api.post(`/smtp/orders/${selected.id}/cancel`)).data)); }}>Stop Order</button>}{['failed', 'cancelled'].includes(selected.status) && <button className="btn primary" disabled={busy || !connection?.connected} onClick={() => { if (needsSetup(selected)) void action(async () => { const { data } = await api.post(`/smtp/orders/${selected.id}/start`); updateOrder(data); setWizard({ order: data }); }); else void action(async () => updateOrder((await api.post(`/smtp/orders/${selected.id}/start`)).data)); }}>Try Again</button>}{selected.status === 'completed' && <button className="btn success" disabled={busy} onClick={download}>{busy ? 'Preparing Download…' : 'Download Inboxes'}</button>}{['draft', 'pending_nameservers', 'ready', 'failed', 'cancelled'].includes(selected.status) && !selected.created_mailboxes_count && <button className="btn ghost" disabled={busy} onClick={() => { if (window.confirm('Delete this order record? Domain setup will be preserved.')) void action(async () => { await api.delete(`/smtp/orders/${selected.id}`); setOrders(current => current.filter(item => item.id !== selected.id)); }); }}>Delete Order</button>}</div>
        <div className="smtp-log-heading">Provisioning Activity</div><div className="logs-panel" aria-live="polite" aria-relevant="additions">{!logs.length ? <div className="smtp-log-empty">Activity will appear here as your order progresses.</div> : logs.map((log, i) => <div className="log-line" key={log.id || i}><time dateTime={log.timestamp || log.time}>{(log.timestamp || log.time) ? new Date(log.timestamp || log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</time><span>{safeLog(log.message)}</span></div>)}</div>
      </section>}
    </div>}
    {wizard && <Wizard initialOrder={wizard.order} connected={!!connection?.connected} onClose={() => setWizard(null)} onUpdate={updateOrder} onError={handleError} />}
  </main></div>;
}
