/**
 * Remediate kodekernel mailboxes - fix permissions so PlusVibe can connect.
 *
 * For each of the 4 tenants, this script:
 * 1. Enables SMTP AUTH via Exchange Admin Center (Puppeteer)
 * 2. Uses Graph API to assign Global Admin to every mailbox user
 * 3. Ensures sign-in is enabled and password is set
 */

const Database = require('better-sqlite3');

const CLIENT_ID = process.env.MASTER_CLIENT_ID;
const CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;

// Tenant data for kodekernel user (id: 121)
const TENANTS = [
  {
    tenantId: '2fda6f80-6b29-4659-a76e-d733d13b9850',
    tenantDbId: 276,
    adminEmail: 'admin@aurebyte.onmicrosoft.com',
    adminPassword: 'G&132447775184op',
    domain: 'kodekernelhq.us',
    orderId: 137,
    mailboxes: []
  },
  {
    tenantId: 'ab31d2a4-c30d-4b16-ba9f-68448554422b',
    tenantDbId: 281,
    adminEmail: 'admin@virexon1.onmicrosoft.com',
    adminPassword: 'B*607345348283ah',
    domain: 'kodekernelleads.us',
    orderId: 141,
    mailboxes: []
  },
  {
    tenantId: '879d5fd0-2a06-4a72-99de-bffa8e319674',
    tenantDbId: 287,
    adminEmail: 'admin@synergyeu.onmicrosoft.com',
    adminPassword: 'P$748748529444at',
    domain: 'kodekernel.us',
    orderId: 143,
    mailboxes: []
  },
  {
    tenantId: '18fc47ed-26b7-45fd-8a88-933c18d44540',
    tenantDbId: 290,
    adminEmail: 'admin@ultrava1.onmicrosoft.com',
    adminPassword: 'X^340224686220uv',
    domain: 'getkodekernel.us',
    orderId: 146,
    mailboxes: []
  }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadMailboxes(db) {
  for (const tenant of TENANTS) {
    const row = db.prepare("SELECT created_mailboxes FROM orders WHERE id = ?").get(tenant.orderId);
    if (row && row.created_mailboxes) {
      try {
        tenant.mailboxes = JSON.parse(row.created_mailboxes);
        console.log(`Loaded ${tenant.mailboxes.length} mailboxes for tenant ${tenant.tenantDbId} (${tenant.domain})`);
      } catch (e) {
        console.error(`Failed to parse mailboxes for tenant ${tenant.tenantDbId}:`, e.message);
        tenant.mailboxes = [];
      }
    } else {
      tenant.mailboxes = [];
    }
  }
}

async function remediateTenant(tenant) {
  console.log(`\n========== REMEDIATING TENANT: ${tenant.domain} ==========`);
  console.log(`  Admin: ${tenant.adminEmail}`);
  console.log(`  Tenant ID: ${tenant.tenantId}`);
  console.log(`  Mailboxes: ${tenant.mailboxes.length}`);

  const results = { smtpAuth: null, globalAdminCount: 0, errors: [] };

  // Load modules dynamically (ESM)
  const { createIncognitoPage, loginToMicrosoft365, ensureExchangeSmtpAuthEnabled } = await import('./server/services/puppeteer.js');
  const graphModule = await import('./server/services/graph.js');
  const {
    getDelegatedClient,
    enableSignInAndSetPasswordWithClient,
    assignGlobalAdminWithClient,
    getGlobalAdminRoleIdWithClient
  } = graphModule;

  // Step 1: Enable SMTP AUTH via Exchange Admin Center
  let browser = null;
  try {
    console.log('\n[1/3] Enabling SMTP AUTH via Exchange Admin Center...');
    browser = await createIncognitoPage();
    const page = browser;

    const loginResult = await loginToMicrosoft365(
      page,
      tenant.adminEmail,
      tenant.adminPassword,
      browser
    );
    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.error}`);
    }
    console.log('  Logged in to Exchange Admin Center');

    const smtpResult = await ensureExchangeSmtpAuthEnabled(page, msg => console.log('    SMTP:', msg));
    results.smtpAuth = smtpResult;
    if (smtpResult?.success === false) {
      console.log(`  SMTP AUTH WARNING: ${smtpResult.error}`);
    } else {
      console.log('  SMTP AUTH: OK');
    }
    await browser.close();
    browser = null;
  } catch (err) {
    console.error('  SMTP AUTH ERROR:', err.message);
    results.errors.push({ step: 'smtpAuth', error: err.message });
    if (browser) await browser.close().catch(() => {});
  }

  // Step 2: Assign Global Admin via Graph API
  let client = null;
  try {
    console.log('\n[2/3] Connecting to Graph API...');
    client = await getDelegatedClient(
      CLIENT_ID,
      CLIENT_SECRET,
      tenant.tenantId,
      tenant.adminEmail,
      tenant.adminPassword
    );
    console.log('  Graph API: OK');

    console.log('  Fetching Global Admin role ID...');
    const roleId = await getGlobalAdminRoleIdWithClient(client);
    console.log(`  Global Admin role ID: ${roleId}`);

    let gaCount = 0;
    for (let i = 0; i < tenant.mailboxes.length; i++) {
      const mailbox = tenant.mailboxes[i];
      const userId = mailbox.objectId;
      const email = mailbox.email;
      const password = mailbox.password || mailbox.passwordSet;

      if (!userId) {
        console.log(`  SKIP ${email}: no objectId`);
        continue;
      }

      try {
        // Ensure sign-in enabled and password set
        if (password) {
          try {
            await enableSignInAndSetPasswordWithClient(client, userId, password);
            console.log(`  OK: ${email} - sign-in enabled + password set`);
          } catch (e) {
            const msg = e.response?.data?.error?.message || e.message;
            console.log(`  WARN: ${email} - ${String(msg).slice(0, 80)}`);
          }
        }

        // Assign Global Admin
        try {
          await assignGlobalAdminWithClient(client, userId, roleId);
          console.log(`  OK: ${email} - Global Admin assigned`);
          gaCount++;
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          if (String(msg).toLowerCase().includes('already')) {
            console.log(`  OK: ${email} - already Global Admin`);
            gaCount++;
          } else {
            console.log(`  WARN: ${email} - Global Admin: ${String(msg).slice(0, 80)}`);
          }
        }
      } catch (err) {
        console.log(`  ERROR: ${email} - ${err.message}`);
      }

      if ((i + 1) % 25 === 0) {
        console.log(`  ... processed ${i + 1}/${tenant.mailboxes.length} ...`);
      }
    }

    results.globalAdminCount = gaCount;
  } catch (err) {
    console.error('  Graph API ERROR:', err.message);
    results.errors.push({ step: 'graphApi', error: err.message });
  }

  console.log(`\n========== TENANT ${tenant.domain} DONE ==========`);
  console.log(`  SMTP AUTH: ${results.smtpAuth?.changed ? 'ENABLED' : results.smtpAuth?.success === false ? 'FAILED' : 'Already was'}`);
  console.log(`  Global Admin: ${results.globalAdminCount}/${tenant.mailboxes.length}`);
  console.log(`  Errors: ${results.errors.length}`);

  return results;
}

async function main() {
  const dbPath = process.argv[2] || '/opt/unlimited-inboxes/shared/db/app.db';

  console.log('=== kodekernel Mailbox Remediation ===');
  console.log(`DB: ${dbPath}`);
  const db = new Database(dbPath);
  console.log('Loading mailboxes...');
  await loadMailboxes(db);

  const totalMailboxes = TENANTS.reduce((sum, t) => sum + t.mailboxes.length, 0);
  console.log(`Total mailboxes to process: ${totalMailboxes}\n`);

  const allResults = [];
  for (const tenant of TENANTS) {
    if (tenant.mailboxes.length === 0) {
      console.log(`Skipping tenant ${tenant.domain} - no mailboxes`);
      continue;
    }
    const r = await remediateTenant(tenant);
    allResults.push({ domain: tenant.domain, ...r });
    await sleep;
  }

  db.close();

  console.log('\n\n=== FINAL SUMMARY ===');
  for (const r of allResults) {
    console.log(`  ${r.domain}: SMTP ${r.smtpAuth?.changed ? 'ENABLED' : 'CHECK'}, GA: ${r.globalAdminCount}, Errors: ${r.errors.length}`);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});