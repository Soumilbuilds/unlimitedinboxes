require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const NEW_TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

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

async function getDomain(token, domain) {
  const res = await axios.get(`https://graph.microsoft.com/v1.0/domains/${domain}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

async function main() {
  const token = await getAppToken(NEW_TENANT_ID);
  const domain = await getDomain(token, DOMAIN);
  console.log('=== FINAL DOMAIN STATUS ===');
  console.log('Domain:', domain.id);
  console.log('Verified:', domain.isVerified);
  console.log('Status:', domain.status);
  console.log('Services:', domain.supportedServices?.join(', ') || 'none');
}

main().catch(console.error);