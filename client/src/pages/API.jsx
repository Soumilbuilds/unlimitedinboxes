import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

export default function API() {
  const [apiKey, setApiKey] = useState(null);
  const [apiKeyLoading, setApiKeyLoading] = useState(true);
  const [apiKeyError, setApiKeyError] = useState('');
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [copied, setCopied] = useState(null);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  const baseUrl = (() => {
    if (typeof window !== 'undefined') {
      const env = window.location.hostname;
      if (env === 'localhost' || env === '127.0.0.1') return 'http://localhost:5173';
    }
    return 'https://app.unlimitedinboxes.com';
  })();

  const fetchApiKey = async () => {
    try {
      const res = await api.get('/keys');
      setApiKey(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setApiKeyLoading(false);
    }
  };

  useEffect(() => {
    fetchApiKey();
  }, []);

  const generateApiKey = async () => {
    setApiKeyLoading(true);
    setApiKeyError('');
    try {
      const res = await api.post('/keys');
      setApiKey({ hasKey: true, rawKey: res.data.rawKey });
    } catch (e) {
      setApiKeyError(e.response?.data?.error || 'Failed to generate key');
    } finally {
      setApiKeyLoading(false);
    }
  };

  const regenerateApiKey = async () => {
    setShowRegenerateModal(false);
    setApiKeyLoading(true);
    setApiKeyError('');
    try {
      const res = await api.post('/keys');
      setApiKey({ hasKey: true, rawKey: res.data.rawKey });
    } catch (e) {
      setApiKeyError(e.response?.data?.error || 'Failed to regenerate key');
    } finally {
      setApiKeyLoading(false);
    }
  };

  const copyToClipboard = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(id);
        setTimeout(() => setCopied(null), 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
      document.body.removeChild(textArea);
    }
  };

  const endpoints = [
    {
      id: 'list-orders',
      method: 'GET',
      path: '/api/orders',
      title: 'List Orders',
      desc: 'Retrieve all orders for your account.',
      example: {
        id: 1,
        status: 'completed',
        progress: 100,
        total_mailboxes: 100,
        tenant_domain: 'example.com',
        order_name: 'May-2026-1'
      }
    },
    {
      id: 'get-stats',
      method: 'GET',
      path: '/api/orders/stats',
      title: 'Get Order Statistics',
      desc: 'Get aggregated statistics across all your orders.',
      example: {
        total: 5,
        by_status: { pending: 1, processing: 0, completed: 3, failed: 1 },
        total_mailboxes: 500,
        completed_mailboxes: 300
      }
    },
    {
      id: 'get-order',
      method: 'GET',
      path: '/api/orders/:id',
      title: 'Get Order by ID',
      desc: 'Retrieve detailed information about a specific order.',
      params: [{ name: 'id', type: 'integer', desc: 'Order ID' }],
      example: {
        id: 1,
        status: 'completed',
        progress: 100,
        total_mailboxes: 100,
        created_mailboxes_count: 100,
        tenant_domain: 'example.com'
      }
    },
    {
      id: 'get-by-domain',
      method: 'GET',
      path: '/api/orders/by-domain/:domain',
      title: 'Get Order by Domain',
      desc: 'Find an order by its tenant domain name.',
      params: [{ name: 'domain', type: 'string', desc: 'Tenant domain (e.g., example.com)' }],
      example: {
        id: 1,
        status: 'completed',
        progress: 100,
        tenant_domain: 'example.com'
      }
    },
    {
      id: 'start-order',
      method: 'POST',
      path: '/api/orders/:id/start',
      title: 'Start Order Processing',
      desc: 'Start or resume processing for an order.',
      params: [{ name: 'id', type: 'integer', desc: 'Order ID' }],
      example: { success: true, message: 'Processing started' }
    },
    {
      id: 'download-by-id',
      method: 'GET',
      path: '/api/orders/:id/download',
      title: 'Download Mailboxes by ID',
      desc: 'Download mailbox credentials as CSV file.',
      params: [{ name: 'id', type: 'integer', desc: 'Order ID' }],
      isDownload: true,
      example: 'email,password\nmailbox1@example.com,password123'
    },
    {
      id: 'download-by-domain',
      method: 'GET',
      path: '/api/orders/by-domain/:domain/download',
      title: 'Download Mailboxes by Domain',
      desc: 'Download mailbox credentials using the tenant domain.',
      params: [{ name: 'domain', type: 'string', desc: 'Tenant domain' }],
      isDownload: true,
      example: 'email,password\nmailbox1@example.com,password123'
    }
  ];

  const navItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'authentication', label: 'Authentication' },
    { id: 'endpoints', label: 'Endpoints' }
  ];

  const scrollToSection = (id) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const generateCurl = (ep) => {
    const key = apiKey?.rawKey || 'YOUR_API_KEY';
    let url = `${baseUrl}${ep.path}`;
    if (ep.path.includes(':id')) {
      url = url.replace(':id', '123');
    }
    if (ep.path.includes(':domain')) {
      url = url.replace(':domain', 'example.com');
    }
    if (ep.method === 'POST') {
      return `curl ${url} -X POST -H "x-api-key: ${key}"`;
    }
    if (ep.isDownload) {
      return `curl ${url} -H "x-api-key: ${key}" -o mailboxes.csv`;
    }
    return `curl ${url} -H "x-api-key: ${key}"`;
  };

  const methodColors = {
    GET: { bg: 'rgba(52, 211, 153, 0.15)', color: '#34d399' },
    POST: { bg: 'rgba(134, 247, 184, 0.15)', color: '#86f7b8' },
    DELETE: { bg: 'rgba(255, 107, 107, 0.15)', color: '#ff6b6b' }
  };

  return (
    <div className="app-layout api-docs-layout">
      <Sidebar />
      <main className="main-content api-docs-content">
        {/* Header */}
        <header className="api-header">
          <div className="api-header-badge">REST API</div>
          <h1>API Reference</h1>
          <p>Build powerful integrations with the Unlimited Inboxes API. Access orders, statistics, and download mailbox credentials programmatically.</p>
        </header>

        {/* Quick Nav */}
        <nav className="api-nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`api-nav-item ${activeSection === item.id ? 'active' : ''}`}
              onClick={() => scrollToSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Base URL */}
        <section id="overview" className="api-section">
          <h2>Base URL</h2>
          <div className="base-url-block">
            <code>{baseUrl}</code>
          </div>
        </section>

        {/* Authentication */}
        <section id="authentication" className="api-section">
          <h2>Authentication</h2>
          <p>All API requests require your API key to be included in the request headers. Your API key can be found in the section below.</p>

          <div className="auth-block">
            <div className="auth-header">
              <span className="auth-label">Header</span>
            </div>
            <code className="auth-code">x-api-key: YOUR_API_KEY</code>
            <button
              className="copy-btn"
              onClick={() => copyToClipboard('x-api-key: YOUR_API_KEY', 'auth')}
            >
              {copied === 'auth' ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <div className="auth-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>Keep your API key secret. If compromised, regenerate it immediately from your dashboard.</span>
          </div>
        </section>

        {/* API Key Management */}
        <section className="api-section">
          <h2>Your API Key</h2>

          {apiKeyLoading ? (
            <div className="api-loading">
              <div className="spinner-sm" />
              <span>Loading API key...</span>
            </div>
          ) : apiKey?.hasKey && apiKey?.rawKey ? (
            <div className="key-block">
              <div className="key-row">
                <div className="key-value">
                  {keyRevealed ? (
                    <code className="key-code">{apiKey.rawKey}</code>
                  ) : (
                    <code className="key-masked">{'•'.repeat(48)}</code>
                  )}
                </div>
                <div className="key-actions">
                  <button className="icon-btn" onClick={() => setKeyRevealed(!keyRevealed)} title={keyRevealed ? 'Hide' : 'Show'}>
                    {keyRevealed ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                  <button className="copy-btn" onClick={() => copyToClipboard(apiKey.rawKey, 'key')}>
                    {copied === 'key' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="key-warning">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
                Save this key securely. It will not be displayed again.
              </div>
              <button className="regenerate-btn" onClick={() => setShowRegenerateModal(true)}>
                Regenerate Key
              </button>
            </div>
          ) : (
            <div className="key-generate">
              <p>No API key generated yet. Create one to start making API requests.</p>
              <button className="btn-primary" onClick={generateApiKey}>Generate API Key</button>
            </div>
          )}

          {apiKeyError && <div className="api-error">{apiKeyError}</div>}
        </section>

        {/* Endpoints */}
        <section id="endpoints" className="api-section">
          <h2>Endpoints</h2>
          <p>All available API endpoints for order management.</p>

          <div className="endpoints-list">
            {endpoints.map((ep) => {
              const mc = methodColors[ep.method] || methodColors.GET;
              return (
                <div key={ep.id} className="endpoint-block">
                  <div className="endpoint-head">
                    <div className="endpoint-title-row">
                      <span
                        className="method-badge"
                        style={{ background: mc.bg, color: mc.color }}
                      >
                        {ep.method}
                      </span>
                      <code className="endpoint-path">{ep.path}</code>
                    </div>
                    <h3>{ep.title}</h3>
                    <p className="endpoint-desc">{ep.desc}</p>
                  </div>

                  {ep.params && (
                    <div className="endpoint-params">
                      <span className="params-label">Parameters</span>
                      <div className="params-list">
                        {ep.params.map(p => (
                          <div key={p.name} className="param-item">
                            <code className="param-name">{p.name}</code>
                            <span className="param-type">{p.type}</span>
                            <span className="param-desc">{p.desc}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="endpoint-example">
                    <div className="example-header">
                      <span className="example-label">Response</span>
                      {ep.isDownload && <span className="download-badge">CSV File</span>}
                    </div>
                    <pre className="example-code">
                      <code>{ep.isDownload ? ep.example : JSON.stringify(ep.example, null, 2)}</code>
                    </pre>
                  </div>

                  <div className="endpoint-curl">
                    <div className="curl-header">
                      <span>cURL</span>
                      <button
                        className="copy-btn-small"
                        onClick={() => copyToClipboard(generateCurl(ep), ep.id)}
                      >
                        {copied === ep.id ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <code className="curl-code">{generateCurl(ep)}</code>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Error Codes */}
        <section className="api-section">
          <h2>Error Codes</h2>
          <div className="errors-grid">
            <div className="error-item">
              <span className="error-code">401</span>
              <span className="error-desc">Missing or invalid API key</span>
            </div>
            <div className="error-item">
              <span className="error-code">404</span>
              <span className="error-desc">Order not found</span>
            </div>
            <div className="error-item">
              <span className="error-code">400</span>
              <span className="error-desc">Invalid request or order not ready</span>
            </div>
            <div className="error-item">
              <span className="error-code">403</span>
              <span className="error-desc">Download not allowed on current plan</span>
            </div>
          </div>
        </section>

        {/* Footer spacing */}
        <div style={{ height: '80px' }} />
      </main>

      {showRegenerateModal && (
        <div className="modal-overlay" onClick={() => setShowRegenerateModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Regenerate API Key?</h3>
              <button className="modal-close" onClick={() => setShowRegenerateModal(false)}>X</button>
            </div>
            <div className="modal-body regenerate-modal-body">
              <p className="modal-warning-text">Your current key will be invalidated immediately.</p>
              <p className="modal-warning-subtext">Any scripts using the old key will stop working.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowRegenerateModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={regenerateApiKey}>Regenerate Key</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
