import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
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

function getDownloadRows(rows, billing) {
  const list = Array.isArray(rows) ? rows : [];
  if (!Number.isFinite(billing?.downloadAllowance)) {
    return list;
  }
  const allowance = Math.max(Number(billing?.downloadAllowance || 0), 0);
  return list.slice(0, allowance);
}

export default function Inboxes() {
  const { user, refreshUser } = useAuth();
  const { billing, openUpgrade, reviewUrl } = useBilling();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloadNotice, setDownloadNotice] = useState(false);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      await refreshUser();
      const res = await api.get('/orders');
      setOrders(res.data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const completedOrders = useMemo(
    () => orders.filter(order => order.status === 'completed'),
    [orders]
  );

  const downloadCsv = (order) => {
    const rows = order?.created_mailboxes || [];
    const downloadRows = getDownloadRows(rows, billing);
    if (
      Number.isFinite(billing?.downloadAllowance)
      && billing?.downloadAllowance > 0
      && rows.length > billing.downloadAllowance
    ) {
      setDownloadNotice(true);
    }
    const csv = buildCsv(downloadRows);
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

  if (!(billing?.canOpenInboxesPage ?? user?.plan === 'paid')) {
    return <Navigate to="/orders" replace />;
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Inboxes</h1>
            <p>Download completed orders anytime.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchOrders}>Refresh</button>
          </div>
        </div>

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : completedOrders.length === 0 ? (
          <div className="empty-state">
            <h3>No inboxes yet</h3>
            <p>Complete an order to download inboxes here.</p>
          </div>
        ) : (
          <div className="inboxes-list">
            {completedOrders.map(order => (
              <div key={order.id} className="inbox-row">
                <div className="inbox-meta">
                  <strong>{order.order_name || `Order #${order.id}`}</strong>
                  <span className="order-sub">{order.tenant_domain || order.tenant_name}</span>
                </div>
                <button className="btn success" onClick={() => downloadCsv(order)}>
                  Download Inboxes
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {downloadNotice && (
        <div className="modal-overlay" onClick={() => setDownloadNotice(false)}>
          <div className="modal wide upgrade-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">10 Inboxes Downloaded</h2>
            <p className="modal-subtitle">
              To Download All, Upgrade Or Leave A Review
            </p>
            <div className="modal-actions centered">
              <button className="btn accent" onClick={() => void openUpgrade('standard')}>
                Upgrade
              </button>
              <a className="btn ghost" href={reviewUrl} target="_blank" rel="noreferrer">
                Leave A Video Review
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
