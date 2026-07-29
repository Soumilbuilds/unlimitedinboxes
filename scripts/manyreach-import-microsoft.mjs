#!/usr/bin/env node

import fs from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const puppeteerModule = requireFromServerNodeModules('puppeteer-extra/dist/index.cjs.js');
const StealthPluginModule = requireFromServerNodeModules('puppeteer-extra-plugin-stealth/index.js');
const puppeteer = puppeteerModule.default || puppeteerModule;
const StealthPlugin = StealthPluginModule.default || StealthPluginModule;
puppeteer.use(StealthPlugin());

const DEFAULT_CSV = '/Users/poonam/Downloads/export-emailacc-20260702T13_15_24.csv';
const DEFAULT_STATE_FILE = 'logs/manyreach-import/state.json';
const DEFAULT_RESULTS_FILE = 'logs/manyreach-import/results.ndjson';
const DEFAULT_SCREENSHOT_DIR = 'logs/manyreach-import/screenshots';
const DEFAULT_OAUTH_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=select_account&client_id=56fe48ec-6d11-4c16-8471-353196c3f401&redirect_uri=https%3A%2F%2Fapp.manyreach.com%2Fe%2Foauth2%2Fms%2Faddsenderfromcode&response_type=code&response_mode=query&scope=user.read%20offline_access%20openid%20email%20profile%20Mail.Send%20Mail.Read%20Mail.ReadWrite%20https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All%20https%3A%2F%2Foutlook.office.com%2FSMTP.Send&state=%2Fe%2Fsenders%3Fservice%3D%26warmup%3D%26folder%3D%26tag%3D%26sender%3D-1%26status%3D%26search%3D%26provider%3D%26trackingDomain%3D%26o%3D15308%26servicetype%3Dall%26org%3D15308';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function requireFromServerNodeModules(moduleFile) {
  const roots = [
    process.env.SERVER_NODE_MODULES,
    path.resolve(SCRIPT_DIR, '../server/node_modules'),
    path.resolve(process.cwd(), 'server/node_modules'),
    '/opt/unlimited-inboxes/current/server/node_modules'
  ].filter(Boolean);

  const errors = [];
  for (const root of roots) {
    try {
      return require(path.join(root, moduleFile));
    } catch (error) {
      errors.push(`${root}: ${error.message}`);
    }
  }

  throw new Error(`Could not load ${moduleFile}. Tried:\n${errors.join('\n')}`);
}

function usage() {
  return `
Usage:
  MAILBOX_PASSWORD='...' MANYREACH_COOKIES_FILE=/path/cookies.json \\
    node scripts/manyreach-import-microsoft.mjs [options]

Options:
  --csv <path>              Mailbox export CSV. Default: ${DEFAULT_CSV}
  --cookies <path>          Manyreach cookies JSON file. Also supports MANYREACH_COOKIES_FILE.
  --password <value>        Mailbox password. Prefer MAILBOX_PASSWORD to avoid shell history.
  --oauth-url <url>         Microsoft OAuth URL. Defaults to the Manyreach Microsoft sender URL.
  --limit <n>               Process only n accounts after filtering.
  --skip <n>                Skip first n accounts after filtering.
  --only <a@b,c@d>          Process only these emails.
  --provider <name>         Provider filter. Default: MICROSOFT365.
  --concurrency <n>         Parallel browser contexts. Default: 1.
  --headless                Run Chromium headless.
  --dry-run                 Parse/filter only; no browser or secrets required.
  --verbose                 Print per-account OAuth step progress.
  --account-timeout-ms <n>  Hard timeout per mailbox. Default: 180000.
  --account-retries <n>     Retry transient browser failures per mailbox. Default: 2.
  --retry-success           Re-run accounts already marked success in state.
  --skip-failed             Skip accounts already marked failed/manual in state.
  --state-file <path>       Resume state file. Default: ${DEFAULT_STATE_FILE}
  --results-file <path>     NDJSON results log. Default: ${DEFAULT_RESULTS_FILE}
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected argument: ${raw}`);
    }

    const eq = raw.indexOf('=');
    let key = raw.slice(2);
    let value = true;
    if (eq !== -1) {
      key = raw.slice(2, eq);
      value = raw.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }

    args[toCamel(key)] = value;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function toInt(value, fallback, name) {
  if (value === undefined || value === true || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

async function readCsv(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const rows = parseCsv(raw);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(row => row.some(cell => String(cell || '').trim() !== ''))
    .map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])));
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function filterMailboxes(rows, opts) {
  const provider = String(opts.provider || 'MICROSOFT365').toUpperCase();
  const only = opts.only
    ? new Set(String(opts.only).split(',').map(v => v.trim().toLowerCase()).filter(Boolean))
    : null;

  let items = rows
    .map((row, index) => ({
      index,
      email: String(row.email || row.username || '').trim().toLowerCase(),
      firstName: String(row.first_name || '').trim(),
      lastName: String(row.last_name || '').trim(),
      provider: String(row.provider || '').trim().toUpperCase(),
      row
    }))
    .filter(item => item.email && item.email.includes('@'))
    .filter(item => !provider || item.provider === provider)
    .filter(item => !only || only.has(item.email));

  const skip = toInt(opts.skip, 0, '--skip');
  const limit = toInt(opts.limit, null, '--limit');
  if (skip) items = items.slice(skip);
  if (limit !== null) items = items.slice(0, limit);
  return items;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadCookies(opts) {
  let cookiesRaw = process.env.MANYREACH_COOKIES_JSON;
  const cookieFile = opts.cookies || process.env.MANYREACH_COOKIES_FILE;

  if (!cookiesRaw && cookieFile) {
    cookiesRaw = await fs.readFile(cookieFile, 'utf8');
  }
  if (!cookiesRaw) {
    throw new Error('Missing Manyreach cookies. Set MANYREACH_COOKIES_FILE, MANYREACH_COOKIES_JSON, or pass --cookies.');
  }

  const parsed = JSON.parse(cookiesRaw);
  if (!Array.isArray(parsed)) {
    throw new Error('Manyreach cookies JSON must be an array exported from the browser.');
  }

  return parsed.map(normalizeCookie).filter(Boolean);
}

function normalizeCookie(cookie) {
  if (!cookie || !cookie.name || cookie.value === undefined) return null;
  const normalized = {
    name: String(cookie.name),
    value: String(cookie.value),
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };

  if (cookie.domain) normalized.domain = cookie.domain;
  if (cookie.url) normalized.url = cookie.url;
  if (cookie.expirationDate) normalized.expires = Math.floor(cookie.expirationDate);
  if (cookie.expires && cookie.expires > 0) normalized.expires = Math.floor(cookie.expires);
  if (cookie.sameSite) {
    const sameSite = String(cookie.sameSite).toLowerCase();
    if (sameSite === 'lax') normalized.sameSite = 'Lax';
    if (sameSite === 'strict') normalized.sameSite = 'Strict';
    if (sameSite === 'none' || sameSite === 'no_restriction') normalized.sameSite = 'None';
  }
  if (normalized.sameSite === 'None') normalized.secure = true;
  return normalized;
}

async function loadState(filePath) {
  const state = await readJsonFile(filePath, { accounts: {} });
  if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
  return state;
}

async function saveState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, filePath);
}

async function appendResult(filePath, result) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(result)}\n`);
}

function shouldSkip(item, state, opts) {
  const previous = state.accounts[item.email];
  if (!previous) return false;
  if (previous.status === 'success' && !opts.retrySuccess) return true;
  if (opts.skipFailed && previous.status !== 'success') return true;
  return false;
}

async function launchBrowser(opts) {
  return puppeteer.launch({
    headless: opts.headless ? 'new' : false,
    defaultViewport: { width: 1440, height: 1000 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning,PasswordManagerOnboarding,PasswordManagerRedesign',
      '--disable-save-password-bubble',
      '--window-size=1440,1000',
      '--mute-audio'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });
}

async function newContext(browser) {
  if (typeof browser.createBrowserContext === 'function') {
    return browser.createBrowserContext();
  }
  if (typeof browser.createIncognitoBrowserContext === 'function') {
    return browser.createIncognitoBrowserContext();
  }
  throw new Error('This Puppeteer version does not support browser contexts.');
}

async function newPreparedPage(context) {
  const page = await context.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);
  return page;
}

async function setManyreachCookies(page, cookies) {
  await page.goto('https://app.manyreach.com/favicon.ico', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  }).catch(() => null);
  await page.setCookie(...cookies);
}

async function connectMailbox(params) {
  const maxRetries = toInt(params.opts.accountRetries, 2, '--account-retries');

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await connectMailboxOnce(params);
    if (result.status !== 'failed' || !isTransientAutomationError(result.reason) || attempt === maxRetries) {
      return result;
    }

    logVerbose(
      params.opts,
      params.item.email,
      `Transient browser error, retrying account (${attempt + 1}/${maxRetries}): ${result.reason}`
    );
    await sleep(1000 * (attempt + 1));
  }
}

async function connectMailboxOnce({ browser, item, password, cookies, oauthUrl, opts }) {
  const context = await newContext(browser);
  let page = await newPreparedPage(context);
  const startedAt = new Date().toISOString();
  const accountTimeoutMs = toInt(opts.accountTimeoutMs, 180000, '--account-timeout-ms');
  let timedOut = false;
  let timer = null;

  const runPromise = (async () => {
    logVerbose(opts, item.email, 'Injecting Manyreach cookies');
    await setManyreachCookies(page, cookies);
    logVerbose(opts, item.email, 'Opening Microsoft OAuth URL');
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

    const result = await driveMicrosoftOAuth(page, context, item, password, opts);
    return {
      email: item.email,
      status: result.success ? 'success' : result.manual ? 'manual' : 'failed',
      reason: result.reason || null,
      finalUrl: sanitizeUrl(result.finalUrl || page.url()),
      screenshot: result.screenshot || null,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  })().catch(async (error) => {
    const screenshot = await saveScreenshot(page, item.email, 'error', opts).catch(() => null);
    return {
      email: item.email,
      status: 'failed',
      reason: error.message,
      finalUrl: page && !page.isClosed() ? sanitizeUrl(page.url()) : null,
      screenshot,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  });

  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(async () => {
      timedOut = true;
      const screenshot = await saveScreenshot(page, item.email, 'timeout', opts).catch(() => null);
      await context.close().catch(() => null);
      resolve({
        email: item.email,
        status: 'manual',
        reason: `Timed out after ${accountTimeoutMs}ms`,
        finalUrl: page && !page.isClosed() ? sanitizeUrl(page.url()) : null,
        screenshot,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    }, accountTimeoutMs);
  });

  try {
    const result = await Promise.race([runPromise, timeoutPromise]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    await context.close().catch(() => null);
    if (timedOut) runPromise.catch(() => null);
  }
}

function isTransientAutomationError(message) {
  return /detached frame|execution context was destroyed|cannot find context|target closed|navigation failed|frame got detached/i
    .test(String(message || ''));
}

async function driveMicrosoftOAuth(page, context, item, password, opts) {
  const maxSteps = toInt(opts.maxSteps, 90, '--max-steps');
  let lastFingerprint = '';
  let stagnantSteps = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    page = await pickActivePage(context, page);
    if (!page || page.isClosed()) {
      throw new Error('Browser page closed during OAuth flow');
    }

    await sleep(750);
    const url = page.url();
    const title = await safeTitle(page);
    const text = await bodyText(page);
    const lower = text.toLowerCase();
    const fingerprint = `${url}|${title}|${lower.slice(0, 300)}`;

    if (opts.verbose || step === 1 || step % 10 === 0) {
      logVerbose(opts, item.email, `Step ${step}: ${title || '(no title)'} ${sanitizeUrl(url)}`);
    }

    if (fingerprint === lastFingerprint) {
      stagnantSteps += 1;
    } else {
      stagnantSteps = 0;
      lastFingerprint = fingerprint;
    }

    const microsoftError = detectMicrosoftError(lower);
    if (microsoftError) {
      const screenshot = await saveScreenshot(page, item.email, 'microsoft-error', opts);
      return { success: false, reason: microsoftError, finalUrl: url, screenshot };
    }

    if (isManyreachUrl(url)) {
      const result = await handleManyreachLanding(page, item, opts);
      if (result.done) return result;
    }

    const emailInput = await findVisibleHandle(page, 'input[type="email"], input[name="loginfmt"]');
    if (emailInput) {
      await setInputValue(page, emailInput, item.email);
      await clickSubmit(page);
      await waitForStep(page);
      continue;
    }

    const passwordInput = await findVisibleHandle(page, 'input[type="password"], input[name="passwd"]');
    if (passwordInput) {
      await setInputValue(page, passwordInput, password);
      await clickSubmit(page);
      await waitForStep(page);
      continue;
    }

    if (await handleAccountPicker(page)) {
      await waitForStep(page);
      continue;
    }

    if (await handleConsent(page)) {
      await waitForStep(page, 5000);
      continue;
    }

    if (await handleStaySignedIn(page, opts)) {
      await waitForStep(page, 5000);
      continue;
    }

    if (await handleSecurityPrompt(page)) {
      await waitForStep(page, 5000);
      continue;
    }

    if (await handleGenericContinue(page)) {
      await waitForStep(page, 5000);
      continue;
    }

    if (requiresManualInput(lower)) {
      const screenshot = await saveScreenshot(page, item.email, 'manual', opts);
      return {
        success: false,
        manual: true,
        reason: 'Manual Microsoft step required',
        finalUrl: url,
        screenshot
      };
    }

    if (stagnantSteps >= 8) {
      const screenshot = await saveScreenshot(page, item.email, 'stalled', opts);
      return {
        success: false,
        manual: true,
        reason: `OAuth flow stalled on "${title || url}"`,
        finalUrl: url,
        screenshot
      };
    }
  }

  const screenshot = await saveScreenshot(page, item.email, 'max-steps', opts);
  return {
    success: false,
    manual: true,
    reason: `OAuth flow exceeded ${maxSteps} steps`,
    finalUrl: page.url(),
    screenshot
  };
}

async function pickActivePage(context, currentPage) {
  const pages = (await context.pages()).filter(p => !p.isClosed());
  if (!pages.length) return currentPage;
  const scored = pages.map(p => ({ page: p, score: scorePageUrl(p.url()) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].page : currentPage;
}

function scorePageUrl(rawUrl) {
  if (!rawUrl || rawUrl === 'about:blank') return 0;
  try {
    const { hostname } = new URL(rawUrl);
    if (hostname === 'app.manyreach.com') return 100;
    if (hostname.endsWith('login.microsoftonline.com')) return 90;
    if (hostname.endsWith('.microsoft.com')) return 80;
    if (hostname.endsWith('.microsoftonline.com')) return 80;
    if (hostname.endsWith('.live.com')) return 70;
    return 10;
  } catch {
    return 0;
  }
}

function isManyreachUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname === 'app.manyreach.com';
  } catch {
    return false;
  }
}

async function handleManyreachLanding(page, item, opts) {
  await sleep(2500);
  const url = page.url();
  const lower = (await bodyText(page)).toLowerCase();

  if (/sign in|login|log in/.test(lower) && !lower.includes(item.email)) {
    const screenshot = await saveScreenshot(page, item.email, 'manyreach-login', opts);
    return {
      done: true,
      success: false,
      reason: 'Manyreach session is not authenticated; refresh cookies',
      finalUrl: url,
      screenshot
    };
  }

  if (/already|duplicate|exists/.test(lower) && lower.includes('sender')) {
    return { done: true, success: true, reason: 'Sender already exists', finalUrl: url };
  }

  if (/error|failed|invalid|denied/.test(lower) && /oauth|microsoft|sender|mailbox|permission/.test(lower)) {
    const screenshot = await saveScreenshot(page, item.email, 'manyreach-error', opts);
    return {
      done: true,
      success: false,
      reason: clipText(lower),
      finalUrl: url,
      screenshot
    };
  }

  if (url.includes('/e/oauth2/ms/addsenderfromcode')) {
    await waitForStep(page, 7000);
    return { done: false };
  }

  const verified = await verifySenderVisible(page, item, opts);
  if (verified.success) {
    return { done: true, success: true, reason: verified.reason, finalUrl: page.url() };
  }
  if (verified.knownFailure) {
    return {
      done: true,
      success: false,
      reason: verified.reason,
      finalUrl: page.url(),
      screenshot: verified.screenshot
    };
  }

  return {
    done: true,
    success: true,
    reason: 'Returned to Manyreach after Microsoft OAuth; sender visibility could not be confirmed',
    finalUrl: page.url()
  };
}

async function verifySenderVisible(page, item, opts) {
  const url = new URL(opts.sendersUrl || 'https://app.manyreach.com/e/senders');
  url.searchParams.set('service', '');
  url.searchParams.set('warmup', '');
  url.searchParams.set('folder', '');
  url.searchParams.set('tag', '');
  url.searchParams.set('sender', '-1');
  url.searchParams.set('status', '');
  url.searchParams.set('search', item.email);
  url.searchParams.set('provider', '');
  url.searchParams.set('trackingDomain', '');
  url.searchParams.set('o', '15308');
  url.searchParams.set('servicetype', 'all');
  url.searchParams.set('org', '15308');

  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const lower = (await bodyText(page)).toLowerCase();
    if (lower.includes(item.email)) {
      return { success: true, reason: 'Sender visible in Manyreach sender search' };
    }
    if (/sign in|login|log in/.test(lower)) {
      const screenshot = await saveScreenshot(page, item.email, 'verify-login', opts);
      return {
        success: false,
        knownFailure: true,
        reason: 'Manyreach sender search redirected to login; refresh cookies',
        screenshot
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
}

async function handleAccountPicker(page) {
  if (await clickSelector(page, '#otherTile')) return true;
  return clickVisibleByText(page, [
    'use another account',
    'sign in with another account',
    'add account',
    'another account'
  ]);
}

async function handleConsent(page) {
  const lower = (await bodyText(page)).toLowerCase();
  const looksLikeConsent =
    lower.includes('permissions requested') ||
    lower.includes('requested permissions') ||
    lower.includes('accept permissions') ||
    lower.includes('wants to access') ||
    lower.includes('manyreach');

  if (!looksLikeConsent) return false;

  return clickVisibleByText(page, ['accept', 'yes', 'continue', 'allow']);
}

async function handleStaySignedIn(page, opts) {
  const lower = (await bodyText(page)).toLowerCase();
  if (!lower.includes('stay signed in')) return false;
  if (opts.staySignedIn) {
    if (await clickSelector(page, '#idSIButton9')) return true;
    if (await clickVisibleByText(page, ['yes'])) return true;
  }
  if (await clickSelector(page, '#idBtn_Back')) return true;
  if (await clickVisibleByText(page, ['no'])) return true;
  if (await clickSelector(page, '#idSIButton9')) return true;
  return clickVisibleByText(page, ['yes']);
}

async function handleSecurityPrompt(page) {
  const lower = (await bodyText(page)).toLowerCase();
  const isSecurityPrompt =
    lower.includes('more information required') ||
    lower.includes('protect your account') ||
    lower.includes('help us protect') ||
    lower.includes('microsoft authenticator') ||
    lower.includes('action required') ||
    lower.includes('security defaults');

  if (!isSecurityPrompt) return false;
  return clickVisibleByText(page, [
    'skip for now',
    'ask later',
    'not now',
    'skip setup',
    'skip',
    'i want to set up a different method',
    'use a different method',
    'next',
    'continue'
  ]);
}

async function handleGenericContinue(page) {
  const lower = (await bodyText(page)).toLowerCase();
  if (
    lower.includes('review permissions') ||
    lower.includes('terms of use') ||
    lower.includes('let this app access') ||
    lower.includes('are you trying to sign in')
  ) {
    return clickVisibleByText(page, ['accept', 'continue', 'next', 'yes', 'allow']);
  }
  return false;
}

function requiresManualInput(lower) {
  return (
    lower.includes('enter the code') ||
    lower.includes('verification code') ||
    lower.includes('approve sign in request') ||
    lower.includes('approve a request') ||
    lower.includes('scan the qr code') ||
    lower.includes('use your authenticator app') ||
    lower.includes('enter a code from your authenticator')
  );
}

function detectMicrosoftError(lower) {
  const aadsts = lower.match(/aadsts\d{4,}/i);
  if (aadsts) return `Microsoft OAuth error: ${aadsts[0]}`;
  if (lower.includes('your account or password is incorrect')) return 'Microsoft rejected the mailbox password';
  if (lower.includes('this username may be incorrect')) return 'Microsoft rejected the mailbox email';
  if (lower.includes('your account has been locked')) return 'Microsoft account locked';
  if (lower.includes('sign-in is blocked')) return 'Microsoft sign-in is blocked';
  if (lower.includes('you cannot access this right now')) return 'Microsoft conditional access blocked sign-in';
  if (lower.includes('needs admin approval')) return 'Microsoft says this app needs admin approval';
  if (lower.includes('access_denied')) return 'Microsoft OAuth access denied';
  return null;
}

async function setInputValue(page, handle, value) {
  await handle.click({ clickCount: 3 }).catch(() => null);
  await page.keyboard.press('Backspace').catch(() => null);
  await handle.type(value, { delay: 20 }).catch(() => null);
  await handle.evaluate((el, val) => {
    if (el.value !== val) {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, val);
      else el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const actual = await handle.evaluate(el => el.value || '').catch(() => '');
  if (actual !== value) {
    throw new Error('Failed to set input value on Microsoft login page');
  }
  await sleep(250);
}

async function clickSubmit(page) {
  const selectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    '#idSIButton9',
    'button[data-testid="primaryButton"]'
  ];
  for (const selector of selectors) {
    if (await clickSelector(page, selector)) return true;
  }
  await page.keyboard.press('Enter');
  return true;
}

async function clickSelector(page, selector) {
  const handle = await findVisibleHandle(page, selector);
  if (!handle) return false;
  await handle.click().catch(async () => {
    await handle.evaluate(el => el.click());
  });
  return true;
}

async function findVisibleHandle(page, selector) {
  const frames = [page.mainFrame(), ...page.frames().filter(frame => frame !== page.mainFrame())];
  for (const frame of frames) {
    if (typeof frame.isDetached === 'function' && frame.isDetached()) continue;
    const handles = await frame.$$(selector).catch(error => {
      if (isTransientAutomationError(error.message)) return [];
      throw error;
    });
    for (const handle of handles) {
      const visible = await handle.evaluate(isVisibleElement).catch(() => false);
      if (visible) return handle;
      await handle.dispose().catch(() => null);
    }
  }
  return null;
}

async function clickVisibleByText(page, labels) {
  return page.evaluate((targets) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = targets.map(normalize);
    const candidates = Array.from(document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a, div[role="button"], span[role="button"]'
    ));

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    };

    for (const exact of [true, false]) {
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label'));
        if (!text) continue;
        const matched = wanted.some(label => exact ? text === label : text.includes(label));
        if (matched) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, labels).catch(() => false);
}

function isVisibleElement(el) {
  const rect = el.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

async function waitForStep(page, timeout = 3000) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => null),
    sleep(timeout)
  ]);
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function safeTitle(page) {
  return page.title().catch(() => '');
}

function clipText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    for (const key of ['code', 'id_token', 'access_token', 'refresh_token']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function saveScreenshot(page, email, label, opts) {
  if (!page || page.isClosed()) return null;
  const dir = opts.screenshotDir || DEFAULT_SCREENSHOT_DIR;
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName(email)}_${label}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logVerbose(opts, email, message) {
  if (!opts.verbose) return;
  console.log(`[${email}] ${message}`);
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index, workerIndex + 1);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage().trim());
    return;
  }

  const csvPath = opts.csv || DEFAULT_CSV;
  const stateFile = opts.stateFile || DEFAULT_STATE_FILE;
  const resultsFile = opts.resultsFile || DEFAULT_RESULTS_FILE;
  const oauthUrl = opts.oauthUrl || process.env.MANYREACH_MS_OAUTH_URL || DEFAULT_OAUTH_URL;
  const rows = await readCsv(csvPath);
  const selected = filterMailboxes(rows, opts);

  console.log(`CSV rows: ${rows.length}`);
  console.log(`Selected mailboxes: ${selected.length}`);

  if (opts.dryRun) {
    for (const item of selected.slice(0, 20)) {
      console.log(`${item.email} (${item.provider})`);
    }
    if (selected.length > 20) console.log(`... ${selected.length - 20} more`);
    return;
  }

  const password = opts.password || process.env.MAILBOX_PASSWORD;
  if (!password) {
    throw new Error('Missing mailbox password. Set MAILBOX_PASSWORD or pass --password.');
  }

  const cookies = await loadCookies(opts);
  const state = await loadState(stateFile);
  const pending = selected.filter(item => !shouldSkip(item, state, opts));
  const skipped = selected.length - pending.length;
  const concurrency = Math.max(1, toInt(opts.concurrency, 1, '--concurrency'));

  console.log(`Skipped from state: ${skipped}`);
  console.log(`Pending: ${pending.length}`);
  console.log(`Concurrency: ${concurrency}`);

  if (!pending.length) {
    console.log('Nothing to do.');
    return;
  }

  const browser = await launchBrowser(opts);
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let writeQueue = Promise.resolve();

  const shutdown = async () => {
    await browser.close().catch(() => null);
  };
  process.once('SIGINT', async () => {
    console.log('\nInterrupted. Closing browser...');
    await shutdown();
    process.exit(130);
  });

  try {
    await runPool(pending, concurrency, async (item, index, workerId) => {
      const displayIndex = index + 1;
      console.log(`[${displayIndex}/${pending.length}] [w${workerId}] Connecting ${item.email}`);
      const result = await connectMailbox({
        browser,
        item,
        password,
        cookies,
        oauthUrl,
        opts
      });

      completed += 1;
      if (result.status === 'success') succeeded += 1;
      else failed += 1;

      const writeOperation = writeQueue.then(async () => {
        state.accounts[item.email] = result;
        state.updatedAt = new Date().toISOString();
        await saveState(stateFile, state);
        await appendResult(resultsFile, result);
      });
      writeQueue = writeOperation.catch(() => {});
      await writeOperation;

      const suffix = result.reason ? ` - ${result.reason}` : '';
      console.log(`[${displayIndex}/${pending.length}] ${result.status.toUpperCase()} ${item.email}${suffix}`);
      console.log(`Progress: ${completed}/${pending.length}, success=${succeeded}, failed/manual=${failed}`);
    });
  } finally {
    await shutdown();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
