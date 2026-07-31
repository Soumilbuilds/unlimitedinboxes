import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs/promises';
import { generateTotpCode, isValidTotpSecret } from './totp.js';

puppeteer.use(StealthPlugin());

let browser = null;

// Build a TOTP resolver function from an mfaSecret string.
// Returns a function compatible with the getTotpCode callback signature,
// or null if the secret is invalid.
export function buildTotpResolver(mfaSecret) {
 if (!mfaSecret || typeof mfaSecret !== 'string') return null;
 if (!isValidTotpSecret(mfaSecret)) {
 console.warn(`[TOTP] Ignoring invalid MFA secret (${mfaSecret.length} chars)`);
 return null;
 }
 return function resolveTotpCode() {
 return generateTotpCode(mfaSecret);
 };
}

// ─── Browser Lifecycle ────────────────────────────────────────────────────────

let browserPromise = null;
export async function launchBrowser() {
 console.log('[Puppeteer] launchBrowser called');
 if (!browser || !browser.isConnected()) {
 if (!browserPromise) {
 console.log('[Puppeteer] No browserPromise, creating one');
 browserPromise = (async () => {
 const isProduction = process.env.NODE_ENV === 'production';
 console.log(`[Puppeteer] Launching browser, headless: ${isProduction ? 'new' : false}`);
 browser = await puppeteer.launch({
 headless: isProduction ? 'new' : false,
 args: [
 '--no-sandbox',
 '--disable-setuid-sandbox',
 '--disable-blink-features=AutomationControlled',
 '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning,PasswordManagerOnboarding,PasswordManagerRedesign',
 '--disable-save-password-bubble',
 '--window-size=1920,1080',
 '--mute-audio'
 ],
 ignoreDefaultArgs: ['--enable-automation'],
 defaultViewport: { width: 1920, height: 1080 }
 });
 console.log('[Puppeteer] Browser launched successfully');
 browserPromise = null;
 return browser;
 })();
 } else {
 console.log('[Puppeteer] Waiting for existing browserPromise');
 }
 return browserPromise;
 }
 console.log('[Puppeteer] Returning existing connected browser');
 return browser;
}

export async function closeBrowser() {
 if (browser) {
 await browser.close();
 browser = null;
 }
}

export async function createIncognitoPage() {
 console.log('[Puppeteer] createIncognitoPage called');
 const b = await launchBrowser();
 console.log('[Puppeteer] browser obtained for createIncognitoPage');
 let context = null;
 if (typeof b.createBrowserContext === 'function') {
 context = await b.createBrowserContext();
 } else if (typeof b.createIncognitoBrowserContext === 'function') {
 context = await b.createIncognitoBrowserContext();
 } else {
 throw new Error('Browser isolation is unavailable; refusing to reuse another tenant session');
 }
 console.log('[Puppeteer] context created');
 const page = await context.newPage();
 console.log('[Puppeteer] page created');
 await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
 return { context, page };
}

export async function saveDebugScreenshot(page, name) {
 try {
 const outputDir = path.resolve(process.cwd(), 'screenshots');
 await fs.mkdir(outputDir, { recursive: true });
 const outputPath = path.join(outputDir, `${name}.png`);
 await page.screenshot({ path: outputPath, fullPage: true });
 console.log(`Debug screenshot saved: ${outputPath}`);
 } catch (e) {
 console.error('Failed to save screenshot:', e.message);
 }
}

// ─── Page / URL Utilities ─────────────────────────────────────────────────────

async function waitForNewOrActivePage(context, currentPage, timeout = 5000) {
 if (!context) return currentPage;
 try {
 await context.waitForEvent('page', { timeout });
 } catch {
 // ignore
 }
 return settleOnMicrosoftPage(context, currentPage);
}

function isMicrosoftDomain(rawUrl) {
 if (!rawUrl || rawUrl.startsWith('about:')) return false;
 try {
 const { hostname } = new URL(rawUrl);
 return (
 hostname.endsWith('.microsoft.com') ||
 hostname.endsWith('.microsoftonline.com') ||
 hostname.endsWith('.microsoftonline.us') ||
 hostname.endsWith('.office.com') ||
 hostname.endsWith('.office.net') ||
 hostname.endsWith('.live.com') ||
 hostname.endsWith('.msauth.net') ||
 hostname.endsWith('.msftauth.net') ||
 hostname.endsWith('.windows.net')
 );
 } catch {
 return false;
 }
}

function scoreMicrosoftUrl(rawUrl) {
 if (!rawUrl) return 0;
 if (rawUrl.includes('admin.exchange.microsoft.com')) return 100;
 if (rawUrl.includes('admin.cloud.microsoft') || rawUrl.includes('admin.microsoft.com')) return 90;
 if (rawUrl.includes('login.microsoftonline.com')) return 70;
 if (rawUrl.includes('office.com')) return 60;
 return 50;
}

async function settleOnMicrosoftPage(context, currentPage) {
 if (!context) return currentPage;
 const pages = await context.pages();
 const active = pages.filter(p => !p.isClosed());
 const candidates = active.filter(p => isMicrosoftDomain(p.url()));
 if (!candidates.length) return currentPage;

 let best = null;
 let bestScore = -1;
 for (const p of candidates) {
 const s = scoreMicrosoftUrl(p.url());
 if (s > bestScore) {
 best = p;
 bestScore = s;
 }
 }
 return best || currentPage;
}

async function closeNonMicrosoftPages(context, keepPage) {
 if (!context) return;
 const pages = await context.pages();
 for (const p of pages) {
 if (p === keepPage || p.isClosed()) continue;
 const url = p.url();
 if (!isMicrosoftDomain(url) || url === 'about:blank') {
 try { await p.close({ runBeforeUnload: false }); } catch { /* ignore */ }
 }
 }
}

function sleep(ms) {
 return new Promise(resolve => setTimeout(resolve, ms));
}

function isNavigationError(error) {
 const message = error?.message || '';
 return /Execution context was destroyed|Cannot find context with specified id|Target closed|Navigation failed/i.test(message);
}

async function readMicrosoftAuthError(page) {
 try {
 const text = await page.evaluate(() => document.body?.innerText || '');
 const code = text.match(/AADSTS\d+/i)?.[0]?.toUpperCase();
 if (!code) return null;
 const summary = text
 .split(/\r?\n/)
 .map(line => line.trim())
 .find(line => line.toUpperCase().includes(code));
 return summary ? `${code}: ${summary.replace(/^.*?AADSTS\d+\s*:\s*/i, '')}` : code;
 } catch {
 return null;
 }
}

async function readMicrosoftVisibleCredentialError(page) {
 try {
 return await page.evaluate(() => {
 const visible = el => {
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' &&
 style.opacity !== '0' && rect.width > 0 && rect.height > 0;
 };
 const nodes = Array.from(document.querySelectorAll(
 '[role="alert"], .alert-error, .error, #passwordError, #usernameError, ' +
 '#idSpan_SAOTCC_Error, [data-testid*="error"]'
 )).filter(visible);
 const text = nodes.map(el => (el.innerText || el.textContent || '').trim())
 .filter(Boolean)
 .join(' ');
 if (!text) return null;
 const actionable = /incorrect|invalid|couldn.t find|doesn.t exist|locked|blocked|too many|try again|expired/i;
 return actionable.test(text) ? text.replace(/\s+/g, ' ').slice(0, 500) : null;
 });
 } catch {
 return null;
 }
}

async function isPushMfaPrompt(page) {
 try {
 return await page.evaluate(() => {
 const text = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
 const pushCopy = /approve (the )?(sign-in|request)|check your (microsoft )?authenticator app|enter the number shown/i.test(text);
 const visibleOtp = Array.from(document.querySelectorAll(
 'input[name="otc"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
 )).some(el => {
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' &&
 style.opacity !== '0' && rect.width > 0 && rect.height > 0;
 });
 return pushCopy && !visibleOtp;
 });
 } catch {
 return false;
 }
}

async function isAdminConsentPrompt(page) {
 try {
 return await page.evaluate(() => {
 const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
 const bodyText = normalize(document.body?.innerText);
 if (!bodyText.includes('permissions requested')) return false;

 const candidates = Array.from(document.querySelectorAll(
 '#idSIButton9, #idBtn_Accept, [data-testid="acceptButton"], ' +
 'button[name="accept"], input[value="Accept"], button, [role="button"], ' +
 'input[type="submit"], input[type="button"]'
 ));
 return candidates.some(el => {
 const label = normalize(el.value || el.innerText || el.textContent || el.getAttribute('aria-label'));
 if (label !== 'accept') return false;
 if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' &&
 style.opacity !== '0' && rect.width > 0 && rect.height > 0;
 });
 });
 } catch {
 return false;
 }
}

async function clickAdminConsentAccept(page) {
 return page.evaluate(() => {
 const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
 const candidates = Array.from(document.querySelectorAll(
 '#idSIButton9, #idBtn_Accept, [data-testid="acceptButton"], ' +
 'button[name="accept"], input[value="Accept"], button, [role="button"], ' +
 'input[type="submit"], input[type="button"]'
 ));
 const accept = candidates.find(el => {
 const label = normalize(el.value || el.innerText || el.textContent || el.getAttribute('aria-label'));
 if (label !== 'accept') return false;
 if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' &&
 style.opacity !== '0' && rect.width > 0 && rect.height > 0;
 });
 if (!accept) return false;
 accept.click();
 return true;
 });
}

// ─── Input Helpers ────────────────────────────────────────────────────────────

async function findVisibleElement(page, selector) {
 const elements = await page.$$(selector);
 for (const element of elements) {
 try {
 const visible = await element.evaluate(el => {
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return !el.disabled &&
 el.getAttribute('aria-disabled') !== 'true' &&
 style.display !== 'none' &&
 style.visibility !== 'hidden' &&
 style.opacity !== '0' &&
 rect.width > 0 &&
 rect.height > 0;
 });
 if (visible) return element;
 } catch {
 // The page may have replaced this element while Microsoft was navigating.
 }
 }
 return null;
}

async function clickIfExists(page, selector) {
 const el = await findVisibleElement(page, selector);
 if (el) {
 await el.click();
 return true;
 }
 return false;
}

async function setInputValue(page, selector, value) {
 const el = await findVisibleElement(page, selector);
 if (!el) return false;

 await el.click({ clickCount: 3 });
 await page.keyboard.press('Backspace');
 await sleep(100);

 await page.keyboard.type(value, { delay: 50 });

 await page.evaluate((input, val) => {
 input.value = val;
 input.dispatchEvent(new Event('input', { bubbles: true }));
 input.dispatchEvent(new Event('change', { bubbles: true }));
 }, el, value);

 return true;
}

async function chooseRequestedMicrosoftAccount(page, email) {
 try {
 return await page.evaluate(requestedEmail => {
 const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
 const wanted = normalize(requestedEmail);
 const visible = el => {
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' &&
 style.opacity !== '0' && rect.width > 0 && rect.height > 0;
 };
 const candidates = Array.from(document.querySelectorAll(
 'button, [role="button"], .tile, .table[role="listitem"]'
 )).filter(visible);
 const exactAccount = candidates.find(el => normalize(el.innerText || el.textContent).includes(wanted));
 if (exactAccount) {
 exactAccount.click();
 return 'requested-account';
 }
 const useAnother = candidates.find(el =>
 normalize(el.innerText || el.textContent) === 'use another account'
 );
 if (useAnother) {
 useAnother.click();
 return 'use-another-account';
 }
 return null;
 }, email);
 } catch {
 return null;
 }
}

// ─── Stay Signed In (KMSI) Prompt ─────────────────────────────────────────────
// Microsoft asks "Stay signed in?" after password entry.
// We dismiss it by clicking "No" (or unchecking the box and proceeding).

async function handleStaySignedIn(page) {
 try {
 if (!page || page.isClosed()) return false;

 const kmsiVisible = await page.evaluate(() => {
 try {
 const text = document.body?.innerText || '';
 return Boolean(
 document.querySelector('input[name="DontShowAgain"]') ||
 /stay signed in/i.test(text)
 );
 } catch (e) { return false; }
 });
 if (!kmsiVisible) return false;

 await page.waitForFunction(
 () => {
 try {
 const url = window.location.href;
 return document.querySelector('#idSIButton9') ||
 document.querySelector('input[value="Yes"]') ||
 document.querySelector('input[value="No"]') ||
 !url.includes('login.microsoftonline.com') ||
 url.includes('ProcessAuth') || url.includes('SAS/');
 } catch (e) { return false; }
 },
 { timeout: 10000 }
 ).catch(() => {});

 // Try to uncheck "Don't show this again"
 const checkbox = await page.$('input[name="DontShowAgain"]');
 if (checkbox) {
 try { await checkbox.click(); } catch { /* ignore */ }
 }

 // Prefer "No" to dismiss the KMSI prompt.
 const noBtn = await page.$('#idBtn_Back');
 if (noBtn) {
 await noBtn.click();
 await Promise.race([
 page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
 sleep(500)
 ]);
 return true;
 }

 // Fallback: click "Yes" to avoid getting stuck
 const yesBtn = await page.$('#idSIButton9');
 if (yesBtn) {
 await yesBtn.click();
 await Promise.race([
 page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
 sleep(500)
 ]);
 return true;
 }

 return false;
 } catch {
 return false;
 }
}

// ─── Security Defaults Wizard ─────────────────────────────────────────────────
// Bypasses the "Action Required: Security Defaults" MFA registration wall.

async function handleSecurityDefaultsSetup(page) {
 const MAX_ATTEMPTS = 8;
 try {
 if (!page || page.isClosed()) {
 return { handled: false };
 }

 const url = page.url();
 if (!url || !url.includes('login.microsoftonline.com')) {
 return { handled: false };
 }

 const bodyText = await page.evaluate(() =>
 (document.body && document.body.innerText) ? document.body.innerText : ''
 );
 const lower = (bodyText || '').toLowerCase();

 const hasActionRequired =
 lower.includes('action required') ||
 lower.includes('install microsoft authenticator');
 const hasSecurityDefaults =
 lower.includes('security defaults') ||
 lower.includes('multifactor authentication') ||
 lower.includes('more information required') ||
 lower.includes('protect your account') ||
 lower.includes('install microsoft authenticator') ||
 (lower.includes('register') && lower.includes('authentication'));

 if (!hasActionRequired || !hasSecurityDefaults) {
 return { handled: false };
 }

 async function clickByText(textOptions) {
 return await page.evaluate((opts) => {
 const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
 const targets = opts.map(norm).filter(Boolean);
 const isVisible = (el) => {
 if (!el) return false;
 const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
 if (rect.width === 0 && rect.height === 0) return false;
 const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
 if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
 return false;
 }
 return true;
 };
 const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], div[role="button"], span[role="button"]'));
 for (const el of candidates) {
 if (!isVisible(el)) continue;
 const text = norm(el.innerText || el.textContent || el.value || '');
 if (!text) continue;
 for (const t of targets) {
 if (text === t || text.startsWith(t + ' ') || text.startsWith(t + ',') || text.startsWith(t + '.')) {
 el.click();
 return true;
 }
 }
 }
 for (const el of candidates) {
 if (!isVisible(el)) continue;
 const text = norm(el.innerText || el.textContent || el.value || '');
 if (!text) continue;
 for (const t of targets) {
 if (text.includes(t)) {
 el.click();
 return true;
 }
 }
 }
 return false;
 }, textOptions);
 }

 async function readBody() {
 return await page.evaluate(() =>
 ((document.body && document.body.innerText) || '').toLowerCase()
 );
 }

 for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
 await sleep(500);

 const currentUrl = page.url();
 if (!currentUrl.includes('login.microsoftonline.com') &&
 !currentUrl.includes('mysignins.microsoft.com')) {
 return { handled: true };
 }

 const text = await readBody();

 const isOnMicrosoftDomain = currentUrl.includes('login.microsoftonline.com') ||
 currentUrl.includes('mysignins.microsoft.com');
 const wizardIndicators = [
 'action required',
 'security defaults',
 'more information required',
 'install microsoft authenticator',
 'set up a different method',
 'i want to set up a different method'
 ];
 const hasWizardText = wizardIndicators.some(ind => text.includes(ind));
 if (!isOnMicrosoftDomain && !hasWizardText) {
 return { handled: true };
 }
 if (!hasWizardText) {
 return { handled: true };
 }

 // Priority 1: escape hatches
 const skipped = await clickByText(['skip for now', 'skip setup', 'skip']);
 if (skipped) {
 await sleep(500);
 await sleep(500);
 continue;
 }

 // Priority 2: bypass the Authenticator push option
 const diffMethod = await clickByText([
 'i want to set up a different method',
 'i want to use a different method',
 'use a different method',
 'set up a different method'
 ]);
 if (diffMethod) {
 await sleep(500);
 await sleep(500);
 continue;
 }

 // Priority 3: choose TOTP/authenticator-app method
 const authMethodPicked = await clickByText([
 'use verification code from app',
 'verification code from app',
 'authenticator app',
 'authenticator',
 'use an authenticator app',
 'one-time password',
 'software token',
 'use a verification code',
 'enter a code from your authenticator app',
 'otp'
 ]);
 if (authMethodPicked) {
 await sleep(500);
 continue;
 }

 // Priority 4: initial Next / Set it up now button
 const nextClicked = await clickByText(['next', 'set it up now', 'get started', 'continue']);
 if (nextClicked) {
 await sleep(500);
 continue;
 }

 // Priority 5: mysignins.microsoft.com "Install Microsoft Authenticator" page
 if (text.includes('install microsoft authenticator') ||
 currentUrl.includes('mysignins.microsoft.com')) {
 const installNextClicked = await clickByText(['next', 'continue']);
 if (installNextClicked) {
 await sleep(500);
 continue;
 }
 }
 }

 return {
 handled: false,
 error: `Security Defaults wizard did not advance after ${MAX_ATTEMPTS} attempts`
 };
 } catch (error) {
 if (isNavigationError(error)) {
 return { handled: true };
 }
 return { handled: false, error: error.message };
 }
}

// ─── Two-Factor Prompt Handler ────────────────────────────────────────────────
// Detects and fills the Microsoft MFA / TOTP prompt.

async function handleTwoFactorPrompt(page, getTotpCode) {
 try {
 if (!page || page.isClosed()) return false;

 // Multi-strategy selector set: name, id, autocomplete, type, CSS attribute
 const otpInput = await page.$(
 'input[name="otc"], ' +
 'input[id="idTxtBx_SAOTCC_OTC"], ' +
 'input[autocomplete="one-time-code"], ' +
 'input[type="tel"][inputmode="numeric"], ' +
 'input[name="verificationCode"], ' +
 'input[id*="verification"], ' +
 'input[data-testid*="verification"], ' +
 'input[data-testid*="otc"]'
 );
 if (!otpInput) return false;

 // Text-based confirmation: look for MFA-related copy in the page body
 const isMfaPrompt = await page.evaluate(() => {
 const text = (document.body?.innerText || '').toLowerCase();
 return /enter the code|verification code|authenticator app|verify your identity|enter the verification code|enter code|code from|approve a request|approve request|verify.*code|sign.*in.*code|enter.*6.*digit|enter.*digit.*code|one.*time.*code|otp/i.test(text);
 });
 if (!isMfaPrompt) return false;

 let code;
 if (typeof getTotpCode === 'function') {
 code = await getTotpCode();
 if (!code || !/^\d{6}$/.test(String(code))) {
 throw new Error('TOTP resolver did not return a 6-digit code');
 }
 } else {
 throw new Error('MFA prompt detected but no valid MFA secret was provided');
 }

 // Fill the code using a stable selector
 const inputHandle = await otpInput.evaluate(el => ({ id: el.id, name: el.name }));
 let selector;
 if (inputHandle.id) {
 selector = `#${inputHandle.id}`;
 } else if (inputHandle.name) {
 selector = `[name="${inputHandle.name}"]`;
 } else {
 selector = 'input[name="otc"], input[autocomplete="one-time-code"]';
 }
 await setInputValue(page, selector, code);

 // Submit the code
 const submitBtn = await page.$(
 'input[type="submit"], button[type="submit"], ' +
 '#idSubmit_SAOTCC_Continue, #idSIButton9, ' +
 'button[data-testid*="submit"], button[data-testid*="next"]'
 );
 if (submitBtn) {
 await submitBtn.click();
 } else {
 await page.keyboard.press('Enter');
 }
 return true;
 } catch (error) {
 if (isNavigationError(error)) return false;
 throw error;
 }
}

// ─── Main Login Flow ──────────────────────────────────────────────────────────

async function handleMicrosoftLoginFlow(page, email, password, context, getTotpCode = null) {
 for (let i = 0; i < 20; i += 1) {
 try {
 page = await waitForNewOrActivePage(context, page);
 if (!page || page.isClosed()) {
 await sleep(500);
 continue;
 }

 await sleep(500);

 if (await isAdminConsentPrompt(page)) {
 break;
 }

 const visibleCredentialError = await readMicrosoftVisibleCredentialError(page);
 if (visibleCredentialError) {
 throw new Error(`Microsoft sign-in failed: ${visibleCredentialError}`);
 }

 const accountChoice = await chooseRequestedMicrosoftAccount(page, email);
 if (accountChoice) {
 await sleep(500);
 continue;
 }

 const emailInput = await findVisibleElement(page, 'input[type="email"], input[name="loginfmt"]');
 if (emailInput) {
 await setInputValue(page, 'input[type="email"], input[name="loginfmt"]', email);

 const nextBtn = await findVisibleElement(page, 'input[type="submit"], button[type="submit"], #idSIButton9');
 if (nextBtn) {
 await nextBtn.click();
 } else {
 await page.keyboard.press('Enter');
 }

 await Promise.race([
 page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
 sleep(500)
 ]);
 page = await waitForNewOrActivePage(context, page, 8000);
 await sleep(500);
 continue;
 }

 const passwordInput = await findVisibleElement(page, 'input[type="password"]');
 if (passwordInput) {
 await setInputValue(page, 'input[type="password"]', password);

 await sleep(500);

 const signInBtn = await findVisibleElement(page, 'input[type="submit"], button[type="submit"], #idSIButton9');
 if (signInBtn) {
 await signInBtn.click();
 } else {
 await page.keyboard.press('Enter');
 }

 await Promise.race([
 page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
 sleep(500)
 ]);
 page = await waitForNewOrActivePage(context, page, 8000);
 await sleep(500);
 await handleStaySignedIn(page);
 continue;
 }

 // 2FA / TOTP prompt
 const otpHandled = await handleTwoFactorPrompt(page, getTotpCode);
 if (otpHandled) {
 await sleep(500);
 page = await waitForNewOrActivePage(context, page, 8000);
 await sleep(500);
 continue;
 }

 if (await isPushMfaPrompt(page)) {
 throw new Error(
 'Microsoft requires Authenticator push/number approval. Configure verification-code (TOTP) MFA for unattended processing.'
 );
 }

 // Stay signed in prompt
 const kmsiHandled = await handleStaySignedIn(page);
 if (kmsiHandled) {
 page = await waitForNewOrActivePage(context, page, 8000);
 await sleep(500);
 continue;
 }

 // Security Defaults wizard
 const sdResult = await handleSecurityDefaultsSetup(page);
 if (sdResult.handled) {
 await sleep(500);
 page = await waitForNewOrActivePage(context, page, 8000);
 await sleep(500);
 continue;
 }
 if (sdResult.error) {
 console.warn('Security Defaults setup:', sdResult.error);
 }

 const currentLoopUrl = page.url();
 if (!currentLoopUrl.includes('login.microsoftonline.com') &&
 !currentLoopUrl.includes('mysignins.microsoft.com')) {
 break;
 }

 await sleep(500);
 } catch (error) {
 if (isNavigationError(error)) {
 await sleep(500);
 continue;
 }
 throw error;
 }
 }

 return page;
}

export async function ensureMicrosoftLogin(page, email, password, context, targetUrl, getTotpCode = null, mfaSecret = null) {
 try {
 // If mfaSecret is provided, build a TOTP resolver automatically
 const resolvedTotp = mfaSecret
 ? buildTotpResolver(mfaSecret)
 : null;

 const effectiveGetTotpCode = getTotpCode || resolvedTotp;

 for (let attempt = 0; attempt < 3; attempt += 1) {
 try {
 await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

 if (page.url().includes('login.microsoftonline.com')) {
 page = await handleMicrosoftLoginFlow(page, email, password, context, effectiveGetTotpCode);
 }

 let consentPromptReady = await isAdminConsentPrompt(page);

 if (page.url().includes('mysignins.microsoft.com') && !consentPromptReady) {
 await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
 }

 if (page.url().includes('login.microsoftonline.com') && !consentPromptReady) {
 await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
 if (page.url().includes('login.microsoftonline.com')) {
 page = await handleMicrosoftLoginFlow(page, email, password, context, effectiveGetTotpCode);
 }
 }

 consentPromptReady = await isAdminConsentPrompt(page);
 if (page.url().includes('login.microsoftonline.com') && !consentPromptReady) {
 const microsoftError = await readMicrosoftAuthError(page);
 await saveDebugScreenshot(page, 'login_error');
 return { success: false, error: microsoftError || 'Login page still shown after attempts', page };
 }
 page = await settleOnMicrosoftPage(context, page);
 await closeNonMicrosoftPages(context, page);
 return { success: true, page };
 } catch (error) {
 if (!isNavigationError(error) || attempt === 2) throw error;
 await sleep(500);
}
}
 if (page.url().includes('login.microsoftonline.com')) {
 const microsoftError = await readMicrosoftAuthError(page);
 await saveDebugScreenshot(page, 'login_error');
 return { success: false, error: microsoftError || 'Login page still shown after attempts', page };
 }
 page = await settleOnMicrosoftPage(context, page);
 await closeNonMicrosoftPages(context, page);
 return { success: true, page };
 } catch (error) {
 await saveDebugScreenshot(page, 'login_error');
 return { success: false, error: error.message, page };
 }
}

export async function completeMicrosoftDeviceCodeFlow({
 page,
 context,
 verificationUri,
 userCode,
 email,
 password,
 getTotpCode,
 mfaSecret
}) {
 const effectiveTotp = getTotpCode || (mfaSecret ? buildTotpResolver(mfaSecret) : null);
 await page.goto(verificationUri, { waitUntil: 'networkidle2', timeout: 60000 });

 let codeEntered = false;
 let loginHandled = false;
 for (let attempt = 0; attempt < 40; attempt += 1) {
 try {
 page = await waitForNewOrActivePage(context, page, 3000);
 await sleep(500);

 const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
 const lower = bodyText.toLowerCase();
 const authError = await readMicrosoftAuthError(page);
 if (authError) {
 await saveDebugScreenshot(page, 'device_code_error');
 return { success: false, page, error: authError };
 }

 if (
 /you have signed in|you may now close|device is now connected|authentication complete/i.test(bodyText)
 ) {
 return { success: true, page };
 }

 if (!codeEntered && /enter code|enter the code/i.test(bodyText)) {
 const selector = 'input[name="otc"], input#otc, input[type="text"]';
 if (await setInputValue(page, selector, userCode)) {
 codeEntered = true;
 const submit = await page.$('#idSIButton9, input[type="submit"], button[type="submit"]');
 if (submit) await submit.click();
 else await page.keyboard.press('Enter');
 await sleep(1000);
 continue;
 }
 }

 const isConsent =
 lower.includes('permissions requested') ||
 lower.includes('accept the permissions') ||
 lower.includes('consent on behalf') ||
 (lower.includes('microsoft graph command line tools') && (
 lower.includes('accept') ||
 lower.includes('are you trying to sign in') ||
 lower.includes('continue')
 ));
 if (isConsent) {
 const clicked = await page.evaluate(() => {
 const candidates = Array.from(document.querySelectorAll(
 'input[type="submit"], button[type="submit"], button, input[type="button"]'
 ));
 const accept = candidates.find(el => {
 const value = (el.value || el.innerText || el.textContent || '').trim().toLowerCase();
 return value === 'accept' || value === 'continue' || value === 'yes';
 });
 if (!accept) return false;
 accept.click();
 return true;
 });
 if (clicked) {
 await sleep(1000);
 continue;
 }
 }

 if (page.url().includes('login.microsoftonline.com') && !loginHandled) {
 loginHandled = true;
 page = await handleMicrosoftLoginFlow(page, email, password, context, effectiveTotp);
 await sleep(500);
 continue;
 }

 await sleep(500);
 } catch (error) {
 if (!isNavigationError(error)) {
 await saveDebugScreenshot(page, 'device_code_error');
 return { success: false, page, error: error.message };
 }
 }
 }

 await saveDebugScreenshot(page, 'device_code_error');
 return {
 success: false,
 page,
 error: 'Microsoft device authorization did not complete before the timeout'
 };
}

export async function loginToMicrosoft365(page, email, password, context = null, getTotpCode = null, mfaSecret = null) {
 // If mfaSecret is provided, auto-build a TOTP resolver
 const mfaResolver = mfaSecret ? buildTotpResolver(mfaSecret) : null;
 const effectiveTotp = getTotpCode || mfaResolver;

 const targetUrl = 'https://admin.exchange.microsoft.com/#/mailboxes';
 const result = await ensureMicrosoftLogin(page, email, password, context, targetUrl, effectiveTotp, mfaSecret);
 if (!result.success) return result;

 if (!result.page.url().includes('admin.exchange.microsoft.com')) {
 return { success: false, error: 'Could not reach Exchange admin center after login', page: result.page };
 }

 return result;
}

export async function createSharedMailbox(page, displayName, alias, domain, log = console.log) {
 try {
 if (page.isClosed()) {
 throw new Error('Browser page closed before mailbox creation');
 }
 log(`Creating: ${displayName} (${alias}@${domain})`);

 if (!page.url().includes('admin.exchange.microsoft.com')) {
 await page.goto('https://admin.exchange.microsoft.com/#/mailboxes', {
 waitUntil: 'networkidle2',
 timeout: 60000
 });
 await new Promise(r => setTimeout(r, 3000));
 if (page.url().includes('login.microsoftonline.com')) {
 throw new Error('Exchange admin session not authenticated (login screen shown)');
 }
 }

 const result = await page.evaluate(async (dName, dAlias, dDomain) => {
 const email = `${dAlias}@${dDomain}`;
 const uuid = crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-0000-0000-000000000000';

 const payload = {
 PrimarySmtpAddress: email,
 RecipientTypeDetails: 'SharedMailbox',
 Name: dName,
 DisplayName: dName,
 Alias: dAlias
 };

 try {
 const response = await fetch('https://admin.exchange.microsoft.com/beta/Mailbox', {
 method: 'POST',
 headers: {
 accept: 'application/json',
 'content-type': 'application/json',
 app: 'Cosmic',
 'x-requested-with': 'XMLHttpRequest',
 'client-request-id': uuid
 },
 body: JSON.stringify(payload)
 });

 if (!response.ok) {
 const text = await response.text();
 return { success: false, status: response.status, error: text };
 }

 const json = await response.json();
 return { success: true, data: json };
 } catch (err) {
 return { success: false, error: err.toString() };
 }
 }, displayName, alias, domain);

 if (!result.success) {
 throw new Error(`API Error ${result.status}: ${result.error}`);
 }

 if (result.data) {
 const objectId = result.data?.ObjectId || result.data?.objectId || result.data?.Id;
 const externalDirectoryObjectId =
 result.data?.ExternalDirectoryObjectId ||
 result.data?.externalDirectoryObjectId ||
 result.data?.AzureActiveDirectoryObjectId ||
 result.data?.AzureADObjectId ||
 result.data?.azureAdObjectId;
 return {
 success: true,
 email: `${alias}@${domain}`,
 objectId,
 externalDirectoryObjectId
 };
 }

 throw new Error('API succeeded but returned no ObjectId.');
 } catch (error) {
 log(`Create mailbox error: ${error.message}`);
 await saveDebugScreenshot(page, 'create_mailbox_error');
 return { success: false, error: error.message };
 }
}

export async function ensureExchangeSmtpAuthEnabled(page, log = console.log) {
 try {
 log('Checking Exchange mail flow SMTP AUTH setting...');

 await page.goto('https://admin.exchange.microsoft.com/#/settings', {
 waitUntil: 'networkidle2',
 timeout: 60000
 });

 await page.waitForFunction(() => {
 const heading = Array.from(document.querySelectorAll('h1,h2,h3')).find(el =>
 (el.textContent || '').trim() === 'Settings'
 );
 return !!heading;
 }, { timeout: 60000 });

 const clickedMailFlow = await page.evaluate(() => {
 const heading = Array.from(document.querySelectorAll('h1,h2,h3')).find(el =>
 (el.textContent || '').trim() === 'Settings'
 );
 const root = heading ? heading.closest('main') || document.body : document.body;
 const rows = Array.from(root.querySelectorAll('*')).filter(el => {
 if (el.childElementCount > 0) return false;
 return (el.textContent || '').trim() === 'Mail flow';
 });
 for (const row of rows) {
 const clickable = row.closest('button,[role="button"],a,li,div');
 if (clickable) {
 clickable.click();
 return true;
 }
 }
 return false;
 });

 if (!clickedMailFlow) {
 throw new Error('Mail flow settings entry not found');
 }

 await page.waitForFunction(() => {
 return Array.from(document.querySelectorAll('*')).some(el =>
 (el.textContent || '').trim() === 'Mail flow settings'
 );
 }, { timeout: 60000 });

 const result = await page.evaluate(() => {
 const labelText = 'Turn off SMTP AUTH protocol for your organization';
 const heading = Array.from(document.querySelectorAll('*')).find(el =>
 (el.textContent || '').trim() === 'Mail flow settings'
 );
 const panelRoot = heading ? (heading.closest('section') || heading.closest('div') || document.body) : document.body;

 const labelNode = Array.from(panelRoot.querySelectorAll('span,label,div'))
 .find(el => (el.textContent || '').trim() === labelText);

 if (!labelNode) {
 return { found: false };
 }

 const container = labelNode.closest('label,div,li,section') || labelNode.parentElement;
 if (!container) {
 return { found: false };
 }

 const input = container.querySelector('input[type="checkbox"]');
 const roleCheckbox = container.querySelector('[role="checkbox"]');

 let checked = false;
 if (input) {
 checked = !!input.checked;
 } else if (roleCheckbox) {
 checked = roleCheckbox.getAttribute('aria-checked') === 'true';
 }

 let changed = false;
 if (checked) {
 if (input) input.click();
 else if (roleCheckbox) roleCheckbox.click();
 else container.click();
 changed = true;
 }

 if (!changed) {
 return { found: true, changed: false };
 }

 const saveBtn = Array.from(panelRoot.querySelectorAll('button'))
 .find(btn => (btn.textContent || '').trim() === 'Save');
 if (saveBtn) {
 saveBtn.click();
 return { found: true, changed: true, saved: true };
 }
 return { found: true, changed: true, saved: false };
 });

 if (!result.found) {
 throw new Error('SMTP AUTH setting checkbox not found');
 }

 if (!result.changed) {
 log('SMTP AUTH setting already enabled; no change needed.');
 return { changed: false };
 }

 if (!result.saved) {
 throw new Error('Save button not found after updating SMTP AUTH setting');
 }

 await page.waitForFunction(() => {
 return Array.from(document.querySelectorAll('*')).some(el =>
 (el.textContent || '').toLowerCase().includes('your change has been saved')
 );
 }, { timeout: 60000 });

 log('SMTP AUTH setting updated and saved.');
 return { changed: true };
 } catch (error) {
 await saveDebugScreenshot(page, 'smtp_auth_setting_error');
 return { success: false, error: error.message };
 }
}

// ─── Admin Consent ────────────────────────────────────────────────────────────

export async function grantAdminConsent({
 page,
 context,
 email,
 password,
 getTotpCode,
 mfaSecret,
 tenantId,
 clientId,
 redirectUri,
 state,
 scope
}) {
 try {
 if (!tenantId) {
 return { success: false, page, error: 'tenantId is required (must be the tenant GUID, not the onmicrosoft domain)' };
 }
 if (!clientId) {
 return { success: false, page, error: 'clientId is required' };
 }
 if (!redirectUri) {
 return { success: false, page, error: 'redirectUri is required' };
 }

 // If mfaSecret is provided, auto-build a TOTP resolver
 const mfaResolver = mfaSecret ? buildTotpResolver(mfaSecret) : null;
 const effectiveTotp = getTotpCode || mfaResolver;

 const consentUrl =
 `https://login.microsoftonline.com/${tenantId}/adminconsent` +
 `?client_id=${encodeURIComponent(clientId)}` +
 `&state=${encodeURIComponent(state || '')}` +
 `&redirect_uri=${encodeURIComponent(redirectUri)}` +
 (scope ? `&scope=${encodeURIComponent(scope)}` : '');

 const loginResult = await ensureMicrosoftLogin(page, email, password, context, consentUrl, effectiveTotp, mfaSecret);
 if (!loginResult.success) {
 await saveDebugScreenshot(page, 'consent_error');
 return { success: false, page: loginResult.page || page, error: loginResult.error || 'Login failed during admin consent' };
 }

 page = loginResult.page;

 const readConsentRedirect = () => {
 try {
 const u = new URL(page.url());
 const expected = new URL(redirectUri);
 if (u.origin !== expected.origin || u.pathname !== expected.pathname) return null;
 const returnedState = u.searchParams.get('state');
 if (state && returnedState !== state) {
 return { success: false, error: 'Consent callback state did not match the order' };
 }
 const callbackError = u.searchParams.get('error');
 if (callbackError) {
 const description = u.searchParams.get('error_description');
 return {
 success: false,
 error: `Consent callback failed: ${callbackError}${description ? ` — ${description}` : ''}`
 };
 }
 if (String(u.searchParams.get('admin_consent') || '').toLowerCase() === 'true') {
 return { success: true };
 }
 return { success: false, error: 'Consent callback did not include admin_consent=True' };
 } catch {
 return null;
 }
 };

 let consentRedirect = readConsentRedirect();
 if (consentRedirect) {
 return { ...consentRedirect, page, finalUrl: page.url() };
 }

 let consentPromptReady = await isAdminConsentPrompt(page);
 const promptDeadline = Date.now() + 15000;
 while (!consentPromptReady && !readConsentRedirect() && Date.now() < promptDeadline) {
 await sleep(250);
 consentPromptReady = await isAdminConsentPrompt(page);
 }

 consentRedirect = readConsentRedirect();
 if (consentRedirect) {
 return { ...consentRedirect, page, finalUrl: page.url() };
 }

 if (!consentPromptReady) {
 await saveDebugScreenshot(page, 'consent_result');

 const microsoftError = await readMicrosoftAuthError(page);
 if (microsoftError) {
 return { success: false, page, error: microsoftError };
 }
 await saveDebugScreenshot(page, 'consent_error');
 return {
 success: false,
 page,
 error: `Consent Accept button not found. URL: ${page.url()}. See screenshots/consent_result.png for what the page actually showed.`
 };
 }

 const navP = page
 .waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
 .catch(() => null);

 try {
 const clicked = await clickAdminConsentAccept(page);
 if (!clicked) {
 throw new Error('Accept button disappeared before it could be clicked');
 }
 } catch (clickErr) {
 if (!isNavigationError(clickErr)) {
 await saveDebugScreenshot(page, 'consent_error');
 return { success: false, page, error: `Failed to click Accept: ${clickErr.message}` };
 }
 }

 await navP;

 await sleep(500);

 const finalUrl = page.url();
 let pageText = '';
 let pageTitle = '';
 try {
 pageText = await page.evaluate(() => document.body && document.body.innerText) || '';
 } catch {
 // page may be in a bad state; ignore
 }
 try {
 pageTitle = await page.title() || '';
 } catch {
 // ignore
 }

 await saveDebugScreenshot(page, 'consent_result');

 consentRedirect = readConsentRedirect();
 const landedOnRedirect = (() => {
 try {
 const current = new URL(finalUrl);
 const expected = new URL(redirectUri);
 return current.origin === expected.origin && current.pathname === expected.pathname;
 } catch {
 return false;
 }
 })();

 if (consentRedirect) {
 return { ...consentRedirect, page, finalUrl };
 }

 const titleHasError = /error|an error occurred/i.test(pageTitle);
 const textHasAadsts = /AADSTS\d+/i.test(pageText);
 const textHasAdminApproval = /This app requires admin approval|Need admin approval|requires admin approval/i.test(pageText);
 const textHasNoPermission = /You don['']t have permission|don't have permission to access/i.test(pageText);
 const textHasAccessDenied = /access_denied|access denied/i.test(pageText);
 const textHasBlockedByPolicy = /blocked by (your )?(organization|policy|tenant admin)/i.test(pageText);

 if (titleHasError || textHasAadsts || textHasAdminApproval ||
 textHasNoPermission || textHasAccessDenied || textHasBlockedByPolicy) {

 let errorType = 'Consent failed with Microsoft error';
 if (textHasAadsts) {
 const m = pageText.match(/AADSTS\d+/);
 errorType = m ? `Consent failed (${m[0]})` : 'Consent failed (AADSTS)';
 } else if (textHasAdminApproval) {
 errorType = 'Admin approval required';
 } else if (textHasNoPermission) {
 errorType = 'No permission to grant consent';
 } else if (textHasAccessDenied) {
 errorType = 'Access denied';
 } else if (textHasBlockedByPolicy) {
 errorType = 'Blocked by tenant policy';
 }

 return {
 success: false,
 page,
 finalUrl,
 error: `${errorType} — final URL: ${finalUrl}. See screenshots/consent_result.png for details.`
 };
 }

 const isStillOnMicrosoftLogin = finalUrl.includes('login.microsoftonline.com');
 const isOnDifferentTenant = isStillOnMicrosoftLogin && !finalUrl.includes(tenantId);

 if (isOnDifferentTenant) {
 return {
 success: false,
 page,
 finalUrl,
 error: `Consent failed — page is on a different Microsoft tenant than the customer tenant (${tenantId}). Final URL: ${finalUrl}. See screenshots/consent_result.png for details.`
 };
 }

 if (!landedOnRedirect) {
 return {
 success: false,
 page,
 finalUrl,
 error: `Consent did not return admin_consent=True; final URL was ${finalUrl}. See screenshots/consent_result.png for details.`
 };
 }
 } catch (error) {
 await saveDebugScreenshot(page, 'consent_error');
 return { success: false, page, error: error.message };
 }
}
