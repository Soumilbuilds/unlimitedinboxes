import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

export default function Orders() {
  const [searchParams] = useSearchParams();
  const preselectedTenant = searchParams.get('tenant');

  const [orders, setOrders] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(preselectedTenant || '');
  const [mailboxPassword, setMailboxPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  const readyTenants = useMemo(() => tenants.filter(t => t.status === 'ready'), [tenants]);
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

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [ordersRes, tenantsRes] = await Promise.all([
        api.get('/orders'),
        api.get('/tenants')
      ]);
      setOrders(ordersRes.data);
      setTenants(tenantsRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, []);

  const createOrder = async (e) => {
    e.preventDefault();
    if (!selectedTenant) return;
    if (!passwordRules.valid) {
      setPasswordTouched(true);
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/orders', {
        tenant_id: selectedTenant,
        mailbox_password: mailboxPassword
      });
      await api.post(`/orders/${res.data.id}/start`);
      setModalOpen(false);
      setSelectedTenant('');
      setMailboxPassword('');
      setPasswordTouched(false);
      fetchAll();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to create order');
    } finally {
      setCreating(false);
    }
  };

  const startOrder = async (id) => {
    try {
      await api.post(`/orders/${id}/start`);
      fetchAll();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to start');
    }
  };

  const cancelOrder = async (id) => {
    if (!confirm('Stop processing this order?')) return;
    try {
      await api.post(`/orders/${id}/cancel`);
      fetchAll();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to stop');
    }
  };

  const deleteOrder = async (id) => {
    if (!confirm('Delete this order?')) return;
    try {
      await api.delete(`/orders/${id}`);
      fetchAll();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Orders</h1>
            <p>Create mailbox orders and monitor processing.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchAll}>Refresh</button>
            <button className="btn primary" onClick={() => setModalOpen(true)}>Create Order</button>
          </div>
        </div>

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <h3>No orders yet</h3>
            <p>Create your first order.</p>
          </div>
        ) : (
          <div className="grid">
            {orders.map(order => (
              <div className="card" key={order.id}>
                <div className="card-header">
                  <div>
                    <h3>Tenant: {order.tenant_name}</h3>
                    <span className={`status ${order.status}`}>{order.status}</span>
                  </div>
                </div>

                <div className="progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${order.progress}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>{order.progress}%</span>
                    <span>{order.created_mailboxes?.length || 0}/{order.total_mailboxes || 100}</span>
                  </div>
                </div>

                {order.error_message && (
                  <div className="alert error">{order.error_message}</div>
                )}

                <div className="card-actions">
                  {order.status === 'pending' && (
                    <>
                      <button className="btn primary" onClick={() => startOrder(order.id)}>Start Processing</button>
                      <button className="btn ghost" onClick={() => deleteOrder(order.id)}>Delete</button>
                    </>
                  )}

                  {order.status === 'processing' && (
                    <>
                      <button className="btn danger" onClick={() => cancelOrder(order.id)}>Stop</button>
                    </>
                  )}

                  {(order.status === 'failed' || order.status === 'cancelled') && (
                    <>
                      <button className="btn primary" onClick={() => startOrder(order.id)}>Try Again</button>
                      <button className="btn ghost" onClick={() => deleteOrder(order.id)}>Delete</button>
                    </>
                  )}

                  {order.status === 'completed' && (
                    <>
                      <button className="btn ghost" onClick={() => deleteOrder(order.id)}>Delete</button>
                    </>
                  )}
                </div>

                {order.created_mailboxes?.length > 0 && (
                  <details className="mailbox-details">
                    <summary>View created mailboxes ({order.created_mailboxes.length})</summary>
                    <div className="mailbox-list">
                      {order.created_mailboxes.map((m, idx) => (
                        <div key={`${m.email}-${idx}`} className="mailbox-item">
                          <span>{m.name}</span>
                          <span>{m.email}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

        {modalOpen && (
          <div className="modal-overlay" onClick={() => setModalOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Create Order</h2>
              <form className="form" onSubmit={createOrder}>
                <label>
                  Select Tenant
                  <select value={selectedTenant} onChange={(e) => setSelectedTenant(e.target.value)} required>
                    <option value="">Choose tenant</option>
                    {readyTenants.map(t => (
                      <option key={t.id} value={t.id}>{t.name} ({t.domain})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Mailbox Password (applies to all)
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
                  <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>Cancel</button>
                  <button type="submit" className="btn primary" disabled={creating || !passwordRules.valid}>
                    {creating ? 'Creating...' : 'Create Order'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
