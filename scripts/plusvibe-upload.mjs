#!/usr/bin/env node
/**
 * PlusVibe bulk account uploader
 *
 * Reads mailbox credentials from production VPS DB and uploads them to
 * PlusVibe via browser automation (SMTP account form).
 *
 * Usage:
 * PLUSVIBE_EMAIL=soumilllllllll7@gmail.com \
 * PLUSVIBE_PASSWORD=speed200ignite \
 * node scripts/plusvibe-upload.mjs [options]
 *
 * Options:
 * --concurrency <n> Parallel accounts per browser. Default: 2
 * --limit <n> Max accounts to process
 * --skip <n> Skip first n accounts
 * --headless Run headless
 * --dry-run Query DB only, no upload
 * --verbose Per-account progress
 * --resume-from <email> Skip accounts up to and including this email
 * --state-file <path> Progress tracking file
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const puppeteerModule = requireFromServerNodeModules('puppeteer-extra/dist/index.cjs.js');
const StealthPluginModule = requireFromServerNodeModules('puppeteer-extra-plugin-stealth/index.js');
const puppeteer = puppeteerModule.default || puppeteerModule;
const StealthPlugin = StealthPluginModule.default || StealthPluginModule;
puppeteer.use(StealthPlugin());

const USER_AGENT =
 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const PLUSVIBE_LOGIN = 'https://app.plusvibe.ai/v2/login/';
const PLUSVIBE_ACCOUNTS = 'https://app.plusvibe.ai/v2/email-accounts/';
const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.office365.com';
const SMTP_PORT = 587;

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
 PLUSVIBE_EMAIL=... PLUSVIBE_PASSWORD=... \\
 node scripts/plusvibe-upload.mjs [options]

Options:
 --concurrency <n> Parallel uploads. Default: 2
 --limit <n> Max accounts
 --skip <n> Skip first n
 --headless Run headless
 --dry-run Query DB only
 --verbose Per-account progress
 --resume-from <email> Skip to this email
 --state-file <path> Progress file. Default: logs/plusvibe-upload/state.json
 --screenshot-dir <path> Screenshots. Default: logs/plusvibe-upload/screenshots
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

const { execSync } = require('child_process');

async function fetchMailboxes() {
 const ssh = [
 'sshpass', '-p', 'speed200ignite', 'ssh',
 '-o', 'StrictHostKeyChecking=no', 'root@62.171.150.14'
 ];
 const db = '/opt/unlimited-inboxes/shared/db/app.db';
 const sql = [
 'SELECT t.domain,',
 ' json_extract(m.value, "$.email") as email,',
 ' json_extract(m.value, "$.password") as password',
 'FROM orders o',
 'JOIN tenants t ON o.tenant_id = t.id,',
 ' json_each(o.created_mailboxes) m',
 "WHERE o.status = 'completed'",
 'ORDER BY o.updated_at DESC, t.domain'
 ].join(' ');

 const sshCmd = 'sshpass -p "speed200ignite" ssh -o StrictHostKeyChecking=no root@62.171.150.14';
 const sqlCmd = 'sqlite3 -json ' + db + ' "' + sql.replace(/"/g, '\\"') + '"';
 const fullCmd = sshCmd + ' "' + sqlCmd.replace(/"/g, '\\"') + '"';
 const result = execSync(fullCmd, {
 encoding: 'utf8',
 maxBuffer: 100 * 1024 * 1024,
 timeout: 180000
 });

 return JSON.parse(result);
}

function extractName(email) {
 const local = String(email || '').split('@')[0];
 const parts = local.split(/[._-]/);
 const first = parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : 'User';
 const last = parts.length > 1 && parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : 'User';
 return { first, last };
}

function safeName(value) {
 return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function sleep(ms) {
 return new Promise(resolve => setTimeout(resolve, ms));
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

/* ─── State management ─── */

async function loadState(filePath) {
 try {
 const data = await fs.readFile(filePath, 'utf8');
 const state = JSON.parse(data);
 if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
 return state;
 } catch {
 return { accounts: {} };
 }
}

async function saveState(filePath, state) {
 await fs.mkdir(path.dirname(filePath), { recursive: true });
 const tmp = `${filePath}.${process.pid}.tmp`;
 await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
 await fs.rename(tmp, filePath);
}

/* ─── Browser helpers ─── */

async function launchBrowser(opts) {
 return puppeteer.launch({
 headless: opts.headless ? 'new' : false,
 defaultViewport: { width: 1920, height: 1080 },
 args: [
 '--no-sandbox',
 '--disable-setuid-sandbox',
 '--disable-blink-features=AutomationControlled',
 '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning',
 '--disable-save-password-bubble',
 '--window-size=1920,1080',
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
 await page.setViewport({ width: 1920, height: 1080 });
 page.setDefaultTimeout;
 page.setDefaultNavigationTimeout;
 return page;
}

async function setInputValue(page, handle, value) {
 await handle.click({ clickCount: 3 }).catch(() => null);
 await page.keyboard.press('Backspace').catch(() => null);
 await handle.type(value, { delay: 15 }).catch(() => null);
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
 throw new Error('Failed to set input value');
 }
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
 if (wanted.some(label => exact ? text === label : text.includes(label))) {
 el.click();
 return true;
 }
 }
 }
 return false;
 }, labels).catch(() => false);
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

async function saveScreenshot(page, email, label, dir) {
 if (!page || page.isClosed()) return null;
 await fs.mkdir(dir, { recursive: true });
 const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName(email)}_${label}.png`);
 await page.screenshot({ path: filePath, fullPage: true }).catch(() => null);
 return filePath;
}

function logVerbose(opts, email, msg) {
 if (!opts.verbose) return;
 console.log(` [${email}] ${msg}`);
}

/* ─── PlusVibe login flow ─── */

async function loginToPlusVibe(page, email, password, screenshotDir) {
 logVerbose({ verbose: true }, email, 'Opening PlusVibe login page');
 await page.goto(PLUSVIBE_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
 await sleep;

 // Check if already logged in
 if (page.url().includes('/v2/') && !page.url().includes('/login')) {
 return { success: true, reason: 'Already logged in' };
 }

 // Fill email
 const emailInput = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 15000 }).catch(() => null);
 if (!emailInput) {
 // Try to find any text input on the page
 const allInputs = await page.$$('input');
 if (allInputs.length === 0) throw new Error('No email input found on PlusVibe login page');
 await setInputValue(page, allInputs[0], email);
 } else {
 await setInputValue(page, emailInput, email);
 }

 await sleep(500);

 // Fill password
 const passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);
 if (!passwordInput) {
 throw new Error('No password input found');
 }
 await setInputValue(page, passwordInput, password);

 await sleep(500);

 // Click sign in
 await clickVisibleByText(page, ['sign in', 'login', 'log in', 'submit']);

 // Wait for navigation
 await waitForStep(page, 10000);

 // Check for errors
 const lower = (await bodyText(page)).toLowerCase();
 if (lower.includes('invalid') || lower.includes('incorrect') || lower.includes('wrong password')) {
 throw new Error('PlusVibe login failed: invalid credentials');
 }

 // Wait for dashboard
 await sleep;
 const finalUrl = page.url();

 if (finalUrl.includes('/login') || finalUrl.includes('/signin')) {
 throw new Error('PlusVibe login failed: still on login page');
 }

 return { success: true, reason: 'Logged in', finalUrl };
}

/* ─── PlusVibe add account flow ─── */

async function addAccountToPlusVibe(page, account, opts) {
 const { email, password } = account;
 const { first, last } = extractName(email);
 const screenshotDir = opts.screenshotDir || 'logs/plusvibe-upload/screenshots';
 const startedAt = new Date().toISOString();

 logVerbose(opts, email, 'Navigating to email accounts page');
 await page.goto(PLUSVIBE_ACCOUNTS, { waitUntil: 'domcontentloaded', timeout: 60000 });
 await sleep;

 // Check if account already exists
 const pageText = (await bodyText(page)).toLowerCase();
 if (pageText.includes(email) && !pageText.includes('add') && !pageText.includes('connect')) {
 return { success: true, status: 'skipped', reason: 'Account already exists', startedAt, finishedAt: new Date().toISOString() };
 }

 // Click "Add New Account" or similar
 logVerbose(opts, email, 'Clicking add account button');
 const clicked = await clickVisibleByText(page, [
 'add new account', 'add account', 'connect account', 'add email',
 'new account', 'connect email', 'add'
 ]);

 if (!clicked) {
 // Try finding a button with add icon or specific selector
 const addBtn = await page.$('button:has-text("Add"), a:has-text("Add"), [data-testid*="add"], .add-account, button[aria-label*="add" i]').catch(() => null);
 if (!addBtn) {
 const screenshot = await saveScreenshot(page, email, 'no-add-btn', screenshotDir);
 return { success: false, status: 'failed', reason: 'Could not find Add Account button', screenshot, startedAt, finishedAt: new Date().toISOString() };
 }
 await addBtn.click().catch(() => null);
 }

 await sleep;

 // Choose SMTP provider (not Google/Microsoft OAuth)
 logVerbose(opts, email, 'Selecting SMTP provider');
 const smtpClicked = await clickVisibleByText(page, [
 'smtp', 'custom smtp', 'other smtp', 'any smtp', 'custom',
 'other provider'
 ]);

 if (!smtpClicked) {
 // Look for provider selection buttons
 const providerBtns = await page.$$('button, .provider-option, [role="button"]');
 if (providerBtns.length > 0) {
 // Usually the last/other option is SMTP
 await providerBtns[providerBtns.length - 1].click().catch(() => null);
 }
 }

 await sleep;

 // Fill in SMTP form
 logVerbose(opts, email, 'Filling SMTP credentials');

 // First name
 const firstNameInput = await page.$('input[name="first_name"], input[placeholder*="first name" i], input[id*="first" i]').catch(() => null);
 if (firstNameInput) {
 await setInputValue(page, firstNameInput, first);
 }

 // Last name
 const lastNameInput = await page.$('input[name="last_name"], input[placeholder*="last name" i], input[id*="last" i]').catch(() => null);
 if (lastNameInput) {
 await setInputValue(page, lastNameInput, last);
 }

 // Email
 const emailInput = await page.$('input[name="email"], input[type="email"], input[placeholder*="email" i]').catch(() => null);
 if (emailInput) {
 await setInputValue(page, emailInput, email);
 }

 // Username (often same as email)
 const usernameInput = await page.$('input[name="username"], input[placeholder*="username" i], input[id*="username"]').catch(() => null);
 if (usernameInput) {
 await setInputValue(page, usernameInput, email);
 }

 // Password
 const pwInput = await page.$('input[name="password"], input[type="password"], input[placeholder*="password" i]').catch(() => null);
 if (!pwInput) {
 const screenshot = await saveScreenshot(page, email, 'no-password-field', screenshotDir);
 return { success: false, status: 'failed', reason: 'No password field found in SMTP form', screenshot, startedAt, finishedAt: new Date().toISOString() };
 }
 await setInputValue(page, pwInput, password);

 // IMAP host
 const imapHost = await page.$('input[name="imap_host"], input[placeholder*="imap" i]').catch(() => null);
 if (imapHost) {
 await setInputValue(page, imapHost, IMAP_HOST);
 }

 // IMAP port
 const imapPort = await page.$('input[name="imap_port"], input[placeholder*="993" i]').catch(() => null);
 if (imapPort) {
 await setInputValue(page, imapPort, String(IMAP_PORT));
 }

 // SMTP host
 const smtpHost = await page.$('input[name="smtp_host"], input[placeholder*="smtp" i]').catch(() => null);
 if (smtpHost) {
 await setInputValue(page, smtpHost, SMTP_HOST);
 }

 // SMTP port
 const smtpPort = await page.$('input[name="smtp_port"], input[placeholder*="587" i]').catch(() => null);
 if (smtpPort) {
 await setInputValue(page, smtpPort, String(SMTP_PORT));
 }

 // SMTP username
 const smtpUser = await page.$('input[name="smtp_username"], input[id*="smtp-user"]').catch(() => null);
 if (smtpUser) {
 await setInputValue(page, smtpUser, email);
 }

 // SMTP password
 const smtpPw = await page.$('input[name="smtp_password"], input[id*="smtp-pass"]').catch(() => null);
 if (smtpPw) {
 await setInputValue(page, smtpPw, password);
 }

 await sleep;

 // Submit the form
 logVerbose(opts, email, 'Submitting account form');
 const submitted = await clickVisibleByText(page, [
 'connect', 'add account', 'save', 'submit', 'done', 'continue', 'verify'
 ]);

 if (!submitted) {
 const submitBtn = await page.$('button[type="submit"], input[type="submit"]').catch(() => null);
 if (submitBtn) {
 await submitBtn.click().catch(() => null);
 } else {
 const screenshot = await saveScreenshot(page, email, 'no-submit-btn', screenshotDir);
 return { success: false, status: 'failed', reason: 'Could not find submit button', screenshot, startedAt, finishedAt: new Date().toISOString() };
 }
 }

 // Wait for result
 await sleep;

 // Check for success/error messages
 const afterText = (await bodyText(page)).toLowerCase();
 const screenshot = await saveScreenshot(page, email, 'result', screenshotDir);

 if (afterText.includes('success') || afterText.includes('connected') || afterText.includes('added')) {
 return { success: true, status: 'success', reason: 'Account added', screenshot, startedAt, finishedAt: new Date().toISOString() };
 }

 if (afterText.includes('error') || afterText.includes('failed') || afterText.includes('invalid')) {
 const reason = afterText.includes('authentication')
 ? 'SMTP authentication failed'
 : afterText.includes('connection')
 ? 'Connection failed'
 : 'Unknown error';
 return { success: false, status: 'failed', reason, screenshot, startedAt, finishedAt: new Date().toISOString() };
 }

 // Ambiguous - assume success if we're not on the form anymore
 const currentUrl = page.url();
 if (!currentUrl.includes('add') && !currentUrl.includes('new') && !currentUrl.includes('connect')) {
 return { success: true, status: 'success', reason: 'Form submitted (assumed success)', screenshot, startedAt, finishedAt: new Date().toISOString() };
 }

 return { success: false, status: 'manual', reason: 'Unclear result - manual check needed', screenshot, startedAt, finishedAt: new Date().toISOString() };
}

/* ─── Main ─── */

import fs from 'fs/promises';

async function main() {
 const opts = parseArgs(process.argv.slice(2));
 if (opts.help) {
 console.log(usage().trim());
 return;
 }

 const plusvibeEmail = process.env.PLUSVIBE_EMAIL;
 const plusvibePassword = process.env.PLUSVIBE_PASSWORD;
 if (!plusvibeEmail || !plusvibePassword) {
 if (!opts.dryRun) {
 console.error('Set PLUSVIBE_EMAIL and PLUSVIBE_PASSWORD environment variables.');
 process.exit(1);
 }
 }

 console.log('Fetching mailboxes from production VPS...');
 const mailboxes = await fetchMailboxes();
 console.log(`Fetched ${mailboxes.length} mailboxes from VPS`);

 if (opts.dryRun) {
 console.log('Dry run - first 10 mailboxes:');
 for (const m of mailboxes.slice(0, 10)) {
 console.log(` ${m.email} (${m.domain})`);
 }
 console.log(`... ${mailboxes.length} total`);
 return;
 }

 // Filter
 let items = mailboxes.filter(m => m.email && m.password);
 const skip = toInt(opts.skip, 0, '--skip');
 const limit = toInt(opts.limit, null, '--limit');
 if (skip) items = items.slice(skip);
 if (limit !== null) items = items.slice(0, limit);

 // Resume from
 if (opts.resumeFrom) {
 const target = opts.resumeFrom.toLowerCase();
 const idx = items.findIndex(m => m.email.toLowerCase() === target);
 if (idx >= 0) items = items.slice(idx + 1);
 }

 console.log(`Processing ${items.length} mailboxes`);

 const stateFile = opts.stateFile || 'logs/plusvibe-upload/state.json';
 const screenshotDir = opts.screenshotDir || 'logs/plusvibe-upload/screenshots';
 const state = await loadState(stateFile);
 const concurrency = Math.max(1, toInt(opts.concurrency, 2, '--concurrency'));

 // Filter out already completed
 const pending = items.filter(m => {
 const prev = state.accounts[m.email];
 return !prev || prev.status !== 'success';
 });
 const skipped = items.length - pending.length;
 console.log(`Skipped (already done): ${skipped}`);
 console.log(`Pending: ${pending.length}, concurrency: ${concurrency}`);

 if (!pending.length) {
 console.log('Nothing to do!');
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

 const resultsFile = stateFile.replace('state.json', 'results.ndjson');

 try {
 const cursor = { value: 0 };
 const workers = Array.from({ length: concurrency }, async (_, workerId) => {
 while (cursor.value < pending.length) {
 const index = cursor.value;
 cursor.value += 1;
 const item = pending[index];
 const displayIndex = index + 1;

 console.log(`[${displayIndex}/${pending.length}] [w${workerId}] Uploading ${item.email} (${item.domain})`);

 let result;
 try {
 result = await uploadOne(browser, item, plusvibeEmail, plusvibePassword, { ...opts, screenshotDir });
 } catch (error) {
 result = {
 success: false,
 status: 'failed',
 reason: error.message,
 startedAt: new Date().toISOString(),
 finishedAt: new Date().toISOString()
 };
 }

 completed += 1;
 if (result.status === 'success' || result.status === 'skipped') succeeded += 1;
 else failed += 1;

 const writeOp = writeQueue.then(async () => {
 state.accounts[item.email] = result;
 state.updatedAt = new Date().toISOString();
 await saveState(stateFile, state);
 try {
 await fs.mkdir(path.dirname(resultsFile), { recursive: true });
 await fs.appendFile(resultsFile, `${JSON.stringify({ ...result, domain: item.domain })}\n`);
 } catch { /* ignore results file errors */ }
 });
 writeQueue = writeOp.catch(() => {});
 await writeOp;

 const suffix = result.reason ? ` - ${result.reason}` : '';
 console.log(`[${displayIndex}/${pending.length}] ${(result.status || 'unknown').toUpperCase()} ${item.email}${suffix}`);
 console.log(` Progress: ${completed}/${pending.length} | success=${succeeded} | failed/manual=${failed}`);

 // Rate limit: PlusVibe allows 5 req/sec, be conservative
 await sleep;
 }
 });

 await Promise.all(workers);
 } finally {
 await shutdown();
 }

 console.log('\n=== DONE ===');
 console.log(`Total: ${completed} | Success: ${succeeded} | Failed/Manual: ${failed}`);
}

async function uploadOne(browser, item, loginEmail, loginPassword, opts) {
 const context = await newContext(browser);
 let page = await newPreparedPage(context);
 const screenshotDir = opts.screenshotDir || 'logs/plusvibe-upload/screenshots';
 const accountTimeoutMs = 180000;

 let timedOut = false;
 let timer = null;

 const runPromise = (async () => {
 logVerbose(opts, item.email, 'Logging into PlusVibe');
 const loginResult = await loginToPlusVibe(page, loginEmail, loginPassword, screenshotDir);
 if (!loginResult.success) {
 return { success: false, status: 'failed', reason: `Login failed: ${loginResult.reason}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
 }

 logVerbose(opts, item.email, 'Adding account via SMTP form');
 const addResult = await addAccountToPlusVibe(page, item, opts);
 return addResult;
 })().catch(async (error) => {
 const screenshot = await saveScreenshot(page, item.email, 'error', screenshotDir);
 return { success: false, status: 'failed', reason: error.message, screenshot, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
 });

 const timeoutPromise = new Promise(resolve => {
 timer = setTimeout(async () => {
 timedOut = true;
 const screenshot = await saveScreenshot(page, item.email, 'timeout', screenshotDir);
 await context.close().catch(() => null);
 resolve({
 success: false,
 status: 'manual',
 reason: `Timed out after ${accountTimeoutMs}ms`,
 screenshot,
 startedAt: new Date().toISOString(),
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

main().catch(error => {
 console.error('Fatal error:', error.message);
 process.exit(1);
});
