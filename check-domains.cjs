require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const OLD_TENANT_ID = '18fc47ed-26b7-45fd-8a88-933c18d44540';
const NEW_TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

console.log('CLIENT_ID:', MASTER_CLIENT_ID ? 'set' : 'UNDEFINED');
console.log('CLIENT_SECRET:', MASTER_CLIENT_SECRET ? 'set' : 'UNDEFINED');

async function getToken(tenantId) {
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

async function getDomainDetails(token, domain) {
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/domains/${domain}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function main() {
  console.log('=== Checking OLD tenant (ultraviol1) ===');
  const oldToken = await getToken(OLD_TENANT_ID);
  try {
    const oldDomain = await getDomainDetails(oldToken, DOMAIN);
    console.log('Domain status:', oldDomain.status);
    console.log('Is verified:', oldDomain.isVerified);
    console.log('Is initial:', oldDomain.isInitial);
    console.log('Supported services:', oldDomain.supportedServices);
  } catch (e) {
    console.log('Error:', e.response?.data?.error?.message || e.message);
  }

  console.log('\n=== Checking NEW tenant (meetsaasy) ===');
  const newToken = await getToken(NEW_TENANT_ID);
  try {
    const newDomain = await getDomainDetails(newToken, DOMAIN);
    console.log('Domain status:', newDomain.status);
    console.log('Is verified:', newDomain.isVerified);
    console.log('Is initial:', newDomain.isInitial);
    console.log('Supported services:', newDomain.supportedServices);
  } catch (e) {
    console.log('Error:', e.response?.data?.error?.message || e.message);
  }
}

main().catch(console.error);
