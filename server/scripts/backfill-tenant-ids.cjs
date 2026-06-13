// One-time backfill script: discovers and persists Microsoft tenant IDs
// for existing tenants that have a NULL tenant_id.
//
// Usage: node server/scripts/backfill-tenant-ids.cjs
//
// Requires the server DB to be at server/db/app.db (or whatever DATABASE_PATH
// the database module loads). Run from the project root.

const path = require('path');

// Make sure relative imports in the database module resolve correctly
process.chdir(path.join(__dirname, '..'));

(async () => {
  try {
    const { getTenants, updateTenantId } = await import('../db/database.js');
    const { discoverMicrosoftTenantId } = await import('../services/tenantDiscovery.js');

    const allTenants = getTenants();
    const needingBackfill = allTenants.filter(
      (t) => !t.tenant_id && t.admin_email
    );

    console.log(
      `[backfill] Found ${allTenants.length} total tenants, ${needingBackfill.length} need backfill`
    );

    if (needingBackfill.length === 0) {
      console.log('[backfill] Nothing to do.');
      return;
    }

    let backfilled = 0;
    let failed = 0;

    for (let i = 0; i < needingBackfill.length; i += 1) {
      const tenant = needingBackfill[i];
      process.stdout.write(
        `[backfill] [${i + 1}/${needingBackfill.length}] tenant ${tenant.id} (${tenant.admin_email})... `
      );

      try {
        const guid = await discoverMicrosoftTenantId(tenant.admin_email);
        if (guid) {
          updateTenantId(tenant.id, guid);
          backfilled += 1;
          console.log(`OK -> ${guid}`);
        } else {
          failed += 1;
          console.log('SKIP (no tenant ID found)');
        }
      } catch (err) {
        failed += 1;
        console.log(`ERR (${err.message})`);
      }

      // Light pacing so we don't hammer the discovery endpoint
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log(
      `[backfill] Done. Backfilled ${backfilled}/${needingBackfill.length} tenants (${failed} failed).`
    );
  } catch (error) {
    console.error('[backfill] Fatal error:', error);
    process.exitCode = 1;
  }
})();