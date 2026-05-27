import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

function RedirectEditorModal({
  open,
  loading,
  domains,
  selectedTenantId,
  selectedDomain,
  redirectUrl,
  saving,
  step,
  error,
  onClose,
  onSelectDomain,
  onChangeUrl,
  onBack,
  onNext,
  onSave
}) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-header">
          <div>
            <h2>Domain Redirects</h2>
            <p>Choose a completed-order domain and point it wherever you need.</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {loading ? (
          <div className="center-screen" style={{ minHeight: 220 }}>
            <div className="spinner" />
          </div>
        ) : domains.length === 0 ? (
          <div className="form">
            <div className="helper-text">
              No completed-order domains are available yet. Finish an order first, then come back here to configure a redirect.
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            {step === 0 && (
              <div className="form">
                <label>
                  Domain
                  <select value={selectedTenantId || ''} onChange={(e) => onSelectDomain(e.target.value)} required>
                    {domains.map((item) => (
                      <option key={item.tenant_id} value={item.tenant_id}>
                        {item.domain}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="modal-actions">
                  <button className="btn ghost" onClick={onClose}>Close</button>
                  <button className="btn primary" onClick={onNext} disabled={!selectedDomain}>
                    Next
                  </button>
                </div>
              </div>
            )}

            {step === 1 && selectedDomain && (
              <div className="form">
                <label>
                  Redirect URL
                  <input
                    type="url"
                    value={redirectUrl}
                    onChange={(e) => onChangeUrl(e.target.value)}
                    placeholder="https://yourdestination.com"
                    required
                  />
                </label>
                <div className="modal-actions">
                  <button className="btn ghost" onClick={onBack}>Back</button>
                  <button className="btn primary" onClick={onSave} disabled={saving || !redirectUrl.trim()}>
                    {saving ? 'Saving...' : 'Save Redirect'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Redirects() {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorStep, setEditorStep] = useState(0);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState(null);
  const [redirectUrl, setRedirectUrl] = useState('');

  const selectedDomain = useMemo(
    () => domains.find(item => item.tenant_id === selectedTenantId) || null,
    [domains, selectedTenantId]
  );

  const syncSelection = (items, preferredTenantId = null) => {
    if (!items.length) {
      setSelectedTenantId(null);
      setRedirectUrl('');
      return;
    }

    const fallback = items.find(item => item.tenant_id === preferredTenantId)
      || items.find(item => item.tenant_id === selectedTenantId)
      || items[0];

    setSelectedTenantId(fallback.tenant_id);
    setRedirectUrl(fallback.redirect_url || '');
  };

  const fetchDomains = async (preferredTenantId = null) => {
    setLoading(true);
    setPageError('');
    try {
      const res = await api.get('/redirects');
      const items = Array.isArray(res.data) ? res.data : [];
      setDomains(items);
      syncSelection(items, preferredTenantId);
    } catch (e) {
      setPageError(e.response?.data?.error || 'Failed to load redirect domains');
      setDomains([]);
      setSelectedTenantId(null);
      setRedirectUrl('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEditorOpen(true);
    fetchDomains();
  }, []);

  const handleSelectDomain = (tenantId) => {
    const normalizedId = Number(tenantId);
    const next = domains.find(item => item.tenant_id === normalizedId) || null;
    setSelectedTenantId(next?.tenant_id || null);
    setRedirectUrl(next?.redirect_url || '');
    setEditorError('');
  };

  const openEditor = (item = null) => {
    if (item) {
      setSelectedTenantId(item.tenant_id);
      setRedirectUrl(item.redirect_url || '');
    } else if (domains.length > 0 && !selectedDomain) {
      setSelectedTenantId(domains[0].tenant_id);
      setRedirectUrl(domains[0].redirect_url || '');
    }
    setNotice('');
    setEditorError('');
    setEditorStep(0);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditorStep(0);
    setEditorError('');
  };

  const handleSaveRedirect = async () => {
    if (!selectedDomain) {
      setEditorError('Select a domain first.');
      return;
    }
    if (!redirectUrl.trim()) {
      setEditorError('Enter the redirect URL.');
      return;
    }

    setSaving(true);
    setEditorError('');
    setNotice('');
    try {
      const res = await api.put(`/redirects/${selectedDomain.tenant_id}`, {
        redirect_url: redirectUrl
      });
      const nextUrl = res.data?.redirect_url || redirectUrl.trim();
      setDomains(prev => prev.map(item => (
        item.tenant_id === selectedDomain.tenant_id
          ? { ...item, redirect_url: nextUrl }
          : item
      )));
      setRedirectUrl(nextUrl);
      setNotice(`${selectedDomain.domain} now redirects to ${nextUrl}`);
      closeEditor();
    } catch (e) {
      setEditorError(e.response?.data?.error || 'Failed to save redirect');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Redirects</h1>
            <p>Completed-order domains appear here and can be redirected instantly through Cloudflare.</p>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={() => fetchDomains(selectedTenantId)}>Refresh</button>
            <button className="btn primary" onClick={() => openEditor()}>
              Open Redirect Setup
            </button>
          </div>
        </div>

        {notice && (
          <div className="alert info" style={{ marginBottom: 16 }}>
            {notice}
          </div>
        )}

        {pageError && (
          <div className="alert error" style={{ marginBottom: 16 }}>
            {pageError}
          </div>
        )}

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : domains.length === 0 ? (
          <div className="empty-state">
            <h3>No redirectable domains yet</h3>
            <p>Complete at least one order and the connected domain will appear here.</p>
          </div>
        ) : (
          <div className="inboxes-list">
            {domains.map((item) => (
              <div key={item.tenant_id} className="inbox-row">
                <div className="inbox-meta redirect-meta">
                  <strong>{item.domain}</strong>
                  <span className="order-sub">
                    {item.completed_orders} completed order{item.completed_orders === 1 ? '' : 's'}
                  </span>
                  <span className={`redirect-target ${item.redirect_url ? '' : 'empty'}`}>
                    {item.redirect_url || 'No redirect configured yet'}
                  </span>
                </div>
                <button className="btn primary" onClick={() => openEditor(item)}>
                  {item.redirect_url ? 'Edit Redirect' : 'Set Redirect'}
                </button>
              </div>
            ))}
          </div>
        )}

        <RedirectEditorModal
          open={editorOpen}
          loading={loading}
          domains={domains}
          selectedTenantId={selectedTenantId}
          selectedDomain={selectedDomain}
          redirectUrl={redirectUrl}
          saving={saving}
          step={editorStep}
          error={editorError}
          onClose={closeEditor}
          onSelectDomain={handleSelectDomain}
          onChangeUrl={setRedirectUrl}
          onBack={() => setEditorStep(0)}
          onNext={() => {
            if (!selectedDomain) {
              setEditorError('Select a domain first.');
              return;
            }
            setEditorError('');
            setEditorStep(1);
          }}
          onSave={handleSaveRedirect}
        />
      </main>
    </div>
  );
}
