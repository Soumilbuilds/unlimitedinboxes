import axios from 'axios';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import * as sharedCloudflare from './cloudflare.js';

export class SmtpDnsError extends Error {
  constructor(code, publicMessage, status = 409) {
    super(publicMessage);
    this.name = 'SmtpDnsError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

const conflict = () => new SmtpDnsError('DNS_CONFLICT', 'Existing DNS records conflict with this setup. Review your domain DNS before trying again.');
const unavailable = () => new SmtpDnsError('DNS_UNAVAILABLE', 'DNS could not be reached. Try again.', 502);
const waitingMessage = 'Nameservers are not active yet. DNS changes can take some time. Update them at your registrar, then check again.';
const dnsTypeCodes = { NS: 2, CNAME: 5, MX: 15, TXT: 16, A: 1, AAAA: 28 };

function host(value, allowUnderscore = false) {
  if (typeof value !== 'string') throw conflict();
  const name = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ''));
  const pattern = allowUnderscore ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!name || name.length > 253 || !name.includes('.') || !name.split('.').every(label => pattern.test(label)) || isIP(name)) throw conflict();
  return name;
}

function domainName(value) {
  try { return host(value); } catch { throw new SmtpDnsError('INVALID_DOMAIN', 'Enter a valid domain.', 400); }
}

function normalizeRecord(record, domain) {
  const type = String(record?.type || '').toUpperCase();
  if (!Object.hasOwn(dnsTypeCodes, type) || type === 'NS') throw conflict();
  let name = record.name;
  if (name === '@') name = domain;
  else if (typeof name === 'string' && (!name.includes('.') || name.endsWith('._domainkey'))) name = `${name}.${domain}`;
  name = host(name, true);
  if (name !== domain && !name.endsWith(`.${domain}`)) throw conflict();
  let content = record.content ?? record.value;
  if (typeof content !== 'string' || !content.trim() || content.length > 8192 || /[\x00-\x1f\x7f]/.test(content)) throw conflict();
  if (type === 'MX' || type === 'CNAME') content = host(content);
  if (type === 'A' && isIP(content) !== 4) throw conflict();
  if (type === 'AAAA' && isIP(content) !== 6) throw conflict();
  const normalized = { type, name, content };
  if (type === 'MX') {
    const priority = Number(record.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw conflict();
    normalized.priority = priority;
  }
  return normalized;
}

function unquoteTxt(value) {
  const text = String(value).trim();
  if (!text.startsWith('"')) return text;
  const chunks = [];
  const expression = /"((?:\\.|[^"\\])*)"/g;
  let match;
  let offset = 0;
  while ((match = expression.exec(text))) {
    if (text.slice(offset, match.index).trim()) return text;
    chunks.push(match[1].replace(/\\(\d{3}|.)/g, (_, escaped) => /^\d{3}$/.test(escaped) ? String.fromCharCode(Number(escaped)) : escaped));
    offset = expression.lastIndex;
  }
  return chunks.length && !text.slice(offset).trim() ? chunks.join('') : text;
}

function isSpf(value) { return /^v=spf1(?:\s|$)/i.test(unquoteTxt(value)); }
function isDmarc(value) { return /^v=DMARC1\s*;/i.test(unquoteTxt(value)); }

function parseSpf(value) {
  const parts = unquoteTxt(value).trim().split(/\s+/);
  if (parts.shift()?.toLowerCase() !== 'v=spf1' || !parts.length) throw conflict();
  // Conservative merge: arbitrary macros, redirect, modifiers, and negative mechanisms are not safely additive.
  const all = parts.pop();
  if (!/^[~?+-]?all$/i.test(all) || parts.some(part => !/^(?:\+)?(?:include:[a-z0-9.-]+|ip4:[0-9./]+|ip6:[a-f0-9:/]+|a(?::[a-z0-9.-]+)?(?:\/\d{1,3})?|mx(?::[a-z0-9.-]+)?(?:\/\d{1,3})?)$/i.test(part))) throw conflict();
  if (/^\+?all$/i.test(all)) throw conflict();
  const mechanisms = parts.map(part => part.replace(/^\+/, '').toLowerCase());
  for (const mechanism of mechanisms) {
    if (mechanism.startsWith('ip4:') || mechanism.startsWith('ip6:')) {
      const [address, prefix, extra] = mechanism.slice(4).split('/');
      const version = mechanism.startsWith('ip4:') ? 4 : 6;
      if (isIP(address) !== version || extra || (prefix != null && (Number(prefix) < 0 || Number(prefix) > (version === 4 ? 32 : 128)))) throw conflict();
    }
    if (mechanism.startsWith('include:')) host(mechanism.slice(8));
  }
  return { mechanisms, all: all.toLowerCase() };
}

function mergeSpf(existing, required) {
  const current = parseSpf(existing);
  const desired = parseSpf(required);
  const mechanisms = [...new Set([...current.mechanisms, ...desired.mechanisms])];
  // Include mechanisms may each expand to multiple lookups. Reject even the obvious >10-lookup case.
  if (mechanisms.filter(item => /^(?:include:|a(?::|\/|$)|mx(?::|\/|$))/.test(item)).length > 10) throw conflict();
  const strength = { '-all': 3, '~all': 2, '?all': 1 };
  const all = strength[current.all] >= strength[desired.all] ? current.all : desired.all;
  return `v=spf1${mechanisms.length ? ` ${mechanisms.join(' ')}` : ''} ${all}`;
}

function validDmarc(value) {
  const text = unquoteTxt(value);
  if (!isDmarc(text)) return false;
  const tags = new Map();
  for (const part of text.split(';').map(item => item.trim()).filter(Boolean)) {
    const match = /^([a-z]+)\s*=\s*(.+)$/i.exec(part);
    if (!match || tags.has(match[1].toLowerCase())) return false;
    tags.set(match[1].toLowerCase(), match[2].trim());
  }
  return ['none', 'quarantine', 'reject'].includes(tags.get('p'));
}

function sameRecord(a, b) {
  const content = value => a.type === 'TXT' ? unquoteTxt(value) : String(value).toLowerCase().replace(/\.$/, '');
  return a.type === b.type && a.name.toLowerCase().replace(/\.$/, '') === b.name.toLowerCase().replace(/\.$/, '')
    && content(a.content) === content(b.content) && (a.type !== 'MX' || Number(a.priority) === Number(b.priority));
}

async function findZone(domain) {
  const response = await axios.get('https://api.cloudflare.com/client/v4/zones', {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_ZONE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN}` },
    params: { name: domain, per_page: 50 }, timeout: 15000, maxRedirects: 0
  });
  const results = response.data?.result;
  if (response.data?.success !== true || !Array.isArray(results)) throw unavailable();
  const matching = results.filter(zone => zone.name === domain);
  if (matching.length > 1) throw conflict();
  return matching[0] || null;
}

async function createZoneStrict(domain) {
  // The shared createZone helper silently reuses duplicate zones; this security boundary must not.
  const token = process.env.CLOUDFLARE_ZONE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const options = { headers: { Authorization: `Bearer ${token}` }, timeout: 15000, maxRedirects: 0 };
  const accounts = await axios.get('https://api.cloudflare.com/client/v4/accounts', options);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || accounts.data?.result?.[0]?.id;
  if (!accountId) throw unavailable();
  try {
    const response = await axios.post('https://api.cloudflare.com/client/v4/zones', {
      name: domain, account: { id: accountId }, type: 'full',
      ...(process.env.CLOUDFLARE_NS1 && process.env.CLOUDFLARE_NS2 ? {
        vanity_name_servers: [process.env.CLOUDFLARE_NS1, process.env.CLOUDFLARE_NS2]
      } : {})
    }, options);
    if (response.data?.success !== true) throw unavailable();
    return response.data.result;
  } catch (error) {
    if (error.response?.data?.errors?.some(item => item.code === 1061)) {
      throw new SmtpDnsError('DNS_ZONE_UNCLAIMED', 'This domain is already managed by the platform. Contact support to confirm ownership.');
    }
    throw unavailable();
  }
}

const defaultCloudflare = { ...sharedCloudflare, findZone, createZone: createZoneStrict };
function publicResolver() {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return resolver;
}

/** Injectable transports keep DNS tests entirely offline; public functions below use the production adapter. */
export function createSmtpDnsService({ cloudflare = defaultCloudflare, resolver = publicResolver(), fetchImpl = fetch, requestTimeoutMs = 5000 } = {}) {
  const timeoutMs = Math.max(1, Math.min(Number(requestTimeoutMs) || 5000, 15000));
  const zoneLocks = new Map();
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async function resolvePublic(name, type) {
    try {
      const method = { NS: 'resolveNs', TXT: 'resolveTxt', MX: 'resolveMx', CNAME: 'resolveCname', A: 'resolve4', AAAA: 'resolve6' }[type];
      return await bounded(() => resolver[method](name));
    } catch {
      const controller = new AbortController();
      try {
        return await bounded(async () => {
          const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name, type })}`, {
            headers: { accept: 'application/dns-json' }, signal: controller.signal, redirect: 'error'
          });
          if (!response.ok) throw unavailable();
          const data = await response.json();
          if (data.Status !== 0) throw unavailable();
          return (data.Answer || []).filter(answer => answer.type === dnsTypeCodes[type]).map(answer => {
            if (type === 'TXT') return [unquoteTxt(answer.data)];
            if (type === 'MX') {
              const match = /^(\d+)\s+(.+)$/.exec(answer.data);
              if (!match) throw unavailable();
              return { priority: Number(match[1]), exchange: match[2] };
            }
            return answer.data;
          });
        });
      } catch { return []; } finally { controller.abort(); }
    }
  }

  async function listRecords(zoneId, name) {
    const result = [];
    const seen = new Set();
    for (let page = 1; page <= 1000; page++) {
      const records = await cloudflare.listDnsRecords(zoneId, { name, per_page: 100, page });
      if (!Array.isArray(records)) throw unavailable();
      for (const record of records) {
        if (!record.id || seen.has(record.id)) throw unavailable();
        seen.add(record.id);
        result.push(record);
      }
      if (records.length < 100) return result;
    }
    throw unavailable();
  }

  function normalizeZone(zone) {
    const zoneId = zone.id ?? zone.zoneId;
    const nameServers = [...new Set((zone.name_servers ?? zone.nameServers ?? []).map(value => host(value)))].sort();
    if (typeof zoneId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(zoneId) || nameServers.length < 2) throw unavailable();
    return { zoneId, nameServers };
  }

  async function findSmtpZone(value) {
    const domain = domainName(value);
    try {
      if (typeof cloudflare.findZone !== 'function') throw unavailable();
      const zone = await cloudflare.findZone(domain);
      return zone ? normalizeZone(zone) : null;
    } catch (error) { if (error instanceof SmtpDnsError) throw error; throw unavailable(); }
  }

  async function ensureSmtpZone(value, { ownedZoneId } = {}) {
    const domain = domainName(value);
    try {
      const existing = await findSmtpZone(domain);
      if (existing) {
        if (!ownedZoneId || existing.zoneId !== ownedZoneId) {
          throw new SmtpDnsError('DNS_ZONE_UNCLAIMED', 'This domain is already managed by the platform. Contact support to confirm ownership.');
        }
        return { ...existing, created: false, reused: true };
      }
      if (ownedZoneId) throw new SmtpDnsError('DNS_ZONE_MISSING', 'Your domain DNS configuration is no longer available. Contact support.');
      const zone = normalizeZone(await cloudflare.createZone(domain));
      return { ...zone, created: true, reused: false };
    } catch (error) { if (error instanceof SmtpDnsError) throw error; throw unavailable(); }
  }

  async function checkSmtpNameservers({ domain: value, nameServers }) {
    const domain = domainName(value);
    let expected;
    try { expected = [...new Set((nameServers || []).map(value => host(value)))].sort(); } catch { expected = []; }
    const actual = await resolvePublic(domain, 'NS');
    let live = [];
    try { live = [...new Set(actual.map(value => host(value)))].sort(); } catch { /* Untrusted DNS answer. */ }
    const connected = expected.length >= 2 && expected.length === live.length && expected.every((value, index) => value === live[index]);
    return { connected, name_servers: live, message: connected ? 'Nameservers Connected' : waitingMessage };
  }

  async function reconcileUnlocked({ domain: value, zoneId, records }) {
    const domain = domainName(value);
    if (typeof zoneId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(zoneId) || !Array.isArray(records)) throw conflict();
    const desired = records.map(record => normalizeRecord(record, domain));
    if (!desired.some(record => record.type === 'TXT' && record.name === `_dmarc.${domain}` && isDmarc(record.content))) {
      desired.push({ type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none;' });
    }
    const groups = new Map();
    for (const record of desired) {
      const existing = groups.get(record.name) || [];
      if (existing.some(item => sameRecord(item, record))) continue;
      existing.push(record);
      groups.set(record.name, existing);
    }
    const actions = [];
    const final = [];
    // Plan and validate every hostname before any write, so a later conflict cannot leave partial DNS mutations.
    for (const [name, requirements] of groups) {
      const current = await listRecords(zoneId, name);
      const hasCname = current.some(record => record.type === 'CNAME') || requirements.some(record => record.type === 'CNAME');
      if (hasCname && (current.some(record => record.type !== 'CNAME') || requirements.some(record => record.type !== 'CNAME') || requirements.length !== 1)) throw conflict();
      const desiredSpf = requirements.filter(record => record.type === 'TXT' && isSpf(record.content));
      if (desiredSpf.length > 1) throw conflict();
      const currentSpf = current.filter(record => record.type === 'TXT' && isSpf(record.content));
      if (desiredSpf.length && currentSpf.length > 1) throw conflict();
      const desiredMx = requirements.filter(record => record.type === 'MX');
      if (desiredMx.length && current.some(record => record.type === 'MX' && !desiredMx.some(item => sameRecord(item, record)))) throw conflict();
      for (const required of requirements) {
        let record = { ...required };
        let target;
        if (record.type === 'TXT' && isSpf(record.content)) {
          parseSpf(record.content);
          target = currentSpf[0];
          if (target) record.content = mergeSpf(target.content, record.content);
        } else if (record.type === 'TXT' && record.name === `_dmarc.${domain}`) {
          if (!validDmarc(record.content)) throw conflict();
          const matches = current.filter(item => item.type === 'TXT');
          if (matches.length > 1 || (matches.length && !validDmarc(matches[0].content))) throw conflict();
          target = matches[0];
          // Keep every existing valid policy and reporting tag; provision only the missing policy.
          if (target) record.content = unquoteTxt(target.content);
        } else if (record.type === 'CNAME' || (record.type === 'TXT' && record.name.includes('._domainkey.'))) {
          const matches = current.filter(item => item.type === record.type);
          if (matches.length && (matches.length !== 1 || !sameRecord(matches[0], record))) throw conflict();
        }
        if (!current.some(item => sameRecord(item, record))) {
          actions.push({ record, target });
        }
        final.push(record);
      }
    }
    for (const { record, target } of actions) {
      if (target) await cloudflare.updateDnsRecord(zoneId, target.id, record);
      else await cloudflare.addDnsRecord(zoneId, record.type, record.name, record.content, record.priority);
    }
    // A successful write is not sufficient: check the stored records and duplicate SPF after reconciliation.
    for (const name of groups.keys()) {
      const actual = await listRecords(zoneId, name);
      if (final.some(record => record.name === name && !actual.some(item => sameRecord(item, record)))) throw unavailable();
      if (final.some(record => record.name === name && record.type === 'TXT' && isSpf(record.content))
          && actual.filter(record => record.type === 'TXT' && isSpf(record.content)).length !== 1) throw conflict();
    }
    return final;
  }

  async function reconcileSmtpDns(input) {
    // Serialize read/merge/write within this process. Orders are also leased by the processor across restarts.
    const key = input.zoneId;
    const previous = zoneLocks.get(key) || Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    zoneLocks.set(key, pending);
    await previous;
    try { return await reconcileUnlocked(input); }
    catch (error) { if (error instanceof SmtpDnsError) throw error; throw unavailable(); }
    finally { release(); if (zoneLocks.get(key) === pending) zoneLocks.delete(key); }
  }

  async function verifySmtpDns({ domain: value, nameServers, records }) {
    const domain = domainName(value);
    if (!Array.isArray(records)) throw conflict();
    const normalized = records.map(record => normalizeRecord(record, domain));
    const delegation = await checkSmtpNameservers({ domain, nameServers });
    const missing = delegation.connected ? [] : [{ type: 'NS', name: domain }];
    const cache = new Map();
    for (const record of normalized) {
      const key = `${record.type}:${record.name}`;
      if (!cache.has(key)) cache.set(key, await resolvePublic(record.name, record.type));
      const answers = cache.get(key);
      let matches = false;
      if (record.type === 'TXT') {
        const values = answers.map(answer => Array.isArray(answer) ? answer.join('') : unquoteTxt(answer));
        const filtered = isSpf(record.content) ? values.filter(isSpf) : isDmarc(record.content) ? values.filter(isDmarc) : values;
        matches = filtered.includes(unquoteTxt(record.content)) && (!(isSpf(record.content) || isDmarc(record.content)) || filtered.length === 1);
      } else if (record.type === 'MX') {
        matches = answers.some(answer => String(answer.exchange).toLowerCase().replace(/\.$/, '') === record.content && Number(answer.priority) === record.priority);
      } else {
        matches = answers.some(answer => String(answer).toLowerCase().replace(/\.$/, '') === record.content.toLowerCase());
      }
      if (!matches) missing.push({ type: record.type, name: record.name });
    }
    return { ready: missing.length === 0, missing };
  }

  return { findSmtpZone, ensureSmtpZone, checkSmtpNameservers, reconcileSmtpDns, verifySmtpDns };
}

const service = createSmtpDnsService();
export const findSmtpZone = service.findSmtpZone;
export const ensureSmtpZone = service.ensureSmtpZone;
export const checkSmtpNameservers = service.checkSmtpNameservers;
export const reconcileSmtpDns = service.reconcileSmtpDns;
export const verifySmtpDns = service.verifySmtpDns;
