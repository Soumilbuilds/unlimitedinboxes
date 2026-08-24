#!/usr/bin/env node

import fs from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function requireFromServerNodeModules(moduleFile) {
  const roots = [
    process.env.SERVER_NODE_MODULES,
    path.resolve(scriptDir, '../server/node_modules'),
    path.resolve(process.cwd(), 'server/node_modules'),
    '/opt/unlimited-inboxes/current/server/node_modules'
  ].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, moduleFile));
    } catch {}
  }
  throw new Error(`Could not load ${moduleFile}`);
}

const puppeteerModule = requireFromServerNodeModules('puppeteer-extra/dist/index.cjs.js');
const StealthPluginModule = requireFromServerNodeModules('puppeteer-extra-plugin-stealth/index.js');
const puppeteer = puppeteerModule.default || puppeteerModule;
const StealthPlugin = StealthPluginModule.default || StealthPluginModule;
puppeteer.use(StealthPlugin());

const email = process.env.MANYREACH_EMAIL;
const password = process.env.MANYREACH_PASSWORD;
const sendersUrl = process.env.MANYREACH_SENDERS_URL || 'https://app.manyreach.com/e/senders';
const output = process.argv[2];
if (!email || !password || !output) {
  throw new Error('Set MANYREACH_EMAIL and MANYREACH_PASSWORD, then pass the output cookie-file path.');
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);
  await page.goto('https://app.manyreach.com/e/login', { waitUntil: 'domcontentloaded' });

  const emailInput = await page.waitForSelector('#Email, input[name="Email"], input[type="email"], input[name="email"], input[autocomplete="username"]', { visible: true });
  await emailInput.type(email, { delay: 20 });

  let passwordInput = await page.$('#Password, input[name="Password"], input[type="password"], input[name="password"], input[autocomplete="current-password"]');
  if (!passwordInput) {
    await clickSubmit(page);
    passwordInput = await page.waitForSelector('#Password, input[name="Password"], input[type="password"], input[name="password"], input[autocomplete="current-password"]', { visible: true });
  }
  await passwordInput.type(password, { delay: 20 });
  await clickSubmit(page);

  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 90000 });
  await page.goto(sendersUrl, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) throw new Error('Manyreach rejected the login or required an additional step.');

  const cookies = await page.cookies('https://app.manyreach.com');
  if (!cookies.some(cookie => cookie.name === '.ASPXAUTH')) {
    throw new Error('Manyreach login completed without an authentication cookie.');
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(cookies, null, 2)}\n`, { mode: 0o600 });
  console.log(`Manyreach session refreshed (${cookies.length} cookies).`);
} finally {
  await browser.close();
}

async function clickSubmit(page) {
  const selector = 'button[type="submit"], input[type="submit"]';
  const button = await page.waitForSelector(selector, { visible: true });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    button.click()
  ]);
}
