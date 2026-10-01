import { randomBytes } from 'node:crypto';

const CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
const PAGE_SIZE = 100;

function domainName(value) {
  if (typeof value !== 'string') throw new TypeError('Domain is required');
  const name = value.trim().replace(/\.$/, '').toLowerCase();
  if (name.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(name)) {
    throw new TypeError('Invalid domain');
  }
  return name;
}

function mailboxAddress(value) {
  if (typeof value !== 'string') throw new TypeError('Mailbox address is required');
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  if (at < 1 || local.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(local) || local.endsWith('.') || local.includes('..')) {
    throw new TypeError('Invalid mailbox address');
  }
  const domain = domainName(address.slice(at + 1));
  return { email: `${local}@${domain}`, local, domain };
}

function mailboxPassword(value) {
  const secret = value === undefined ? `M${randomBytes(32).toString('hex')}` : value;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128 ||
      /[\x00-\x1f\x7f]/.test(secret) || /^[=+\-@$\{]/.test(secret)) {
    throw new TypeError('Invalid mailbox password');
  }
  return secret;
}

function publicDomain(item) {
  return { id: item.id, name: item.name, isEnabled: item.isEnabled !== false };
}

function publicMailbox(item, domain) {
  return { id: item.id, email: item.emailAddress || `${item.name}@${domain}`, domain };
}

function isManagedMailbox(item) {
  return item['@type'] === 'User' && item.roles?.['@type'] === 'User';
}

export class StalwartMailboxProvider {
  constructor({ baseUrl, token, tokenSecretKey, secretStore, fetchImpl = fetch, requestTimeoutMs = 30000 }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new TypeError('Valid Stalwart base URL is required'); }
    const secureTransport = url.protocol === 'https:';
    const privateLoopback = url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if ((!secureTransport && !privateLoopback) || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') {
      throw new TypeError('Stalwart base URL must be HTTPS or HTTP on IP loopback, without credentials or extra path');
    }
    if (!secretStore || typeof secretStore.get !== 'function' || typeof secretStore.set !== 'function') {
      throw new TypeError('A secret store with get and set is required');
    }
    if ((!token && !tokenSecretKey) || (token && tokenSecretKey)) {
      throw new TypeError('Provide either a token or a token secret key');
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('Invalid request timeout');
    this.endpoint = new URL('/jmap/', url).toString();
    this.token = token;
    this.tokenSecretKey = tokenSecretKey;
    this.secretStore = secretStore;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async call(method, args) {
    const token = this.tokenSecretKey ? await this.secretStore.get(this.tokenSecretKey) : this.token;
    if (!token) throw new Error('Stalwart credential is unavailable');
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ using: CAPABILITIES, methodCalls: [[method, args, 'c1']] }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new Error('Stalwart request failed');
    }
    if (!response.ok) throw new Error(`Stalwart request failed (${response.status})`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Invalid Stalwart response'); }
    const result = body?.methodResponses?.[0];
    if (!Array.isArray(result) || result[0] !== method || result[2] !== 'c1' || !result[1] || result[1].type) {
      throw new Error('Stalwart method failed');
    }
    return result[1];
  }

  async query(type, filter = {}) {
    const objects = [];
    for (let position = 0; ;) {
      const page = await this.call(`x:${type}/query`, { filter, position, limit: PAGE_SIZE });
      if (!Array.isArray(page.ids)) throw new Error('Invalid Stalwart query response');
      if (page.ids.length) {
        const fetched = await this.call(`x:${type}/get`, { ids: page.ids });
        if (!Array.isArray(fetched.list)) throw new Error('Invalid Stalwart get response');
        objects.push(...fetched.list);
      }
      position += page.ids.length;
      if (!page.ids.length || position >= page.total) break;
    }
    return objects;
  }

  async listDomains() {
    return (await this.query('Domain')).map(publicDomain);
  }

  async getDomain(name) {
    const normalized = domainName(name);
    const match = (await this.query('Domain', { name: normalized }))
      .find(item => item.name?.toLowerCase() === normalized);
    return match ? publicDomain(match) : null;
  }

  async ensureDomain(name, { dkimManagement = 'Automatic' } = {}) {
    const normalized = domainName(name);
    if (!['Automatic', 'Manual'].includes(dkimManagement)) throw new TypeError('Invalid DKIM management mode');
    const existing = await this.getDomain(normalized);
    if (existing) return { ...existing, created: false };
    const result = await this.call('x:Domain/set', { create: { new1: {
      name: normalized,
      aliases: {},
      certificateManagement: { '@type': 'Manual' },
      dkimManagement: { '@type': dkimManagement },
      dnsManagement: { '@type': 'Manual' },
      subAddressing: { '@type': 'Enabled' },
    } } });
    if (result.created?.new1?.id) return { id: result.created.new1.id, name: normalized, isEnabled: true, created: true };
    const raced = await this.getDomain(normalized);
    if (raced) return { ...raced, created: false };
    throw new Error('Stalwart domain creation failed');
  }

  async listMailboxes(domain) {
    const found = await this.getDomain(domain);
    if (!found) return [];
    return (await this.query('Account', { domainId: found.id }))
      .filter(item => isManagedMailbox(item) && item.domainId === found.id)
      .map(item => publicMailbox(item, found.name));
  }

  async mailboxRecord(email) {
    const address = mailboxAddress(email);
    const domain = await this.getDomain(address.domain);
    if (!domain) return null;
    const match = (await this.query('Account', { domainId: domain.id, name: address.local }))
      .find(item => item.domainId === domain.id && item.name?.toLowerCase() === address.local);
    if (match && !isManagedMailbox(match)) {
      throw new Error('Account exists but is not a managed mailbox');
    }
    return match ? { account: match, domain } : null;
  }

  async getMailbox(email) {
    const record = await this.mailboxRecord(email);
    return record ? publicMailbox(record.account, record.domain.name) : null;
  }

  async ensureMailbox(email, { password } = {}) {
    const address = mailboxAddress(email);
    const suppliedSecret = password === undefined ? null : mailboxPassword(password);
    const domain = await this.ensureDomain(address.domain);
    const existing = await this.getMailbox(address.email);
    const secretKey = `mailbox:${address.email}`;
    const storedSecret = await this.secretStore.get(secretKey);
    if (existing) {
      if (!storedSecret) throw new Error('Mailbox credential is unavailable');
      return { ...existing, created: false };
    }
    if (storedSecret && suppliedSecret && storedSecret !== suppliedSecret) {
      throw new Error('Mailbox credential is already staged');
    }
    const secret = storedSecret ?? suppliedSecret ?? mailboxPassword();
    // Persist before Account/set so a lost response or crash can reuse this exact password.
    if (!storedSecret) await this.secretStore.set(secretKey, secret);
    const result = await this.call('x:Account/set', { create: { new1: {
      '@type': 'User', name: address.local, domainId: domain.id,
      credentials: { '0': { '@type': 'Password', secret } },
      roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' },
      aliases: {}, quotas: {}, memberGroupIds: {},
      encryptionAtRest: { '@type': 'Disabled' },
    } } });
    if (!result.created?.new1?.id) {
      const raced = await this.getMailbox(address.email);
      if (raced) return { ...raced, created: false };
      throw new Error('Stalwart mailbox creation failed');
    }
    return { id: result.created.new1.id, email: address.email, domain: address.domain, created: true };
  }

  async rotatePassword(email, { password } = {}) {
    const address = mailboxAddress(email);
    const suppliedSecret = password === undefined ? null : mailboxPassword(password);
    const record = await this.mailboxRecord(address.email);
    if (!record) throw new Error('Mailbox does not exist');
    const credentialId = Object.entries(record.account.credentials || {})
      .find(([, credential]) => credential?.['@type'] === 'Password')?.[0];
    if (!credentialId || !/^\d+$/.test(credentialId)) throw new Error('Mailbox password credential is unavailable');
    const mailbox = publicMailbox(record.account, record.domain.name);
    const secret = suppliedSecret ?? mailboxPassword();
    const result = await this.call('x:Account/set', { update: { [mailbox.id]: {
      [`credentials/${credentialId}/secret`]: secret,
    } } });
    if (!result.updated || !Object.hasOwn(result.updated, mailbox.id)) throw new Error('Stalwart password rotation failed');
    await this.secretStore.set(`mailbox:${address.email}`, secret);
    return mailbox;
  }

  // Explicitly destructive; callers must select a mailbox. Provisioning never calls this.
  async deleteMailbox(email) {
    const mailbox = await this.getMailbox(email);
    if (!mailbox) return false;
    const result = await this.call('x:Account/set', { destroy: [mailbox.id] });
    if (!result.destroyed?.includes(mailbox.id)) throw new Error('Stalwart mailbox deletion failed');
    return true;
  }

  // Explicitly destructive; callers must select a domain. Provisioning never calls this.
  async deleteDomain(name) {
    const domain = await this.getDomain(name);
    if (!domain) return false;
    const result = await this.call('x:Domain/set', { destroy: [domain.id] });
    if (!result.destroyed?.includes(domain.id)) throw new Error('Stalwart domain deletion failed');
    return true;
  }
}
