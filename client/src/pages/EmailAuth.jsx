import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

export default function EmailAuth() {
  const [tenants, setTenants] = useState([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const res = await api.get('/tenants');
      setTenants(res.data);
      if (res.data.length && !selectedTenantId) {
        setSelectedTenantId(String(res.data[0].id));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRun = async () => {
    if (!selectedTenantId) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post(`/tenants/${selectedTenantId}/email-auth`);
      setResult(res.data);
    } catch (e) {
      setResult({ error: e.response?.data?.error || 'Failed to run setup' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>SPF / DKIM / DMARC</h1>
            <p>Configure email authentication for a tenant domain.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={fetchTenants}>Refresh</button>
          </div>
        </div>

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : tenants.length === 0 ? (
          <div className="empty-state">
            <h3>No tenants found</h3>
            <p>Create and connect a tenant first.</p>
          </div>
        ) : (
          <div className="card">
            <div className="form">
              <label>
                Tenant
                <select
                  value={selectedTenantId}
                  onChange={(e) => setSelectedTenantId(e.target.value)}
                >
                  {tenants.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {t.domain}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions">
                <button className="btn primary" onClick={handleRun} disabled={running}>
                  {running ? 'Running…' : 'Run Setup'}
                </button>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="card">
            <h3>Result</h3>
            <pre className="code-block">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}
