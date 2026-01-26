import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

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

export default function Mailboxes() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const res = await api.get('/orders');
      setOrders(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const mailboxes = useMemo(() => {
    const all = [];
    orders.forEach(order => {
      const list = order.created_mailboxes || [];
      list.forEach(m => {
        if (m?.email) {
          all.push({
            email: m.email,
            password: m.password || '',
            tenant: order.tenant_name || order.tenant_domain || ''
          });
        }
      });
    });
    return all;
  }, [orders]);

  const downloadCsv = () => {
    const csv = buildCsv(mailboxes);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `mailboxes-${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Mailboxes</h1>
            <p>Download created mailbox credentials.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchOrders}>Refresh</button>
            <button className="btn primary" onClick={downloadCsv} disabled={mailboxes.length === 0}>
              Download CSV
            </button>
          </div>
        </div>

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : mailboxes.length === 0 ? (
          <div className="empty-state">
            <h3>No mailboxes yet</h3>
            <p>Create an order and run it to generate mailboxes.</p>
          </div>
        ) : (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Total mailboxes: {mailboxes.length}</strong>
            </div>
            <div className="mailbox-list">
              {mailboxes.map((m, idx) => (
                <div key={`${m.email}-${idx}`} className="mailbox-item">
                  <span>{m.email}</span>
                  <span>{m.password}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
