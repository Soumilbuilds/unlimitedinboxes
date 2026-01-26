import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs/promises';

puppeteer.use(StealthPlugin());

let browser = null;

export async function launchBrowser() {
  if (!browser || !browser.isConnected()) {
    const isProduction = process.env.NODE_ENV === 'production';
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
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function createIncognitoPage() {
  const b = await launchBrowser();
  const useIncognito = process.env.USE_INCOGNITO_CONTEXT === 'true';
  let context = null;
  if (useIncognito) {
    if (typeof b.createBrowserContext === 'function') {
      context = await b.createBrowserContext();
    } else if (typeof b.createIncognitoBrowserContext === 'function') {
      context = await b.createIncognitoBrowserContext();
    }
  }
  const page = context ? await context.newPage() : await b.newPage();
  /* Use macOS User-Agent to match the platform and headers used in other requests */
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

async function clickIfExists(page, selector) {
  const el = await page.$(selector);
  if (el) {
    await el.click();
    return true;
  }
  return false;
}

async function setInputValue(page, selector, value) {
  const el = await page.$(selector);
  if (!el) return false;

  // Clear input first
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

async function handleStaySignedIn(page) {
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('#idSIButton9') ||
        document.querySelector('#idBtn_Back') ||
        document.querySelector('input[name="DontShowAgain"]'),
      { timeout: 6000 }
    );

    const checkbox = await page.$('input[name="DontShowAgain"]');
    if (checkbox) {
      try { await checkbox.click(); } catch { /* ignore */ }
    }

    // Prefer "Yes" to avoid getting stuck after the prompt.
    const yesBtn = await page.$('#idSIButton9');
    if (yesBtn) {
      await yesBtn.click();
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
        sleep(1500)
      ]);
      return;
    }

    const noBtn = await page.$('#idBtn_Back');
    if (noBtn) {
      await noBtn.click();
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
        sleep(1500)
      ]);
    }
  } catch {
    // ignore
  }
}

async function handleMicrosoftLoginFlow(page, email, password, context) {
  // Increased attempts for robustness
  for (let i = 0; i < 10; i += 1) {
    try {
      page = await waitForNewOrActivePage(context, page);
      if (!page || page.isClosed()) {
        await sleep(500);
        continue;
      }

      await sleep(1000); // Give a bit more time for the page to settle

      if (await clickIfExists(page, '#otherTile')) {
        await sleep(1000);
      }
      const pickAccount = await page.$('.tiles-container div.row.tile, .table div[role="listitem"]');
      if (pickAccount) {
        await pickAccount.click();
        await sleep(1000);
      }

      const emailInput = await page.$('input[type="email"]');
      if (emailInput) {
        // console.log('Entering email...');
        await setInputValue(page, 'input[type="email"]', email);

        const nextBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
        if (nextBtn) {
          await nextBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }

        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
          sleep(2000)
        ]);
        page = await waitForNewOrActivePage(context, page, 8000);
        await sleep(500);
        continue;
      }

      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        // console.log('Entering password...');
        // Ensure email field isn't still focused or visible in a confusing way (sometimes flows differ)
        await setInputValue(page, 'input[type="password"]', password);

        // Wait a small moment before hitting next
        await sleep(500);

        const signInBtn = await page.$('input[type="submit"], button[type="submit"], #idSIButton9');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }

        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
          sleep(2000)
        ]);
        page = await waitForNewOrActivePage(context, page, 8000);
        await sleep(500);
        await handleStaySignedIn(page);
        continue;
      }

      if (!page.url().includes('login.microsoftonline.com')) {
        // console.log('Login flow seemingly complete, URL is: ' + page.url());
        break;
      }

      await sleep(1500);
    } catch (error) {
      if (isNavigationError(error)) {
        await sleep(1000);
        continue;
      }
      throw error;
    }
  }

  return page;
}

export async function ensureMicrosoftLogin(page, email, password, context, targetUrl) {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        if (page.url().includes('login.microsoftonline.com')) {
          page = await handleMicrosoftLoginFlow(page, email, password, context);
        }

        if (page.url().includes('login.microsoftonline.com')) {
          await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
          if (page.url().includes('login.microsoftonline.com')) {
            page = await handleMicrosoftLoginFlow(page, email, password, context);
          }
        }

        if (page.url().includes('login.microsoftonline.com')) {
          await saveDebugScreenshot(page, 'login_error');
          return { success: false, error: 'Login page still shown after attempts', page };
        }
        page = await settleOnMicrosoftPage(context, page);
        await closeNonMicrosoftPages(context, page);
        return { success: true, page };
      } catch (error) {
        if (!isNavigationError(error) || attempt === 2) throw error;
        await sleep(1000);
      }
    }
    if (page.url().includes('login.microsoftonline.com')) {
      await saveDebugScreenshot(page, 'login_error');
      return { success: false, error: 'Login page still shown after attempts', page };
    }
    page = await settleOnMicrosoftPage(context, page);
    await closeNonMicrosoftPages(context, page);
    return { success: true, page };
  } catch (error) {
    await saveDebugScreenshot(page, 'login_error');
    return { success: false, error: error.message, page };
  }
}

export async function loginToMicrosoft365(page, email, password, context = null) {
  const targetUrl = 'https://admin.exchange.microsoft.com/#/mailboxes';
  const result = await ensureMicrosoftLogin(page, email, password, context, targetUrl);
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
