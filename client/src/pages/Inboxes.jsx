import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
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

export default function Inboxes() {
  const { user, refreshUser } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

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

  if (user?.plan === 'free') {
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
    </div>
  );
}
