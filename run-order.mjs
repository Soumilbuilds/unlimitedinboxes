// Run a full order for the existing tenant
import { processOrder } from './server/services/orderProcessor.js';
import { getTenants, getOrders, createOrder } from './server/db/database.js';

const TENANT_ID = 311;
const DOMAIN = 'agencyexitpartners.com';

console.log('Checking tenant and order setup...');

// Get tenant details
const tenants = getTenants(1);
const tenant = tenants.find(t => t.id === TENANT_ID);

if (!tenant) {
  console.error(`Tenant ${TENANT_ID} not found`);
  process.exit(1);
}

console.log('Tenant found:', {
  id: tenant.id,
  domain: tenant.domain,
  admin_email: tenant.admin_email,
  has_mfa_secret: !!tenant.mfa_secret,
  cloudflare_zone_id: tenant.cloudflare_zone_id ? 'present' : 'missing',
  tenant_id: tenant.tenant_id ? 'present' : 'missing'
});

// Create a new order for this tenant
console.log('\nCreating new order...');
const orderResult = createOrder(TENANT_ID, 100, "Password123!", `Bulk order for ${DOMAIN}`, 1);

if (!orderResult) {
  console.error('Failed to create order');
  process.exit(1);
}

const orderId = typeof orderResult === 'object' && orderResult.lastInsertRowid
  ? orderResult.lastInsertRowid
  : orderResult;
console.log('Order created with ID:', orderId);

// Run the order
console.log('\nStarting order processing...\n');
processOrder(orderId, 1)
  .then(() => {
    console.log('\n✅ Order processing completed');
    const orders = getOrders(1);
    const finalOrder = orders.find(o => o.id === orderId);
    console.log('Final status:', finalOrder?.status);
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Order failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
