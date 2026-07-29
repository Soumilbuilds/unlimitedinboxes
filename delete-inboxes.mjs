import { getTenants, getOrderById } from './server/db/database.js';
import { deleteUserByEmail } from './server/services/graph.js';

const TENANT_ID = 311;
const tenant = getTenants(1).find(t => t.id === TENANT_ID);
if (!tenant) {
  console.error('Tenant not found');
  process.exit(1);
}

const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, MASTER_TENANT_ID } = process.env;
if (!MASTER_CLIENT_ID || !MASTER_CLIENT_SECRET) {
  console.error('Missing MASTER_CLIENT_ID / MASTER_CLIENT_SECRET in env');
  process.exit(1);
}

const clientId = MASTER_CLIENT_ID;
const clientSecret = MASTER_CLIENT_SECRET;
const tenantId = tenant.tenant_id;

console.log('Deleting 5 existing inboxes from tenant', tenantId);

// Get list of mailboxes from order 164 (the successful one)
const order = getOrderById(164);
if (!order) {
  console.error('Order 164 not found');
  process.exit(1);
}

const mailboxes = JSON.parse(order.created_mailboxes || '[]');
console.log('Found', mailboxes.length, 'mailboxes to delete');

for (const m of mailboxes) {
  try {
    console.log(`Deleting ${m.email}...`);
    const result = await deleteUserByEmail(clientId, clientSecret, tenantId, m.email);
    if (result.success) {
      console.log(`  ✅ Deleted ${m.email} (id: ${result.userId})`);
    } else {
      console.log(`  ⚠️  ${m.email}: ${result.reason}`);
    }
  } catch (e) {
    console.log(`  ❌ ${m.email}: ${e.message}`);
  }
}

console.log('Done');
process.exit(0);
