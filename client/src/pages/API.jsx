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
  const [testModal, setTestModal] = useState(null);
  const [paramValue, setParamValue] = useState('');

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

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const endpoints = [
    {
      id: 'list-orders',
      method: 'GET',
      path: '/api/orders',
      desc: 'List all your orders',
      params: null,
      response: {
        description: 'Array of order objects',
        example: {
          orders: [
            {
              id: 1,
              status: 'pending',
              progress: 0,
              total_mailboxes: 100,
              created_mailboxes_count: 0,
              createdAt: '2026-05-29T10:30:00.000Z'
            }
          ],
          total: 1
        }
      }
    },
    {
      id: 'get-order',
      method: 'GET',
      path: '/api/orders/:id',
      desc: 'Get a specific order by ID',
      params: { id: 'Order ID' },
      response: {
        description: 'Full order object',
        example: {
          id: 1,
          status: 'pending',
          progress: 0,
          total_mailboxes: 100,
          created_mailboxes_count: 0,
          createdAt: '2026-05-29T10:30:00.000Z',
          updatedAt: '2026-05-29T10:30:00.000Z'
        }
      }
    },
    {
      id: 'start-order',
      method: 'POST',
      path: '/api/orders/:id/start',
      desc: 'Start processing an order',
      params: { id: 'Order ID' },
      response: {
        description: 'Success confirmation',
        example: {
          success: true,
          message: 'Processing started',
          orderId: 1
        }
      }
    },
    {
      id: 'download-csv',
      method: 'GET',
      path: '/api/orders/:id/download',
      desc: 'Download mailbox credentials as CSV',
      params: { id: 'Order ID' },
      response: {
        description: 'CSV file download',
        example: 'email,password\nmailbox1@example.com,securePassword123'
      }
    }
  ];

  const generateCurl = (ep, paramId = null) => {
    const key = apiKey?.rawKey || 'YOUR_API_KEY';
    let url = `${baseUrl}${ep.path}`;
    if (paramId) {
      url = url.replace(':id', paramId);
    }
    if (ep.method === 'POST') {
      return `curl ${url} -X POST -H "x-api-key: ${key}"`;
    }
    if (ep.path.includes('/download')) {
      return `curl ${url} -H "x-api-key: ${key}" -o mailboxes.csv`;
    }
    return `curl ${url} -H "x-api-key: ${key}"`;
  };

  const handleTestClick = (ep) => {
    if (ep.params) {
      setTestModal(ep);
      setParamValue('');
    } else {
      copyToClipboard(generateCurl(ep), ep.id);
    }
  };

  const handleModalSubmit = (ep) => {
    if (paramValue.trim()) {
      copyToClipboard(generateCurl(ep, paramValue.trim()), ep.id);
      setTestModal(null);
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content api-page">
        <div className="page-header">
          <h1>API Reference</h1>
          <p>Programmatic access to your orders, status checks, and downloads.</p>
        </div>

        <div className="api-content">
          {/* Authentication Section */}
          <section className="api-section">
            <h2 className="section-title">Authentication</h2>
            <p className="section-desc">Include your API key in every request using the <code className="inline-code">x-api-key</code> header.</p>
            <div className="code-block">
              <div className="code-label">Request Header</div>
              <pre>{`x-api-key: YOUR_API_KEY`}</pre>
            </div>
          </section>

          {/* API Key Section */}
          <section className="api-section">
            <h2 className="section-title">Your API Key</h2>
            <p className="section-desc">Keep your API key secret. It will not be shown again after generation.</p>

            {apiKeyLoading ? (
              <div className="api-loading-state">
                <div className="spinner" />
                <span>Loading...</span>
              </div>
            ) : apiKey?.hasKey && apiKey?.rawKey ? (
              <div className="key-display generated">
                <div className="key-value">
                  <code className="key-text">
                    {keyRevealed ? apiKey.rawKey : '•'.repeat(Math.min(apiKey.rawKey.length, 40))}
                  </code>
                  <div className="key-actions">
                    <button className="btn btn-icon" onClick={() => setKeyRevealed(!keyRevealed)}>
                      {keyRevealed ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </button>
                    <button className="btn btn-copy" onClick={() => copyToClipboard(apiKey.rawKey, 'key')}>
                      {copied === 'key' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <p className="key-warning">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                  Save this key — it will not be shown again.
                </p>
                <div className="key-footer">
                  <button className="btn btn-ghost" onClick={() => setShowRegenerateModal(true)}>
                    Regenerate Key
                  </button>
                </div>
              </div>
            ) : apiKey?.hasKey ? (
              <div className="key-display existing">
                <p className="key-info">Your API key is saved securely. Use Regenerate Key to get a new key (the old key will be invalidated).</p>
                <div className="key-footer">
                  <button className="btn btn-primary" onClick={() => setShowRegenerateModal(true)}>
                    Regenerate Key
                  </button>
                </div>
              </div>
            ) : (
              <div className="key-generate">
                <p>No API key generated yet. Create one to start making API requests.</p>
                <button className="btn btn-primary btn-lg" onClick={generateApiKey}>
                  Generate API Key
                </button>
              </div>
            )}

            {apiKeyError && (
              <div className="alert alert-error">{apiKeyError}</div>
            )}
          </section>

          {/* Endpoints Section */}
          <section className="api-section">
            <h2 className="section-title">Endpoints</h2>
            <p className="section-desc">Available endpoints for order management:</p>

            <div className="endpoints-list">
              {endpoints.map((ep) => (
                <div key={ep.id} className="endpoint-card" style={{ marginBottom: '24px', padding: '20px' }}>
                  <div className="endpoint-header">
                    <span className={`method-badge ${ep.method.toLowerCase()}`}>{ep.method}</span>
                    <code className="endpoint-path">{ep.path}</code>
                    <span className="endpoint-desc">{ep.desc}</span>
                  </div>

                  {ep.params && (
                    <div className="endpoint-params">
                      <span className="param-label">{Object.keys(ep.params)[0]}:</span>
                      <span className="param-desc">{Object.values(ep.params)[0]}</span>
                    </div>
                  )}

                  <div className="endpoint-response">
                    <span className="response-label">Response:</span>
                    <span className="response-desc">{ep.response.description}</span>
                  </div>

                  <div className="endpoint-example">
                    <div className="code-label">Response Body</div>
                    <pre>{JSON.stringify(ep.response.example, null, 2)}</pre>
                  </div>

                  <div className="endpoint-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleTestClick(ep)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                      </svg>
                      Test
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Test Parameter Modal */}
        {testModal && (
          <div className="modal-overlay" onClick={() => setTestModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Enter {Object.keys(testModal.params)[0]}</h3>
                <button className="modal-close" onClick={() => setTestModal(null)}>X</button>
              </div>
              <div className="modal-body">
                <label className="form-label">
                  {Object.keys(testModal.params)[0]}
                  <span className="form-hint">{Object.values(testModal.params)[0]}</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={paramValue}
                  onChange={(e) => setParamValue(e.target.value)}
                  placeholder={`Enter ${Object.keys(testModal.params)[0]}...`}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && paramValue.trim()) {
                      handleModalSubmit(testModal);
                    }
                  }}
                />
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setTestModal(null)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleModalSubmit(testModal)}
                  disabled={!paramValue.trim()}
                >
                  Copy curl
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Regenerate Modal */}
        {showRegenerateModal && (
          <div className="modal-overlay" onClick={() => setShowRegenerateModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Regenerate API Key?</h3>
                <button className="modal-close" onClick={() => setShowRegenerateModal(false)}>X</button>
              </div>
              <p className="modal-body">
                Your current key will be invalidated immediately. Any scripts using the old key will stop working.
              </p>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowRegenerateModal(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={regenerateApiKey}>Regenerate Key</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}