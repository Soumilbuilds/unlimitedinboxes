import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

function NameServersModal({ tenant, onClose, onConfirm }) {
  if (!tenant) return null;
  const ns = Array.isArray(tenant.cloudflare_ns) ? tenant.cloudflare_ns : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Update Name Servers</h2>
        <p className="modal-subtitle">Set these on your registrar, then confirm.</p>
        <div className="ns-list">
          {ns.map((server) => (
            <div key={server} className="ns-item">{server}</div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={onConfirm}>Nameservers Updated</button>
        </div>
      </div>
    </div>
  );
}

export default function Tenants() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [nsModalTenant, setNsModalTenant] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    admin_email: '',
    admin_password: ''
  });

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const res = await api.get('/tenants');
      setTenants(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleCreateTenant = async (e) => {
    e.preventDefault();
    try {
      await api.post('/tenants', formData);
      setFormData({ name: '', domain: '', admin_email: '', admin_password: '' });
      setModalOpen(false);
      fetchTenants();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to create tenant');
    }
  };

  const handleConnect = async (tenantId) => {
    try {
      const res = await api.post(`/tenants/${tenantId}/connect`);
      if (res.data.consentUrl) {
        window.open(res.data.consentUrl, 'MicrosoftConsent', 'width=600,height=700');
      }
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to start consent');
    }
  };

  const handleGetNameServers = async (tenant) => {
    try {
      const res = await api.post(`/tenants/${tenant.id}/nameservers`);
      const updated = { ...tenant, cloudflare_ns: res.data.name_servers };
      setNsModalTenant(updated);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to get name servers');
    }
  };

  const handleNameServersUpdated = async () => {
    try {
      await api.patch(`/tenants/${nsModalTenant.id}/status`, { status: 'ready' });
      setNsModalTenant(null);
      fetchTenants();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update status');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this tenant?')) return;
    try {
      await api.delete(`/tenants/${id}`);
      fetchTenants();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete tenant');
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Tenants</h1>
            <p>Connect Microsoft tenants and custom domains.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchTenants}>Refresh</button>
            <button className="btn primary" onClick={() => setModalOpen(true)}>Add Tenant</button>
          </div>
        </div>

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : tenants.length === 0 ? (
          <div className="empty-state">
            <h3>No tenants yet</h3>
            <p>Create your first tenant to begin.</p>
          </div>
        ) : (
          <div className="grid">
            {tenants.map((tenant) => (
              <div className="card" key={tenant.id}>
                <div className="card-header">
                  <div>
                    <h3>{tenant.name}</h3>
                    <span className={`status ${tenant.status}`}>{tenant.status}</span>
                  </div>
                  <button className="icon-btn" onClick={() => handleDelete(tenant.id)} title="Delete">
                    ✕
                  </button>
                </div>
                <div className="card-meta">
                  <div>
                    <span>Domain</span>
                    <strong>{tenant.domain}</strong>
                  </div>
                  <div>
                    <span>Admin Email</span>
                    <strong>{tenant.admin_email}</strong>
                  </div>
                </div>

                <div className="card-actions">
                  {tenant.status === 'pending_consent' && (
                    <button className="btn primary" onClick={() => handleConnect(tenant.id)}>Connect</button>
                  )}
                  {tenant.status === 'pending_ns' && (
                    <button className="btn primary" onClick={() => handleGetNameServers(tenant)}>Get Name Servers</button>
                  )}
                  {tenant.status === 'ready' && (
                    <button className="btn success" onClick={() => navigate(`/orders?tenant=${tenant.id}`)}>Create Order</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {modalOpen && (
          <div className="modal-overlay" onClick={() => setModalOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Add Tenant</h2>
              <form className="form" onSubmit={handleCreateTenant}>
                <label>
                  Friendly Name
                  <input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
                </label>
                <label>
                  Custom Domain
                  <input value={formData.domain} onChange={(e) => setFormData({ ...formData, domain: e.target.value })} required />
                </label>
                <label>
                  Admin Email
                  <input type="email" value={formData.admin_email} onChange={(e) => setFormData({ ...formData, admin_email: e.target.value })} required />
                </label>
                <label>
                  Admin Password
                  <input type="password" value={formData.admin_password} onChange={(e) => setFormData({ ...formData, admin_password: e.target.value })} required />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>Cancel</button>
                  <button type="submit" className="btn primary">Create Tenant</button>
                </div>
              </form>
            </div>
          </div>
        )}

        <NameServersModal
          tenant={nsModalTenant}
          onClose={() => setNsModalTenant(null)}
          onConfirm={handleNameServersUpdated}
        />
      </main>
    </div>
  );
}
