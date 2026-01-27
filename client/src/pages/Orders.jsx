import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

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
  if (/Launching exchange browser/i.test(text)) return 'Starting mailbox provisioning...';
  if (/Logging in to Microsoft 365/i.test(text)) return 'Signing in to Microsoft 365...';
  if (/Preflight:/i.test(text)) return 'Initializing mailbox workflow...';
  if (/Creating mailbox/i.test(text)) {
    const match = text.match(/Creating mailbox\\s+(.+)$/i);
    return match ? `Creating mailbox ${match[1]}` : 'Creating mailbox...';
  }
  if (/Creating:/i.test(text)) {
    const match = text.match(/Creating:\\s*([^\\(]+)/i);
    if (match && match[1]) return `Creating mailbox: ${match[1].trim()}`;
  }
  if (/Sign-in enabled/i.test(text)) return text.replace('Preflight: ', '');
  if (/Global Admin assigned/i.test(text)) return text.replace('Preflight: ', '');
  if (/Checking Exchange mail flow SMTP AUTH setting/i.test(text)) return 'Updating mail flow settings...';
  if (/Configuring SPF/i.test(text)) return 'Configuring SPF / DKIM / DMARC...';
  if (/SPF record/i.test(text)) return text;
  if (/DMARC record/i.test(text)) return text;
  if (/DKIM/i.test(text)) return text;
  if (/Order completed successfully/i.test(text)) return 'Order completed.';

  return text;
}

export default function Orders() {
  const { user, refreshUser } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [logs, setLogs] = useState([]);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardError, setWizardError] = useState('');
  const [wizardBusy, setWizardBusy] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState(false);
  const [upgradeNotice, setUpgradeNotice] = useState(false);

  const [tenantEmail, setTenantEmail] = useState('');
  const [tenantPassword, setTenantPassword] = useState('');
  const [tenantId, setTenantId] = useState(null);
  const [domain, setDomain] = useState('');
  const [nameServers, setNameServers] = useState([]);

  const [orderName, setOrderName] = useState('');
  const [mailboxPassword, setMailboxPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);

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

  const selectedOrder = useMemo(
    () => orders.find(o => o.id === selectedOrderId) || orders[0] || null,
    [orders, selectedOrderId]
  );

  const hasActiveOrder = useMemo(
    () => orders.some(o => ['pending', 'processing'].includes(o.status)),
    [orders]
  );
  const freeCompletedOrder = useMemo(
    () => user?.plan !== 'paid' && orders.some(o => o.status === 'completed'),
    [orders, user?.plan]
  );

  const fetchOrders = async () => {
    setLoading(true);
    try {
      await refreshUser();
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
    setTenantId(null);
    setDomain('');
    setNameServers([]);
    setOrderName('');
    setMailboxPassword('');
    setPasswordTouched(false);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    resetWizard();
  };

  const handleCreateTenant = async () => {
    setWizardBusy(true);
    setWizardError('');
    try {
      const tempDomain = `pending-${Date.now()}.local`;
      const name = deriveTenantName(tenantEmail, '');
      const res = await api.post('/tenants', {
        name,
        domain: tempDomain,
        admin_email: tenantEmail,
        admin_password: tenantPassword
      });
      setTenantId(res.data.id);
      setWizardStep(1);
    } catch (e) {
      setWizardError(e.response?.data?.error || 'Failed to save tenant details');
    } finally {
      setWizardBusy(false);
    }
  };

  const handleOpenConsent = async () => {
    if (!tenantId) return;
    setWizardBusy(true);
    setWizardError('');
    try {
      const res = await api.post(`/tenants/${tenantId}/connect`);
      if (res.data.consentUrl) {
        window.open(res.data.consentUrl, 'MicrosoftConsent', 'width=600,height=720');
      }
    } catch (e) {
      setWizardError(e.response?.data?.error || 'Failed to open consent window');
    } finally {
      setWizardBusy(false);
    }
  };

  const handleCheckConsent = async () => {
    if (!tenantId) return;
    setWizardBusy(true);
    setWizardError('');
    try {
      const res = await api.get('/tenants');
      const tenant = res.data.find(t => t.id === tenantId);
      if (tenant?.tenant_id) {
        setWizardStep(2);
      } else {
        setWizardError('Consent is not completed yet. Finish the Microsoft prompt, then try again.');
      }
    } catch (e) {
      setWizardError(e.response?.data?.error || 'Could not verify consent yet');
    } finally {
      setWizardBusy(false);
    }
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

  const handleNameServersUpdated = async () => {
    if (!tenantId) return;
    setWizardBusy(true);
    setWizardError('');
    try {
      await api.patch(`/tenants/${tenantId}/status`, { status: 'ready' });
      setWizardStep(3);
    } catch (e) {
      setWizardError(e.response?.data?.error || 'Failed to confirm name servers');
    } finally {
      setWizardBusy(false);
    }
  };

  const handleStartOrder = async () => {
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
      const res = await api.post('/orders', {
        tenant_id: tenantId,
        mailbox_password: mailboxPassword,
        order_name: orderName.trim()
      });
      await api.post(`/orders/${res.data.id}/start`);
      closeWizard();
      await fetchOrders();
      setSelectedOrderId(res.data.id);
    } catch (e) {
      setWizardError(e.response?.data?.error || 'Failed to start order');
    } finally {
      setWizardBusy(false);
    }
  };

  const startOrder = async (id) => {
    try {
      await api.post(`/orders/${id}/start`);
      fetchOrders();
    } catch (e) {
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
    if (user?.plan === 'free') {
      setDownloadNotice(true);
    }
  };

  const stepTitle = ['Tenant credentials', 'Microsoft consent', 'Domain setup', 'Order details'][wizardStep] || 'Order setup';

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Orders</h1>
            <p>Create and run one order at a time.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchOrders}>Refresh</button>
            <button
              className="btn primary"
              onClick={() => {
                if (freeCompletedOrder) {
                  setUpgradeNotice(true);
                  return;
                }
                setWizardOpen(true);
              }}
              disabled={hasActiveOrder}
              title={
                hasActiveOrder
                  ? 'Only one active order at a time'
                  : 'Create a new order'
              }
            >
              New Order
            </button>
          </div>
        </div>

        {hasActiveOrder && (
          <div className="alert info" style={{ marginBottom: 16 }}>
            An order is already processing. Finish or stop it before creating another.
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

                  {selectedOrder.error_message && (
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
                  <p>Step {wizardStep + 1} of 4 · {stepTitle}</p>
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
                  <div className="modal-actions">
                    <button className="btn ghost" onClick={closeWizard}>Cancel</button>
                    <button
                      className="btn primary"
                      onClick={handleCreateTenant}
                      disabled={wizardBusy || !tenantEmail || !tenantPassword}
                    >
                      {wizardBusy ? 'Saving...' : 'Continue'}
                    </button>
                  </div>
                </div>
              )}

              {wizardStep === 1 && (
                <div className="form">
                  <div className="helper-text">
                    Open the Microsoft consent window and approve access for your tenant.
                  </div>
                  <div className="modal-actions">
                    <button className="btn ghost" onClick={() => setWizardStep(0)}>Back</button>
                    <button className="btn primary" onClick={handleOpenConsent} disabled={wizardBusy}>
                      {wizardBusy ? 'Opening...' : 'Open Consent'}
                    </button>
                    <button className="btn success" onClick={handleCheckConsent} disabled={wizardBusy}>
                      I Have Connected
                    </button>
                  </div>
                </div>
              )}

              {wizardStep === 2 && (
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
                    <div className="ns-list">
                      {nameServers.map((server) => (
                        <div key={server} className="ns-item">{server}</div>
                      ))}
                    </div>
                  )}
                  <div className="modal-actions">
                    <button className="btn ghost" onClick={() => setWizardStep(1)}>Back</button>
                    <button
                      className="btn primary"
                      onClick={handleGetNameServers}
                      disabled={wizardBusy || !domain}
                    >
                      {wizardBusy ? 'Fetching...' : 'Get Name Servers'}
                    </button>
                    {nameServers.length > 0 && (
                      <button className="btn success" onClick={handleNameServersUpdated} disabled={wizardBusy}>
                        Name Servers Updated
                      </button>
                    )}
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
                    <button className="btn primary" onClick={handleStartOrder} disabled={wizardBusy || !passwordRules.valid}>
                      {wizardBusy ? 'Starting...' : 'Start Order'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {downloadNotice && (
          <div className="modal-overlay" onClick={() => setDownloadNotice(false)}>
            <div className="modal wide upgrade-modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Account upgrade needed</h2>
              <p className="modal-subtitle">
                To prevent abuse of the platform, free users can’t download<br />
                the mailboxes they create.
              </p>
              <p className="modal-subtitle">
                Either upgrade your account or leave an honest review<br />
                to unlock free mailboxes.
              </p>
              <div className="modal-actions centered">
                <a className="btn primary" href="https://unlimitedinboxes.com/upgrade" target="_blank" rel="noreferrer">
                  Upgrade
                </a>
                <a className="btn accent" href="https://unlimitedinboxes.com/freeinboxes" target="_blank" rel="noreferrer">
                  Free Inboxes
                </a>
              </div>
            </div>
          </div>
        )}

        {upgradeNotice && (
          <div className="modal-overlay" onClick={() => setUpgradeNotice(false)}>
            <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
              <div className="wizard-header">
                <div>
                  <h2>Upgrade Required</h2>
                </div>
                <button className="icon-btn" onClick={() => setUpgradeNotice(false)} title="Close">✕</button>
              </div>
              <p className="modal-subtitle">
                To create more inboxes, upgrade your account<br />
                and unlock unlimited downloads.
              </p>
              <div className="modal-actions centered">
                <a className="btn accent" href="https://unlimitedinboxes.com/upgrade" target="_blank" rel="noreferrer">
                  Upgrade
                </a>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
