import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config({ path: '/opt/unlimited-inboxes/shared/.env' });

const __dirname = dirname(fileURLToPath(import.meta.url));

const { createIncognitoPage, loginToSecurityCenter } = await import('./services/puppeteer.js');

const ADMIN_EMAIL = 'admin@meetsaasy.onmicrosoft.com';
const ADMIN_PASSWORD = 'K^611947986007os';

async function main() {
  console.log('=== DELETING USERS VIA AZURE PORTAL ===\n');

  console.log('Opening Azure Portal with admin credentials...');
  const { browser, page } = await createIncognitoPage();

  try {
    // Login to Azure Portal
    await page.goto('https://entra.microsoft.com', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000);

    // If not logged in, login
    const url = page.url();
    if (url.includes('login')) {
      console.log('Logging in to Azure...');
      await page.fill('input[type="email"]', ADMIN_EMAIL);
      await page.click('input[type="submit"]');
      await page.waitForTimeout;
      await page.fill('input[name="passwd"]', ADMIN_PASSWORD);
      await page.click('input[type="submit"]');
      await page.waitForTimeout;
    }

    console.log('Navigating to Users page...');
    await page.goto('https://entra.microsoft.com/#view/Microsoft_AAD_UsersManagement/UsersAllMenuBlade/~/AllUsers', { waitUntil: 'networkidle2' });
    await page.waitForTimeout;

    // Get initial user count
    const userCountText = await page.textContent('div[role="status"]') || '';
    console.log('Initial user count info:', userCountText);

    console.log('\nDeleting users...');
    console.log('(This would require selecting and deleting each user through the UI)');
    console.log('\nManual deletion recommended:');
    console.log('1. Go to https://entra.microsoft.com');
    console.log('2. Sign in with admin@meetsaasy.onmicrosoft.com');
    console.log('3. Go to Users > All users');
    console.log('4. Select all users except admin@meetsaasy.onmicrosoft.com');
    console.log('5. Click Delete');
    console.log('\nAlternatively, ask Microsoft to increase the directory quota.');

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);