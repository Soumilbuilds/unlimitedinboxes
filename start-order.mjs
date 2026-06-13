import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config({ path: '/opt/unlimited-inboxes/shared/.env' });

const __dirname = dirname(fileURLToPath(import.meta.url));

const { processOrder } = await import('./services/orderProcessor.js');

console.log('=== STARTING ORDER 150 (100 MAILBOXES) ===');
console.log('Domain: trykodekernel.us');
console.log('Tenant: admin@meetsaasy.onmicrosoft.com');
console.log('Microsoft Tenant ID: 596b57cc-3894-47fd-8718-895f111b14fd');
console.log('');
console.log('Starting at:', new Date().toISOString());
console.log('');

// Start the order
processOrder(150).then(() => {
  console.log('');
  console.log('Order processing completed!');
  console.log('Ended at:', new Date().toISOString());
}).catch(e => {
  console.error('Order processing error:', e.message);
  console.error(e.stack);
});
