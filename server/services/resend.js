import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

const API_URL = 'https://api.resend.com';
// Keep a conservative request interval for customer accounts; honor provider rate-limit headers.
const REQUEST_INTERVAL_MS = Math.max(125, Number(process.env.RESEND_REQUEST_INTERVAL_MS) || 600);
const queues = new Map();
const DOMAIN_STATUSES = new Set(['not_started', 'pending', 'verified', 'failed', 'temporary_failure']);
const SETTINGS = Object.freeze({
  capabilities: { sending: 'enabled', receiving: 'disabled' },
  open_tracking: false,
  click_tracking: false
});

export class ResendError extends Error {
  constructor(code, publicMessage, status = 502, retryAfterMs = 0) {
    super(publicMessage);
    this.name = 'ResendError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function invalidResponse() {
  return new ResendError('RESEND_UNAVAILABLE', 'Resend could not be reached. Try again.', 502, 30000);
}

function validDomain(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f/@:]/.test(value.trim())) {
    throw new ResendError('INVALID_DOMAIN', 'Enter a valid domain.', 400);
  }
  const domain = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ''));
  if (!domain || domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )) || /^\d+(?:\.\d+){3}$/.test(domain)) {
    throw new ResendError('INVALID_DOMAIN', 'Enter a valid domain.', 400);
  }
  return domain;
}

function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw invalidResponse();
  return id;
}

function normalizeRecord(record, domain) {
  const type = String(record?.type || '').toUpperCase();
  if (!['TXT', 'MX', 'CNAME'].includes(type)) throw invalidResponse();
  const rawName = typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
  let name;
  if (rawName === '@' || rawName === '') name = domain;
  else if (rawName === domain || rawName.endsWith(`.${domain}`)) name = rawName;
  else if (rawName.endsWith('.')) {
    name = rawName.slice(0, -1);
    if (name !== domain && !name.endsWith(`.${domain}`)) throw invalidResponse();
  } else name = `${rawName}.${domain}`;
  if (name.length > 253 || !name.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) {
    throw invalidResponse();
  }
  let content = record.value ?? record.content;
  if (typeof content !== 'string' || !content || content.length > 8192 || /[\x00-\x1f\x7f]/.test(content)) {
    throw invalidResponse();
  }
  if (type !== 'TXT') content = validDomain(content);
  const result = { type, name, content };
  if (type === 'MX') {
    const priority = Number(record.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw invalidResponse();
    result.priority = priority;
  }
  return result;
}

function normalizeDomain(body) {
  if (!body || typeof body !== 'object') throw invalidResponse();
  const domain = validDomain(body.name);
  const result = {
    id: validId(body.id),
    name: domain,
    status: DOMAIN_STATUSES.has(body.status) ? body.status : 'not_started',
    records: Array.isArray(body.records) ? body.records.map(record => normalizeRecord(record, domain)) : []
  };
  if (typeof body.open_tracking === 'boolean') result.open_tracking = body.open_tracking;
  if (typeof body.click_tracking === 'boolean') result.click_tracking = body.click_tracking;
  if (body.capabilities && ['enabled', 'disabled'].includes(body.capabilities.sending)
      && ['enabled', 'disabled'].includes(body.capabilities.receiving)) {
    result.capabilities = { sending: body.capabilities.sending, receiving: body.capabilities.receiving };
  }
  if (typeof body.created_at === 'string' && /^[0-9T :+.Z-]{1,64}$/.test(body.created_at)) result.created_at = body.created_at;
  return result;
}

function retryDelay(headers, fallback = 1000) {
  const retry = headers?.get?.('retry-after');
  let milliseconds = Number.NaN;
  if (retry != null && retry !== '') {
    milliseconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  }
  const reset = Number(headers?.get?.('ratelimit-reset'));
  if (!Number.isFinite(milliseconds) && reset > 0) milliseconds = reset * 1000;
  return Math.max(1000, Number.isFinite(milliseconds) ? milliseconds : fallback);
}

function upstreamError(status, body, headers, operation) {
  // Inspect only to classify. No raw upstream text, body, headers, or cause survive this boundary.
  const name = typeof body?.name === 'string' ? body.name : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  if (status === 429) return new ResendError('RESEND_RATE_LIMIT', 'Resend is busy. Try again shortly.', 429, retryDelay(headers));
  if (name === 'invalid_permission' || (name === 'restricted_api_key' && status === 401)
      || (status === 403 && /only send|full access|missing.*scope|permission/i.test(message))) {
    return new ResendError('RESEND_FULL_ACCESS_REQUIRED', 'This API key does not have Full Access. Create a Full Access key in Resend and try again.', 400);
  }
  if (status === 401 || ['invalid_api_key', 'missing_api_key', 'suspended_api_key', 'restricted_api_key'].includes(name)) {
    return new ResendError('RESEND_INVALID_KEY', 'This API key is invalid.', 400);
  }
  if (operation === 'create' && (([400, 403, 409, 422].includes(status) && /already.*(?:registered|exist|connected)|(?:registered|exist|connected).*already|another.*account/i.test(message)) || status === 409)) {
    return new ResendError('RESEND_DOMAIN_CONFLICT', 'This domain is already connected to another Resend account.', 409);
  }
  if (status === 403) return new ResendError('RESEND_FULL_ACCESS_REQUIRED', 'This API key does not have Full Access. Create a Full Access key in Resend and try again.', 400);
  if (operation === 'create' && [400, 422].includes(status) && /limit|quota|maximum/i.test(message)) {
    return new ResendError('RESEND_DOMAIN_LIMIT', 'Your Resend domain limit has been reached. Check your Resend plan.', 400);
  }
  if (status === 404) return new ResendError('RESEND_DOMAIN_NOT_FOUND', 'This domain is no longer available in your Resend account. Prepare the domain again.', 409);
  return invalidResponse();
}

/** Domain-management client. Credentials and transports are deliberately non-enumerable private fields. */
export class ResendService {
  #apiKey;
  #fetch;
  #timeout;
  #queue;

  constructor({ apiKey, fetchImpl = fetch, requestTimeoutMs = 15000 } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\x00-\x20\x7f]/.test(apiKey.trim()) || apiKey.length > 512) {
      throw new ResendError('RESEND_INVALID_KEY', 'This API key is invalid.', 400);
    }
    this.#apiKey = apiKey.trim();
    this.#fetch = fetchImpl;
    this.#timeout = Math.max(1, Math.min(Number(requestTimeoutMs) || 15000, 60000));
    const queueId = createHash('sha256').update(this.#apiKey).digest('hex');
    if (!queues.has(queueId)) queues.set(queueId, { pending: Promise.resolve(), nextAt: 0, cooldownUntil: 0 });
    this.#queue = queues.get(queueId);
  }

  async #request(path, { method = 'GET', body, operation } = {}) {
    // Every path is assembled internally; redirect following is disabled so Authorization stays on the fixed host.
    const queue = this.#queue;
    const previous = queue.pending;
    let release;
    queue.pending = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (queue.cooldownUntil > Date.now()) {
        throw new ResendError('RESEND_RATE_LIMIT', 'Resend is busy. Try again shortly.', 429, queue.cooldownUntil - Date.now());
      }
      const wait = Math.max(0, queue.nextAt - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      queue.nextAt = Date.now() + REQUEST_INTERVAL_MS;
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          (async () => {
            const res = await this.#fetch(`${API_URL}${path}`, {
              method,
              headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
              ...(body ? { body: JSON.stringify(body) } : {}),
              redirect: 'error',
              signal: controller.signal
            });
            let data;
            try { data = await res.json(); } catch {
              if (res.ok) throw invalidResponse();
              data = null; // Classify HTTP errors (especially 429) even when an intermediary sends HTML.
            }
            return { res, data };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(invalidResponse()); }, this.#timeout);
          })
        ]);
        const { res, data } = response;
        if (!res.ok) {
          const error = upstreamError(res.status, data, res.headers, operation);
          if (error.code === 'RESEND_RATE_LIMIT') queue.cooldownUntil = Date.now() + error.retryAfterMs;
          throw error;
        }
        if (res.headers?.get?.('ratelimit-remaining') === '0') {
          queue.cooldownUntil = Date.now() + retryDelay(res.headers);
        }
        return data;
      } catch (error) {
        if (error instanceof ResendError) throw error;
        throw invalidResponse();
      } finally { clearTimeout(timer); }
    } finally { release(); }
  }

  async validateKey() { return this.listDomains(); }

  async listDomains() {
    const domains = new Map();
    const cursors = new Set();
    let after;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
      const result = await this.#request(`/domains?${params}`);
      if (!Array.isArray(result?.data)) throw invalidResponse();
      for (const item of result.data) {
        const domain = normalizeDomain(item);
        domains.set(domain.id, domain);
      }
      if (result.has_more !== true) return [...domains.values()];
      after = result.data.at(-1)?.id;
      if (!after || cursors.has(after)) throw invalidResponse();
      validId(after);
      cursors.add(after);
    }
    throw invalidResponse();
  }

  async getDomain(id) {
    return normalizeDomain(await this.#request(`/domains/${validId(id)}`));
  }

  async ensureDomain(value) {
    const domainName = validDomain(value);
    let domain = (await this.listDomains()).find(item => item.name === domainName);
    if (domain) domain = await this.getDomain(domain.id);
    else {
      try {
        domain = normalizeDomain(await this.#request('/domains', {
          method: 'POST', body: { name: domainName, capabilities: SETTINGS.capabilities }, operation: 'create'
        }));
      } catch (error) {
        if (error.code !== 'RESEND_DOMAIN_CONFLICT') throw error;
        // Handle an in-account create race, but never claim or transfer an inaccessible domain.
        const discovered = (await this.listDomains()).find(item => item.name === domainName);
        if (!discovered) throw error;
        domain = await this.getDomain(discovered.id);
      }
    }
    if (domain.name !== domainName) throw invalidResponse();
    if (domain.open_tracking !== false || domain.click_tracking !== false
        || domain.capabilities?.sending !== 'enabled' || domain.capabilities?.receiving !== 'disabled') {
      await this.#request(`/domains/${validId(domain.id)}`, { method: 'PATCH', body: SETTINGS });
      domain = await this.getDomain(domain.id);
      if (domain.name !== domainName || domain.open_tracking !== false || domain.click_tracking !== false
          || domain.capabilities?.sending !== 'enabled' || domain.capabilities?.receiving !== 'disabled') throw invalidResponse();
    }
    return domain;
  }

  async verifyDomain(id) {
    const domainId = validId(id);
    await this.#request(`/domains/${domainId}/verify`, { method: 'POST' });
    return this.getDomain(domainId);
  }
}
