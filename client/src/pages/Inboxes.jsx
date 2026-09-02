import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';

export default function Inboxes() {
  const { user, refreshUser } = useAuth();
  const { billing, openUpgrade, reviewUrl } = useBilling();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloadNotice, setDownloadNotice] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');

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

  const downloadCsv = async (path, key) => {
    setDownloading(key);
    setDownloadError('');
    try {
      const response = await api.get(path, { responseType: 'blob' });
      const disposition = response.headers?.['content-disposition'] || '';
      const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || 'Microsoft Inboxes.csv';
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      if (Number.isFinite(billing?.downloadAllowance)) {
        setDownloadNotice(true);
      }
    } catch (error) {
      let message = 'The inbox export could not be downloaded. Please try again.';
      if (error.response?.data instanceof Blob) {
        try {
          const payload = JSON.parse(await error.response.data.text());
          message = payload.error || message;
        } catch {
          // Keep the safe fallback message for non-JSON failures.
        }
      }
      setDownloadError(message);
    } finally {
      setDownloading('');
    }
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
            {completedOrders.length > 0 && (
              <button
                className="btn success"
                disabled={Boolean(downloading)}
                onClick={() => void downloadCsv('/orders/download/all', 'all')}
              >
                {downloading === 'all' ? 'Preparing Download...' : 'Download All Inboxes'}
              </button>
            )}
          </div>
        </div>

        {downloadError && <div className="alert error">{downloadError}</div>}

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
                <button
                  className="btn success"
                  disabled={Boolean(downloading)}
                  onClick={() => void downloadCsv(`/orders/${order.id}/download`, String(order.id))}
                >
                  {downloading === String(order.id) ? 'Preparing Download...' : 'Download Inboxes'}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {downloadNotice && (
        <div className="modal-overlay" onClick={() => setDownloadNotice(false)}>
          <div className="modal wide upgrade-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trial-limit-mark" aria-hidden="true">10%</div>
            <h2 className="modal-title">90% Inboxes Hidden</h2>
            <p className="modal-subtitle trial-limit-copy">
              To prevent free trial abuse, we only allow the first 10 inboxes to be downloaded.
              <br />
              <br />
              To download all 100 inboxes, either upgrade or share an honest video testimonial.
            </p>
            <div className="modal-actions centered">
              <button className="btn accent" onClick={() => void openUpgrade('starter')}>
                Upgrade
              </button>
              <a className="btn ghost" href={reviewUrl} target="_blank" rel="noopener noreferrer">
                Leave Testimonial
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
