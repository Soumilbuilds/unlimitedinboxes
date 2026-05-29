import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

export default function API() {
  const [apiKey, setApiKey] = useState(null);
  const [apiKeyLoading, setApiKeyLoading] = useState(true);
  const [apiKeyError, setApiKeyError] = useState('');
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [copied, setCopied] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testLoading, setTestLoading] = useState(false);

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

  const copyKey = () => {
    if (apiKey?.rawKey) {
      navigator.clipboard.writeText(apiKey.rawKey);
      setCopied('key');
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const copyCurl = (curlCmd, endpointId) => {
    navigator.clipboard.writeText(curlCmd);
    setCopied(endpointId);
    setTimeout(() => setCopied(null), 2000);
  };

  const testApiKey = async () => {
    if (!apiKey?.rawKey) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await api.get('/orders');
      setTestResult({ success: true, data: res.data });
    } catch (e) {
      setTestResult({ success: false, error: e.response?.data?.error || e.message });
    } finally {
      setTestLoading(false);
    }
  };

  const baseUrl = (() => {
    if (typeof window !== 'undefined') {
      const env = window.location.hostname;
      if (env === 'localhost' || env === '127.0.0.1') return 'http://localhost:5173';
    }
    return 'https://unlimitedinboxes.com';
  })();

  const getKeyValue = () => apiKey?.rawKey || 'YOUR_API_KEY';

  const endpoints = [
    {
      id: 'list-orders',
      method: 'GET',
      path: '/api/orders',
      desc: 'List all your orders',
      headers: { 'x-api-key': 'Required — your API key' },
      params: null,
      body: null,
      response: {
        description: 'Array of order objects with pagination info',
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
      },
      errors: [
        { code: 401, message: 'Unauthorized — missing or invalid API key' }
      ],
      curl: `${baseUrl}/api/orders`
    },
    {
      id: 'get-order',
      method: 'GET',
      path: '/api/orders/:id',
      desc: 'Get a specific order by ID with full details',
      headers: { 'x-api-key': 'Required — your API key' },
      params: { id: 'Order ID (integer, required)' },
      body: null,
      response: {
        description: 'Full order object with status and progress',
        example: {
          id: 1,
          status: 'pending',
          progress: 0,
          total_mailboxes: 100,
          created_mailboxes_count: 0,
          createdAt: '2026-05-29T10:30:00.000Z',
          updatedAt: '2026-05-29T10:30:00.000Z'
        }
      },
      errors: [
        { code: 401, message: 'Unauthorized — missing or invalid API key' },
        { code: 404, message: 'Not Found — order does not exist' }
      ],
      curl: `${baseUrl}/api/orders/1`
    },
    {
      id: 'start-order',
      method: 'POST',
      path: '/api/orders/:id/start',
      desc: 'Start processing an order to create mailboxes',
      headers: { 'x-api-key': 'Required — your API key' },
      params: { id: 'Order ID (integer, required)' },
      body: null,
      response: {
        description: 'Success confirmation',
        example: {
          success: true,
          message: 'Processing started',
          orderId: 1
        }
      },
      errors: [
        { code: 401, message: 'Unauthorized — missing or invalid API key' },
        { code: 404, message: 'Not Found — order does not exist' },
        { code: 409, message: 'Conflict — order already processing or completed' }
      ],
      curl: `-X POST ${baseUrl}/api/orders/1/start`
    },
    {
      id: 'download-csv',
      method: 'GET',
      path: '/api/orders/:id/download',
      desc: 'Download mailbox credentials as a CSV file',
      headers: { 'x-api-key': 'Required — your API key' },
      params: { id: 'Order ID (integer, required)' },
      body: null,
      response: {
        description: 'CSV file download with columns: email, password',
        example: 'email,password\nmailbox1@example.com,securePassword123\nmailbox2@example.com,securePassword456',
        contentType: 'text/csv'
      },
      errors: [
        { code: 401, message: 'Unauthorized — missing or invalid API key' },
        { code: 403, message: 'Forbidden — download requires paid plan or completed order' },
        { code: 404, message: 'Not Found — order does not exist' }
      ],
      curl: `${baseUrl}/api/orders/1/download`
    }
  ];

  const generateCurl = (ep) => {
    if (ep.method === 'POST') {
      return `curl ${ep.curl} \\
  -H "x-api-key: ${getKeyValue()}"`;
    }
    if (ep.path.includes('/download')) {
      return `curl ${ep.curl} \\
  -H "x-api-key: ${getKeyValue()}" \\
  -o mailboxes.csv`;
    }
    return `curl ${ep.curl} \\
  -H "x-api-key: ${getKeyValue()}"`;
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content api-page">
        <div className="page-header">
          <div>
            <h1>API</h1>
            <p>Programmatic access to your orders, status checks, and downloads.</p>
          </div>
        </div>

        <div className="api-content">
          {/* API Key Section */}
          <section className="api-section">
            <h2 className="section-title">Your API Key</h2>
            <p className="section-desc">Your API key authenticates all requests. Keep it secret.</p>

            {apiKeyLoading ? (
              <div className="api-loading-state">
                <div className="spinner" />
                <span>Loading...</span>
              </div>
            ) : apiKey?.hasKey && apiKey?.rawKey ? (
              <div className="key-display generated">
                <div className="key-value">
                  <code className="key-text">{apiKey.rawKey}</code>
                  <button className="btn btn-copy" onClick={copyKey}>
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="key-warning">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                  Save this key — it will not be shown again.
                </p>
                <div className="key-actions">
                  <button className="btn btn-secondary" onClick={testApiKey} disabled={testLoading}>
                    {testLoading ? 'Testing...' : 'Test Key'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setShowRegenerateModal(true)}>
                    Regenerate
                  </button>
                </div>
                {testResult && (
                  <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                    <pre>{JSON.stringify(testResult.success ? { connected: true, orderCount: testResult.data?.length || 0 } : { error: testResult.error }, null, 2)}</pre>
                  </div>
                )}
              </div>
            ) : apiKey?.hasKey ? (
              <div className="key-display existing">
                <div className="key-masked">
                  <code>{'•'.repeat(48)}</code>
                  <span className="key-hint">Key on file — not shown for security</span>
                </div>
                <div className="key-meta">
                  {apiKey.createdAt && (
                    <span>Created {new Date(apiKey.createdAt).toLocaleDateString()}</span>
                  )}
                  {apiKey.lastUsedAt && (
                    <span>Last used {new Date(apiKey.lastUsedAt).toLocaleDateString()}</span>
                  )}
                </div>
                <div className="key-actions">
                  <button className="btn btn-secondary" onClick={testApiKey} disabled={testLoading}>
                    {testLoading ? 'Testing...' : 'Test Key'}
                  </button>
                  <button className="btn btn-primary" onClick={() => setShowRegenerateModal(true)}>
                    Regenerate Key
                  </button>
                </div>
                {testResult && (
                  <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                    <pre>{JSON.stringify(testResult.success ? { connected: true, orderCount: testResult.data?.length || 0 } : { error: testResult.error }, null, 2)}</pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="key-generate">
                <p>No API key generated yet.</p>
                <button className="btn btn-primary btn-lg" onClick={generateApiKey}>
                  Generate API Key
                </button>
              </div>
            )}

            {apiKeyError && (
              <div className="alert alert-error">{apiKeyError}</div>
            )}
          </section>

          {/* Authentication Section */}
          <section className="api-section">
            <h2 className="section-title">Authentication</h2>
            <p className="section-desc">Include your API key in every request using the <code>x-api-key</code> header.</p>
            <div className="code-block">
              <div className="code-label">Request Header</div>
              <pre>{`x-api-key: YOUR_API_KEY`}</pre>
            </div>
          </section>

          {/* Base URL Section */}
          <section className="api-section">
            <h2 className="section-title">Base URL</h2>
            <p className="section-desc">All API requests go to this base URL:</p>
            <div className="base-url-display">
              <code>{baseUrl}</code>
            </div>
          </section>

          {/* Endpoints Section */}
          <section className="api-section">
            <h2 className="section-title">Endpoints</h2>
            <p className="section-desc">Available endpoints for order management:</p>

            <div className="endpoints-list">
              {endpoints.map((ep) => (
                <div key={ep.path} className="endpoint-card">
                  <div className="endpoint-main">
                    <div className="endpoint-header">
                      <span className={`method-badge ${ep.method.toLowerCase()}`}>{ep.method}</span>
                      <code className="endpoint-path">{ep.path}</code>
                    </div>
                    <p className="endpoint-desc">{ep.desc}</p>
                    <div className="endpoint-details">
                      {/* Headers */}
                      <div className="detail-row">
                        <span className="detail-label">Headers:</span>
                        <div className="detail-content">
                          {ep.headers && Object.entries(ep.headers).map(([key, val]) => (
                            <div key={key} className="header-row">
                              <code className="header-key">{key}</code>
                              <span className="header-val">{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Path Params */}
                      {ep.params && (
                        <div className="detail-row">
                          <span className="detail-label">Path Params:</span>
                          <div className="detail-content">
                            {Object.entries(ep.params).map(([key, val]) => (
                              <div key={key} className="param-row">
                                <code className="param-key">{key}</code>
                                <span className="param-val">{val}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Response */}
                      <div className="detail-row">
                        <span className="detail-label">Response:</span>
                        <div className="detail-content">
                          <p className="response-desc">{ep.response.description}</p>
                          {typeof ep.response.example === 'string' ? (
                            <pre className="response-preview csv">{ep.response.example}</pre>
                          ) : (
                            <div className="code-block response-block">
                              <div className="code-label">Response Body</div>
                              <pre>{JSON.stringify(ep.response.example, null, 2)}</pre>
                            </div>
                          )}
                          {ep.response.contentType && (
                            <span className="content-type-badge">{ep.response.contentType}</span>
                          )}
                        </div>
                      </div>

                      {/* Error Responses */}
                      {ep.errors && ep.errors.length > 0 && (
                        <div className="detail-row">
                          <span className="detail-label">Errors:</span>
                          <div className="detail-content">
                            {ep.errors.map((err, i) => (
                              <div key={i} className="error-row">
                                <span className="error-code">{err.code}</span>
                                <span className="error-msg">{err.message}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="endpoint-curl">
                    <div className="curl-header">
                      <span className="curl-label">curl</span>
                      <button
                        className="btn btn-copy-small"
                        onClick={() => copyCurl(generateCurl(ep), ep.id)}
                      >
                        {copied === ep.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <pre className="curl-code">{generateCurl(ep)}</pre>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Status Codes Section */}
          <section className="api-section">
            <h2 className="section-title">Status Codes</h2>
            <div className="status-codes">
              <div className="status-row">
                <span className="status-code success">200</span>
                <span>Success</span>
              </div>
              <div className="status-row">
                <span className="status-code info">201</span>
                <span>Created (new key generated)</span>
              </div>
              <div className="status-row">
                <span className="status-code error">400</span>
                <span>Bad Request — invalid parameters</span>
              </div>
              <div className="status-row">
                <span className="status-code error">401</span>
                <span>Unauthorized — missing or invalid API key</span>
              </div>
              <div className="status-row">
                <span className="status-code error">403</span>
                <span>Forbidden — not allowed (e.g. download requires paid plan)</span>
              </div>
              <div className="status-row">
                <span className="status-code error">404</span>
                <span>Not Found — order doesn't exist</span>
              </div>
              <div className="status-row">
                <span className="status-code error">409</span>
                <span>Conflict — order already processing</span>
              </div>
              <div className="status-row">
                <span className="status-code error">500</span>
                <span>Server Error — something went wrong</span>
              </div>
            </div>
          </section>
        </div>

        {showRegenerateModal && (
          <div className="modal-overlay" onClick={() => setShowRegenerateModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Regenerate API Key?</h3>
                <button className="modal-close" onClick={() => setShowRegenerateModal(false)}>X</button>
              </div>
              <p className="modal-body">
                Your current key will be invalidated immediately. Any scripts or integrations using the old key will stop working until updated.
              </p>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowRegenerateModal(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={regenerateApiKey}>
                  Regenerate Key
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
