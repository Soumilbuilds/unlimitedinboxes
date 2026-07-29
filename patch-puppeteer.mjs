// Script to patch handleStaySignedIn
import fs from 'fs';
const file = '/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/puppeteer.js';
let content = fs.readFileSync(file, 'utf8');

const oldCode = `async function handleStaySignedIn(page) {
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
        sleep
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
}`;

const newCode = `async function handleStaySignedIn(page) {
  try {
    if (!page || page.isClosed()) return;
    await page.waitForFunction(
      () => {
        try {
          const url = window.location.href;
          return document.querySelector('#idSIButton9') ||
                 document.querySelector('input[value="Yes"]') ||
                 !url.includes('login.microsoftonline.com') ||
                 url.includes('ProcessAuth') || url.includes('SAS/');
        } catch (e) { return false; }
      },
      { timeout: 8000 }
    ).catch(() => {});
    if (!page || page.isClosed()) return;
    const checkbox = await page.$('input[name="DontShowAgain"]');
    if (checkbox) { try { await checkbox.click(); } catch {} }
    let yesBtn = null;
    try { yesBtn = await page.$('#idSIButton9'); } catch (e) {}
    if (!yesBtn) { try { yesBtn = await page.$('input[value="Yes"]'); } catch (e) {} }
    if (yesBtn) {
      try {
        console.log('Clicking Yes to stay signed in');
        await yesBtn.click();
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
          sleep
        ]);
      } catch (e) {}
      return;
    }
    const noBtn = await page.$('#idBtn_Back');
    if (noBtn) {
      try {
        await noBtn.click();
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
          sleep
        ]);
      } catch (e) {}
    }
  } catch {
    // ignore
  }
}`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✅ handleStaySignedIn patched successfully');
} else {
  console.log('❌ Could not find old code to replace');
}
