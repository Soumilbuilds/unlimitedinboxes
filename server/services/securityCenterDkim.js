import dns from 'dns/promises';
import { createIncognitoPage, ensureMicrosoftLogin, saveDebugScreenshot } from './puppeteer.js';

const SECURITY_CENTER_URL = 'https://security.microsoft.com/authentication?viewid=DKIM';
const SECURITY_BASE = 'https://security.microsoft.com';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeDnsName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function pick(obj, keys) {
  if (!obj) return null;
  for (const key of keys) {
    if (obj[key]) return obj[key];
  }
  return null;
}

function extractDkimItem(payload) {
  if (!payload) return null;
  const candidates = [];
  if (Array.isArray(payload.Value)) candidates.push(...payload.Value);
  if (Array.isArray(payload.value)) candidates.push(...payload.value);
  if (payload.Value && typeof payload.Value === 'object' && !Array.isArray(payload.Value)) candidates.push(payload.Value);
  if (payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)) candidates.push(payload.value);
  if (Array.isArray(payload.Data)) candidates.push(...payload.Data);
  if (payload.Data && typeof payload.Data === 'object' && !Array.isArray(payload.Data)) candidates.push(payload.Data);
  if (payload.Result && typeof payload.Result === 'object') candidates.push(payload.Result);

  return candidates.find(item =>
    pick(item, ['Selector1CNAME', 'Selector1Cname', 'Selector1CName', 'selector1Cname', 'selector1CNAME']) ||
    pick(item, ['Selector2CNAME', 'Selector2Cname', 'Selector2CName', 'selector2Cname', 'selector2CNAME'])
  ) || null;
}

async function getXsrfToken(page) {
  try {
    const cookies = await page.cookies(SECURITY_BASE);
    const token = cookies.find(c => c.name === 'XSRF-TOKEN');
    if (!token?.value) return null;
    try {
      return decodeURIComponent(token.value);
    } catch {
      return token.value;
    }
  } catch {
    return null;
  }
}

async function securityFetch(page, { path, method = 'GET', body = null, tenantId = null, headers = {} }) {
  let xsrf = await getXsrfToken(page);
  if (!xsrf) {
    await sleep(1000);
    xsrf = await getXsrfToken(page);
  }
  const finalHeaders = {
    accept: 'application/json, text/plain, */*',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
    ...(tenantId ? { 'x-tid': tenantId } : {}),
    'x-requested-with': 'XMLHttpRequest',
    'x-clientside-xhr-queue': 'psws-exo',
    'x-tabvisible': 'visible',
    'x-clientpage': 'authentication@antispam',
    ...headers
  };

  const url = path.startsWith('http') ? path : `${SECURITY_BASE}${path}`;
  const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

  return await page.evaluate(async ({ fetchUrl, fetchMethod, fetchHeaders, fetchBody }) => {
    try {
      const res = await fetch(fetchUrl, {
        method: fetchMethod,
        headers: fetchHeaders,
        credentials: 'include',
        body: fetchBody || undefined
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, text };
    } catch (error) {
      return { ok: false, status: 0, error: error?.message || String(error) };
    }
  }, {
    fetchUrl: url,
    fetchMethod: method,
    fetchHeaders: finalHeaders,
    fetchBody: payload
  });
}

export async function loginToSecurityCenter(email, password) {
  const { context, page } = await createIncognitoPage();
  page.setDefaultTimeout(60000);

  const result = await ensureMicrosoftLogin(page, email, password, context, SECURITY_CENTER_URL);
  if (!result.success) {
    await saveDebugScreenshot(result.page || page, 'security_center_login_error');
    return { success: false, error: result.error, page: result.page || page, context };
  }

  let activePage = result.page;
  if (!activePage.url().includes('security.microsoft.com')) {
    await activePage.goto(SECURITY_CENTER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  }

  if (!activePage.url().includes('security.microsoft.com')) {
    await saveDebugScreenshot(activePage, 'security_center_login_error');
    return { success: false, error: 'Could not reach Microsoft Security Center', page: activePage, context };
  }

  return { success: true, page: activePage, context };
}

export async function getDkimConfig(page, tenantId, domain) {
  const res = await securityFetch(page, {
    path: `/apiproxy/admin/Beta/${tenantId}/InvokeCommand`,
    method: 'POST',
    body: {
      CmdletInput: {
        CmdletName: 'Get-DkimSigningConfig',
        Parameters: { Identity: domain }
      }
    },
    tenantId,
    headers: {
      'x-servicetype': 'Exo'
    }
  });

  if (!res.ok) {
    return { success: false, status: res.status, error: res.error || res.text || 'Failed to fetch DKIM config', raw: res };
  }

  const item = extractDkimItem(res.json);
  const selector1 = pick(item, ['Selector1CNAME', 'Selector1Cname', 'Selector1CName', 'selector1Cname', 'selector1CNAME']);
  const selector2 = pick(item, ['Selector2CNAME', 'Selector2Cname', 'Selector2CName', 'selector2Cname', 'selector2CNAME']);
  const enabled = pick(item, ['Enabled', 'enabled']);

  if (!selector1 || !selector2) {
    return { success: false, status: res.status, error: 'DKIM selectors not found in response', raw: res.json };
  }

  return {
    success: true,
    Selector1CNAME: selector1,
    Selector2CNAME: selector2,
    Enabled: enabled,
    raw: res.json
  };
}

export async function createDkimConfig(page, tenantId, domain) {
  return await securityFetch(page, {
    path: `/api/DkimSigningConfig/New?identity=${encodeURIComponent(domain)}`,
    method: 'PUT',
    tenantId
  });
}

export async function enableDkimSigning(page, tenantId, domain) {
  return await securityFetch(page, {
    path: '/api/DkimSigningConfig',
    method: 'PUT',
    body: { Identity: domain, Enabled: true },
    tenantId
  });
}

export async function retryEnableDkimSigning(page, tenantId, domain, log = console.log) {
  const intervalMs = Number(process.env.DKIM_ENABLE_RETRY_INTERVAL_MS || 60000);
  const timeoutMinutes = Number(process.env.DKIM_ENABLE_TIMEOUT_MIN || 120);
  const timeoutMs = timeoutMinutes > 0 ? timeoutMinutes * 60 * 1000 : 0;

  const startedAt = Date.now();
  let attempts = 0;
  let last = null;

  while (!timeoutMs || Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    last = await enableDkimSigning(page, tenantId, domain);
    if (last.ok) {
      return {
        success: true,
        attempts,
        status: last.status,
        response: last.json || last.text
      };
    }

    log(`Enable DKIM failed (status ${last.status}). Retrying in ${Math.round(intervalMs / 1000)}s...`);
    await sleep(intervalMs);
  }

  return {
    success: false,
    attempts,
    error: last?.error || last?.text || 'Enable DKIM did not succeed within the timeout window',
    status: last?.status,
    response: last?.json || last?.text
  };
}

export async function ensureDkimSelectors(page, tenantId, domain, log = console.log) {
  let cfg = await getDkimConfig(page, tenantId, domain);
  if (cfg.success) return cfg;

  log('DKIM config missing; creating signing config in Security Center...');
  const created = await createDkimConfig(page, tenantId, domain);
  if (!created.ok) {
    throw new Error(created.error || created.text || 'Failed to create DKIM signing config');
  }

  await sleep(4000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    cfg = await getDkimConfig(page, tenantId, domain);
    if (cfg.success) return cfg;
    await sleep(3000);
  }

  throw new Error(cfg.error || 'DKIM selectors not available after creation');
}

export async function waitForDkimPropagation(domain, selector1Cname, selector2Cname, log = console.log) {
  const intervalMs = Number(process.env.DKIM_PROPAGATION_INTERVAL_MS || 60000);
  const timeoutMinutes = Number(process.env.DKIM_PROPAGATION_TIMEOUT_MIN || 40);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const resolver = new dns.Resolver();
  const customServers = process.env.DKIM_PROPAGATION_DNS_SERVERS
    ? process.env.DKIM_PROPAGATION_DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
    : ['1.1.1.1', '8.8.8.8'];
  resolver.setServers(customServers);

  const expected1 = normalizeDnsName(selector1Cname);
  const expected2 = normalizeDnsName(selector2Cname);
  const selector1Name = `selector1._domainkey.${normalizeDnsName(domain)}`;
  const selector2Name = `selector2._domainkey.${normalizeDnsName(domain)}`;

  const startedAt = Date.now();
  let attempt = 0;
  let last = { selector1: [], selector2: [] };

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    try {
      const [s1, s2] = await Promise.all([
        resolver.resolveCname(selector1Name).catch(() => []),
        resolver.resolveCname(selector2Name).catch(() => [])
      ]);

      const normalized1 = s1.map(normalizeDnsName);
      const normalized2 = s2.map(normalizeDnsName);
      last = { selector1: normalized1, selector2: normalized2 };

      const ok1 = normalized1.includes(expected1);
      const ok2 = normalized2.includes(expected2);

      if (ok1 && ok2) {
        log(`DKIM DNS propagated after ${attempt} checks.`);
        return {
          propagated: true,
          attempts: attempt,
          selector1: normalized1,
          selector2: normalized2
        };
      }
    } catch (error) {
      last = { selector1: [], selector2: [], error: error?.message || String(error) };
    }

    log(`DKIM DNS not propagated yet (attempt ${attempt}). Waiting ${Math.round(intervalMs / 1000)}s...`);
    await sleep(intervalMs);
  }

  return {
    propagated: false,
    attempts: attempt,
    selector1: last.selector1 || [],
    selector2: last.selector2 || [],
    error: last.error || 'Timed out waiting for DKIM DNS propagation'
  };
}
