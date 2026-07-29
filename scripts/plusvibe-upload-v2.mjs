#!/usr/bin/env node

import fs from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const puppeteerModule = requireFromServerNodeModules('puppeteer-extra/dist/index.cjs.js');
const StealthPluginModule = requireFromServerNodeModules('puppeteer-extra-plugin-stealth/index.js');
const puppeteer = puppeteerModule.default || puppeteerModule;
const StealthPlugin = StealthPluginModule.default || StealthPluginModule;
puppeteer.use(StealthPlugin());

const PLUSVIBE_LOGIN = 'https://app.plusvibe.ai/v2/login/';
const PLUSVIBE_ACCOUNTS = 'https://app.plusvibe.ai/v2/email-accounts/';
const MS_OAUTH_CLIENT_ID = '368718a1-7c23-4364-b891-92fca0af0e88';
const MS_OAUTH_REDIRECT_URI = 'https://app.plusvibe.ai/v2/microsoft-oauth-callback/';
const MS_OAUTH_SCOPE = 'Mail.ReadWrite IMAP.AccessAsUser.All SMTP.Send offline_access profile email openid';
const MS_OAUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

const VPS_HOST = '62.171.150.14';
const VPS_USER = 'root';
const VPS_PASS = 'speed200ignite';
const VPS_DB = '/opt/unlimited-inboxes/shared/db/app.db';

const DEFAULT_STATE_FILE = 'logs/plusvibe-upload/state.json';
const DEFAULT_RESULTS_FILE = 'logs/plusvibe-upload/results.ndjson';
const DEFAULT_SCREENSHOT_DIR = 'logs/plusvibe-upload/screenshots';

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
 return `Usage:
PLUSVIBE_EMAIL=you@gmail.com \\
PLUSVIBE_PASSWORD=yourpass \\
node scripts/plusvibe-upload-v2.mjs [options]

Options:
 --limit <n> Max accounts. Default: all
 --skip <n> Skip first n accounts.
 --concurrency <n> Parallel workers. Default: 2
 --headless Run Chromium headless.
 --dry-run Query DB only; no browser needed.
 --verbose Print per-account progress.
 --resume-from <email> Skip to this email.
 --state-file <path> Resume state file. Default: logs/plusvibe-upload/state.json
 --results-file <path> Results NDJSON. Default: logs/plusvibe-upload/results.ndjson
 --screenshot-dir <path> Screenshots. Default: logs/plusvibe-upload/screenshots
 --account-timeout-ms <n> Hard timeout per mailbox. Default: 180000.
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
 throw new Error(`${name} must be a non-negative integer, got ${value}`);
 }
 return n;
}

function log(message) {
 console.log(`[${new Date().toISOString()}] ${message}`);
}

function logVerbose(message) {
 if (global.__pvVerbose) log(`VERBOSE ${message}`);
}

async function loadState(filePath) {
 try {
 const raw = await fs.readFile(filePath, 'utf-8');
 const parsed = JSON.parse(raw);
 return {
 progress: parsed.progress || { lastProcessedIndex: -1 },
 results: Array.isArray(parsed.results) ? parsed.results : [],
 };
 } catch {
 return { progress: { lastProcessedIndex: -1 }, results: [] };
 }
}

async function saveState(filePath, state) {
 await fs.mkdir(path.dirname(filePath), { recursive: true });
 const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
 await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
 await fs.rename(tmp, filePath);
}

function safeName(value) {
 return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function timestamp() {
 return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function saveScreenshot(dir, label, pageOrBrowser, extra) {
 try {
 await fs.mkdir(dir, { recursive: true });
 const ts = timestamp();
 const name = `${ts}_${safeName(label)}${extra ? '_' + safeName(extra) : ''}.png`;
 const full = path.join(dir, name);
 if (typeof pageOrBrowser?.screenshot === 'function') {
 await pageOrBrowser.screenshot({ path: full });
 } else if (pageOrBrowser?.pages && pageOrBrowser.pages().then) {
 const pages = await pageOrBrowser.pages();
 for (const p of pages) {
 if (p.isClosed()) continue;
 await p.screenshot({ path: full });
 break;
 }
 }
 return full;
 } catch (err) {
 logVerbose(`screenshot failed: ${err.message}`);
 return null;
 }
}

async function sleep(ms = 800) {
 return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms) {
 return Promise.race([
 promise,
 new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
 ]);
}

async function bodyText(page) {
 return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function safeTitle(page) {
 return page.title().catch(() => '');
}

async function setInputValue(page, selector, value) {
 await page.waitForSelector(selector, { visible: true, timeout: 5000 }).catch(() => {});
 await page.$eval(selector, (el, val) => {
 el.focus();
 el.value = val;
 el.dispatchEvent(new Event('input', { bubbles: true }));
 el.dispatchEvent(new Event('change', { bubbles: true }));
 }, value);
}

async function clickSubmit(page, afterSelector) {
 const submitSel = "input[type='submit'], button[type='submit']";
 const candidate = (await page.$(submitSel)) || (await page.$(afterSelector));
 if (candidate) {
 await candidate.click();
 } else {
 await page.keyboard.press('Enter');
 }
}

async function clickSelector(page, selector) {
 const el = await page.$(selector);
 if (!el) throw new Error(`selector not found: ${selector}`);
 await el.click();
 return el;
}

async function clickVisibleByText(page, text, tag) {
 const tagSel = tag || '*';
 const matched = await page.$$(tagSel).then((els) => els.filter(async (el) => {
 const txt = await page.evaluate((n) => n.textContent, el);
 return txt && txt.includes(text);
 }));
 if (matched.length === 0) throw new Error(`text not found: ${text}`);
 await matched[0].click();
}

async function isVisibleElement(page, selector) {
 const el = await page.$(selector);
 if (!el) return false;
 try {
 return await el.isIntersectingViewport();
 } catch {
 return true;
 }
}

function detectMicrosoftError(body) {
 return /Something went wrong|We couldn't complete|invalid_grant|AADSTS/.test(body);
}

function isTransientAutomationError(url) {
 return /proof-x|challenge|suspicious-activity|risk/.test(url);
}

function scorePageUrl(page) {
 const href = page.url() || '';
 try {
 if (href.includes('app.plusvibe.ai')) return 100;
 if (/login\.microsoftonline\.com/.test(href)) return 50;
 if (/microsoft\.com|live\.com|outlook\.office\.com/.test(href)) return 30;
 return 0;
 } catch {
 return 0;
 }
}

async function handleAccountPicker(page, mailbox) {
 const url = page.url();
 const text = await bodyText(page).catch(() => '') || '';

 if (/pickanaccount|login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/.test(url) ||
 text.includes('Pick an account') ||
 text.includes('Email or phone')) {
 logVerbose('OAuth step: account picker');
 const emailSel = "input[type='email'], input[name='loginfmt'], input#i0116";
 if (await isVisibleElement(page, emailSel)) {
 await setInputValue(page, emailSel, mailbox.email);
 await clickSubmit(page, emailSel);
 await sleep;
 }
 return 'oauth';
 }

 if (/login\.microsoftonline\.com/.test(url)) {
 const emailSel = "input[type='email'], input[name='loginfmt'], input#i0116";
 if (await isVisibleElement(page, emailSel)) {
 await setInputValue(page, emailSel, mailbox.email);
 await clickSubmit(page, emailSel);
 await sleep;
 }
 return 'oauth';
 }

 return 'oauth';
}

async function handleStaySignedIn(page) {
 const text = await bodyText(page).catch(() => '') || '';
 if (/Stay signed in|Don't show this again/i.test(text)) {
 logVerbose('OAuth step: stay signed in');
 const noBtn = "input[value='No'], input#idBtn_Back";
 if (await isVisibleElement(page, noBtn)) {
 await clickSelector(page, noBtn);
 } else {
 await clickVisibleByText(page, 'No', 'button');
 }
 await sleep;
 }
 return 'oauth';
}

async function handleSecurityPrompt(page) {
 const text = await bodyText(page).catch(() => '') || '';
 if (/Use a different way to sign in|We need to verify|security info/i.test(text)) {
 logVerbose('OAuth step: security prompt (skipping)');
 return 'skipped';
 }
 return 'oauth';
}

async function handleGenericContinue(page) {
 const text = await bodyText(page).catch(() => '') || '';
 if (/Accept|Continue|Agree|Next/i.test(text) && !/permission|consent/i.test(text)) {
 logVerbose('OAuth step: generic continue');
 const btnSel = "button:has-text('Accept'), button:has-text('Continue'), button:has-text('Yes')";
 if (await isVisibleElement(page, btnSel)) {
 await clickSelector(page, btnSel);
 } else {
 await clickVisibleByText(page, 'Accept', 'button');
 }
 await sleep;
 }
 return 'oauth';
}

async function handleConsent(page, appName) {
 const text = await bodyText(page).catch(() => '') || '';
 const url = page.url();

 if (/permissions|consent|would like to|requests permission/i.test(text) ||
 url.includes('/consent')) {
 logVerbose(`OAuth step: consent for ${appName}`);
 const acceptSel = "button:has-text('Accept'), input[value='Yes'], input#idBtn_Accept";
 if (await isVisibleElement(page, acceptSel)) {
 await clickSelector(page, acceptSel);
 } else {
 await clickVisibleByText(page, 'Accept', 'button');
 }
 await sleep;
 return 'oauth';
 }

 if (appName === 'plusvibe' || text.includes('plusvibe')) {
 logVerbose('Consent pre-approved or not shown for plusvibe');
 return 'done';
 }

 return 'oauth';
}

async function waitForMicrosoftOAuth(mainPage, timeoutMs = 20000) {
 try {
 const currentUrl = mainPage.url();
 if (/login\.microsoftonline\.com|login\.microsoft\.com/.test(currentUrl)) {
 return mainPage;
 }
 } catch {}

 await mainPage.waitForFunction(
 () => window.location.hostname.includes('microsoftonline.com') || window.location.hostname.includes('login.microsoft.com'),
 { timeout: timeoutMs }
 ).catch(() => {});

 const url = mainPage.url();
 if (/login\.microsoftonline\.com|login\.microsoft\.com/.test(url)) {
 return mainPage;
 }

 throw new Error('Microsoft OAuth page not detected within ' + timeoutMs + 'ms');
}

async function waitForMicrosoftOAuthPopUp(context, timeoutMs = 20000) {
 let popupPage = null;
 const popupPromise = new Promise((resolve) => {
 context.once('targetcreated', async (target) => {
 if (/login\.microsoftonline\.com/.test(target.url())) {
 popupPage = await target.page();
 resolve(popupPage);
 }
 });
 });
 const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
 await Promise.race([popupPromise, timeoutPromise]);
 return popupPage;
}

async function launchBrowser(opts) {
 const browser = await puppeteer.launch({
 headless: opts.headless ? 'new' : false,
 defaultViewport: { width: 1440, height: 1000 },
 args: [
 '--no-sandbox',
 '--disable-setuid-sandbox',
 '--disable-blink-features=AutomationControlled',
 '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning,PasswordManagerOnboarding,PasswordManagerRedesign',
 '--disable-save-password-bubble',
 '--window-size=1440,1000',
 '--mute-audio',
 ],
 ignoreDefaultArgs: ['--enable-automation'],
 });
 return browser;
}

async function ensureContext(browser) {
 if (typeof browser.createBrowserContext === 'function') {
 return browser.createBrowserContext();
 }
 if (typeof browser.createIncognitoBrowserContext === 'function') {
 return browser.createIncognitoBrowserContext();
 }
 throw new Error('Puppeteer has no createBrowserContext method');
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

async function fetchMailboxes() {
 const sql = "SELECT json_extract(m.value, '$.email') as email, json_extract(m.value, '$.password') as password, o.mailbox_password as default_password, o.id as order_id FROM orders o, json_each(o.created_mailboxes) m WHERE o.status = 'completed' AND json_array_length(o.created_mailboxes) > 0";

 // sqlite3 emits a benign stderr warning but stdout is valid JSON.
 // Use 2>/dev/null on the REMOTE side and catch non-zero exit.
 log('Fetching mailboxes from VPS DB...');
 const remoteCmd = `sshpass -p ${VPS_PASS} ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ConnectTimeout=15 ${VPS_USER}@${VPS_HOST} 'sqlite3 -json ${VPS_DB} 2>/dev/null'`;

 let raw = '';
 try {
 raw = execSync(remoteCmd, {
 encoding: 'utf-8',
 maxBuffer: 50 * 1024 * 1024,
 input: sql + '\n',
 });
 } catch (err) {
 raw = err.stdout || '';
 if (!raw.trim()) {
 throw new Error('SSH/DB fetch failed: ' + (err.stderr || err.message));
 }
 }

 if (!raw.trim()) return [];

 try {
 const rows = JSON.parse(raw);
 return rows.map(r => ({
 id: String(r.order_id || 0) + '-' + String(r.email || '').split('@')[0],
 email: r.email || '',
 password: r.password || r.default_password || '',
 imapHost: 'outlook.office365.com',
 imapPort: '993',
 })).filter(a => a.email.includes('@'));
 } catch (parseErr) {
 logVerbose(`sqlite3 parse failed: ${parseErr.message}, output starts: ${raw.slice(0, 500)}`);
 throw new Error('Failed to parse DB results: ' + parseErr.message);
 }
}

async function loginToPlusVibe(page) {
 const email = process.env.PLUSVIBE_EMAIL;
 const password = process.env.PLUSVIBE_PASSWORD;
 if (!email || !password) throw new Error("PLUSVIBE_EMAIL and PLUSVIBE_PASSWORD env vars required");

 log('Logging into PlusVibe...');
 await page.goto(PLUSVIBE_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
 await sleep;
 await saveScreenshot(DEFAULT_SCREENSHOT_DIR, 'login-page', page);
 log(`Login page URL: ${page.url()}, title: ${await page.title()}`);

 // Email step
 const emailSel = "input[type='email'], input[name='email'], input#email, input[autocomplete='username'], input[name='username']";
 if (await page.$(emailSel)) {
 await setInputValue(page, emailSel, email);
 await saveScreenshot(DEFAULT_SCREENSHOT_DIR, 'login-email-filled', page);
 await sleep;
 const submitBtn = await page.$("button[type='submit'], input[type='submit'], button:has-text('Sign in'), button:has-text('Login'), button:has-text('Continue')");
 if (submitBtn) { await submitBtn.click(); } else { await page.keyboard.press('Enter'); }
 await sleep;
 } else {
 log('WARNING: No email input found on login page');
 }

 log(`After email step URL: ${page.url()}`);
 await saveScreenshot(DEFAULT_SCREENSHOT_DIR, 'login-after-email', page);

 // Password step
 const passSel = "input[type='password'], input[name='password'], input#password, input[autocomplete='current-password']";
 if (await page.$(passSel)) {
 await setInputValue(page, passSel, password);
 await saveScreenshot(DEFAULT_SCREENSHOT_DIR, 'login-password-filled', page);
 await sleep;
 const submitBtn = await page.$("button[type='submit'], input[type='submit'], button:has-text('Sign in'), button:has-text('Login')");
 if (submitBtn) { await submitBtn.click(); } else { await page.keyboard.press('Enter'); }
 await sleep;
 } else {
 log('WARNING: No password input found on login page');
 }

 log(`After password step URL: ${page.url()}`);
 await saveScreenshot(DEFAULT_SCREENSHOT_DIR, 'login-final', page);

 const finalUrl = page.url();
 log(`After login URL: ${finalUrl}`);
 if (finalUrl.includes('/login') && !finalUrl.includes('email-accounts')) {
 // Try navigating to accounts page to verify we're logged in
 try {
 await page.goto(PLUSVIBE_ACCOUNTS, { waitUntil: 'domcontentloaded', timeout: 10000 });
 await sleep;
 log(`After nav to accounts: ${page.url()}`);
 if (page.url().includes('/login')) {
 throw new Error('Login failed - redirected back to login page');
 }
 } catch (navErr) {
 if (navErr.message.includes('Login failed')) throw navErr;
 log(`Login verification: ${navErr.message}`);
 }
 }

 log('Logged into PlusVibe');
 const cookies = await page.context().cookies();
 return cookies;
}

async function driveMicrosoftOAuth(mailbox, context, workerPage, screenshotDir) {
 const msPage = await context.newPage();

 const oauthUrl = `${MS_OAUTH_BASE}?client_id=${MS_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(MS_OAUTH_REDIRECT_URI)}&response_type=code&response_mode=query&scope=${encodeURIComponent(MS_OAUTH_SCOPE)}`;

 logVerbose('Navigating to PlusVibe accounts page...');
 await workerPage.goto(PLUSVIBE_ACCOUNTS, { waitUntil: 'networkidle2', timeout: 60000 });
 await sleep;

 const connectBtnSel = "text=Connect account, text=Add account, text=Add Microsoft, text=Connect Microsoft";
 if (await isVisibleElement(workerPage, connectBtnSel)) {
 try {
 await clickVisibleByText(workerPage, 'Connect account');
 } catch {
 try { await clickVisibleByText(workerPage, 'Add Microsoft'); } catch {}
 }
 await sleep;
 }

 let msPage2 = null;
 try {
 msPage2 = await waitForMicrosoftOAuth(workerPage, 30000);
 } catch (e) {
 logVerbose(`In-page OAuth not detected, trying popup: ${e.message}`);
 msPage2 = await waitForMicrosoftOAuthPopUp(context, 15000);
 }

 if (!msPage2) throw new Error('Could not detect Microsoft OAuth page');

 logVerbose(`OAuth page URL: ${msPage2.url()}`);

 let state = 'oauth';
 state = await handleAccountPicker(msPage2, mailbox);
 if (state === 'oauth') state = await handleStaySignedIn(msPage2);
 if (state === 'oauth') state = await handleSecurityPrompt(msPage2);
 if (state === 'oauth') state = await handleGenericContinue(msPage2);
 if (state === 'oauth') state = await handleConsent(msPage2, 'plusvibe');

 if (state === 'oauth') {
 const finalUrl = msPage2.url();
 if (/plusvibe\.ai.*code=|code=.*plusvibe/.test(finalUrl)) {
 logVerbose('OAuth redirect with code detected');
 state = 'done';
 } else {
 saveScreenshot(screenshotDir, 'oauth-final-' + safeName(mailbox.email), msPage2, 'final');
 throw new Error(`OAuth did not complete. state=${state}, url=${finalUrl}`);
 }
 }

 if (state !== 'done') {
 const finalUrl = msPage2.url();
 saveScreenshot(screenshotDir, 'oauth-final-' + safeName(mailbox.email), msPage2, 'final');
 throw new Error(`OAuth did not complete. state=${state}, url=${finalUrl}`);
 }

 logVerbose('Microsoft OAuth completed');
 return msPage2;
}

async function processAccount(browser, sessionCookies, mailbox, verbose, screenshotDir, accountTimeoutMs) {
 const context = await ensureContext(browser);
 const workerPage = await context.newPage();

 try {
 await workerPage.setCookie(...sessionCookies).catch(() => {});

 await withTimeout(
 driveMicrosoftOAuth(mailbox, context, workerPage, screenshotDir),
 accountTimeoutMs
 );
 await saveScreenshot(screenshotDir, 'oauth-done-' + safeName(mailbox.email), workerPage);
 log(`OAuth complete for ${mailbox.email}`);
 return { email: mailbox.email, status: 'added', method: 'microsoft-oauth' };
 } catch (err) {
 await saveScreenshot(screenshotDir, 'oauth-error-' + safeName(mailbox.email), workerPage);
 log(`OAuth error for ${mailbox.email}: ${err.message}`);
 return { email: mailbox.email, status: 'error', reason: 'oauth_failed', detail: err.message };
 }
}

function summarizeResults(results) {
 const added = results.filter((r) => r.status === 'added').length;
 const failed = results.filter((r) => r.status !== 'added').length;
 return {
 added,
 failed,
 summary: `Results: ${added} added, ${failed} failed out of ${results.length} processed`,
 };
}

async function main() {
 process.on('uncaughtException', (err) => {
 console.error('FATAL uncaughtException:', err);
 process.exit(1);
 });
 process.on('unhandledRejection', (err) => {
 console.error('FATAL unhandledRejection:', err);
 process.exit(1);
 });

 const argv = parseArgs(process.argv.slice(2));
 const startTime = Date.now();
 global.__pvVerbose = Boolean(argv.verbose);
 const verbose = global.__pvVerbose;
 const dryRun = argv.dryRun;
 const limit = argv.limit ? Math.max(1, Number(argv.limit)) : Infinity;
 const skip = argv.skip ? Math.max(0, Number(argv.skip)) : 0;
 const concurrency = argv.concurrency ? Math.max(1, Number(argv.concurrency)) : 2;
 const headless = Boolean(argv.headless);
 const resumeFrom = argv.resumeFrom || null;
 const stateFile = argv.stateFile || DEFAULT_STATE_FILE;
 const resultsFile = argv.resultsFile || DEFAULT_RESULTS_FILE;
 const screenshotDir = argv.screenshotDir || DEFAULT_SCREENSHOT_DIR;
 const accountTimeoutMs = argv.accountTimeoutMs ? Math.max(30000, Number(argv.accountTimeoutMs)) : 180000;

 if (!dryRun && (!process.env.PLUSVIBE_EMAIL || !process.env.PLUSVIBE_PASSWORD)) {
 console.error('ERROR: PLUSVIBE_EMAIL and PLUSVIBE_PASSWORD env vars required.');
 process.exit(2);
 }

 if (dryRun) {
 console.log('=== DRY RUN ===');
 const mailboxes = await fetchMailboxes();
 console.log(`Found ${mailboxes.length} mailboxes`);
 if (mailboxes.length > 0) {
 console.log('Sample:', JSON.stringify(mailboxes.slice(0, 3), null, 2));
 }
 process.exit(0);
 }

 let mailboxes = await fetchMailboxes();
 log(`Fetched ${mailboxes.length} mailboxes from VPS DB`);

 if (skip > 0) mailboxes = mailboxes.slice(skip);
 if (limit < mailboxes.length) mailboxes = mailboxes.slice(0, limit);

 if (resumeFrom) {
 const resumeIdx = mailboxes.findIndex((m) => m.email === resumeFrom);
 if (resumeIdx >= 0) mailboxes = mailboxes.slice(resumeIdx);
 }

 const browser = await launchBrowser({ headless });
 const loginContext = await ensureContext(browser);
 const loginPage = await loginContext.newPage();

 const sessionCookies = await loginToPlusVibe(loginPage);

 // Keep loginPage alive but never navigate it — workers clone cookies from it
 const completed = await loadState(stateFile);
 const alreadyAdded = new Set(completed.results.filter((r) => r.status === 'added').map((r) => r.email));
 if (alreadyAdded.size > 0) log(`Resuming: skipping ${alreadyAdded.size} already-added account(s)`);

 // Worker: each invocation creates its own isolated incognito context
 await runPool(
 mailboxes,
 concurrency,
 async (mailbox, index) => {
 const emailKey = mailbox.email;
 if (alreadyAdded.has(emailKey)) {
 if (verbose) log(`SKIP (already added): ${emailKey}`);
 completed.progress.lastProcessedIndex = Math.max(completed.progress.lastProcessedIndex, index);
 await saveState(stateFile, completed);
 return;
 }
 const t0 = Date.now();
 try {
 if (verbose) log(`[${index + 1}/${mailboxes.length}] Adding ${emailKey}`);
 await processAccount(browser, sessionCookies, mailbox, verbose, screenshotDir, accountTimeoutMs);
 completed.results.push({ email: emailKey, status: 'added', addedAt: new Date().toISOString() });
 completed.progress.lastProcessedIndex = Math.max(completed.progress.lastProcessedIndex, index);
 } catch (err) {
 log(`FAILED ${emailKey}: ${err?.message || err}`);
 completed.results.push({
 email: emailKey,
 status: 'failed',
 error: String(err?.message || err),
 addedAt: new Date().toISOString(),
 });
 completed.progress.lastProcessedIndex = Math.max(completed.progress.lastProcessedIndex, index);
 } finally {
 completed.progress.lastProcessedIndex = Math.max(completed.progress.lastProcessedIndex, index);
 await saveState(stateFile, completed);
 const done = completed.results.filter((r) => r.status === 'added').length;
 const failed = completed.results.filter((r) => r.status === 'failed').length;
 const remaining = Math.max(0, mailboxes.length - (index + 1));
 log(`Progress: ${done} added, ${failed} failed, ${remaining} remaining`);
 if (Date.now() - t0 > 60000) await sleep;
 }
 },
 );

 const added = completed.results.filter((r) => r.status === 'added').length;
 const failed = completed.results.filter((r) => r.status === 'failed').length;
 const summary = `Done. ${added} added, ${failed} failed in ${Math.round((Date.now() - startTime) / 1000)}s`;
 log(summary);
 console.log(summary);
 await browser.close();
 if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
 console.error('FATAL:', err);
 process.exit(1);
});
