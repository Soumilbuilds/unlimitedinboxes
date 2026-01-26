import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

export default function Logs() {
  const [orders, setOrders] = useState([]);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [logs, setLogs] = useState([]);

  const fetchOrders = async () => {
    try {
      const res = await api.get('/orders');
      setOrders(res.data);
      if (!selectedOrderId && res.data.length > 0) {
        setSelectedOrderId(res.data[0].id);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchLogs = async (orderId) => {
    if (!orderId) return;
    try {
      const res = await api.get(`/orders/${orderId}/logs`);
      setLogs(res.data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  useEffect(() => {
    fetchLogs(selectedOrderId);
    const interval = setInterval(() => fetchLogs(selectedOrderId), 2000);
    return () => clearInterval(interval);
  }, [selectedOrderId]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Logs</h1>
            <p>Live order processing logs.</p>
          </div>
        </div>

        <div className="logs-layout">
          <div className="logs-sidebar">
            {orders.map(order => (
              <button
                key={order.id}
                className={`logs-item ${selectedOrderId === order.id ? 'active' : ''}`}
                onClick={() => setSelectedOrderId(order.id)}
              >
                <div>Tenant: {order.tenant_name}</div>
                <span className={`status ${order.status}`}>{order.status}</span>
              </button>
            ))}
          </div>
          <div className="logs-panel">
            {logs.length === 0 ? (
              <div className="empty-state">No logs yet.</div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className="log-line">
                  <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span>{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
