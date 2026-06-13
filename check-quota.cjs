require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';

async function getAppToken(tenantId) {
  const params = new URLSearchParams();
  params.append('client_id', MASTER_CLIENT_ID);
  params.append('client_secret', MASTER_CLIENT_SECRET);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params
  );
  return res.data.access_token;
}

async function listUsers(token) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/users', {
    headers: { Authorization: `Bearer ${token}` },
    params: { '$top': 999 }
  });
  return res.data.value || [];
}

async function getTenantDetails(token) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/organization', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.value?.[0];
}

async function main() {
  console.log('=== CHECKING TENANT QUOTA ===\n');

  const token = await getAppToken(TENANT_ID);

  // Get tenant info
  const tenant = await getTenantDetails(token);
  console.log('Tenant:', tenant?.displayName);
  console.log('Tenant ID:', tenant?.id);

  // Count users
  const users = await listUsers(token);
  console.log('\nUsers in tenant:', users.length);
  console.log('\nUser list (first 20):');
  users.slice(0, 20).forEach((u, i) => {
    console.log(`  ${i + 1}. ${u.userPrincipalName} (${u.displayName})`);
  });

  if (users.length > 20) {
    console.log(`  ... and ${users.length - 20} more`);
  }
}

main().catch(console.error);