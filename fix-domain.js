require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const OLD_TENANT_ID = '18fc47ed-26b7-45fd-8a88-933c18d44540';
const NEW_TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

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

async function listDomains(token) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/domains', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.value || [];
}

async function addDomain(token, tenantId, domain) {
  await axios.post(
    `https://graph.microsoft.com/v1.0/domains`,
    { id: domain },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function getVerificationRecords(token, domain) {
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/domains/${domain}/verificationDnsRecords`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.value || [];
}

async function verifyDomain(token, domain) {
  await axios.post(
    `https://graph.microsoft.com/v1.0/domains/${domain}/verify`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function deleteDomain(token, domain) {
  await axios.delete(
    `https://graph.microsoft.com/v1.0/domains/${domain}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function main() {
  console.log('=== Step 1: Check domains in OLD tenant (ultraviol1) ===');
  const oldToken = await getToken(OLD_TENANT_ID);
  const oldDomains = await listDomains(oldToken);
  console.log('Old tenant domains:', oldDomains.map(d => d.id).join(', '));

  const domainInOld = oldDomains.find(d => d.id === DOMAIN);
  if (domainInOld) {
    console.log(`Found ${DOMAIN} in old tenant`);
    console.log('Domain status:', domainInOld.status);

    if (domainInOld.status === 'verified') {
      console.log('Domain is verified - attempting to delete...');
      try {
        await deleteDomain(oldToken, DOMAIN);
        console.log('Domain deleted from old tenant!');
      } catch (e) {
        console.error('Delete failed:', e.response?.data?.error?.message || e.message);
        console.log('Manual intervention may be needed in Azure portal');
      }
    }
  } else {
    console.log(`Domain ${DOMAIN} not found in old tenant`);
  }

  console.log('\n=== Step 2: Check domains in NEW tenant (meetsaasy) ===');
  const newToken = await getToken(NEW_TENANT_ID);
  const newDomains = await listDomains(newToken);
  console.log('New tenant domains:', newDomains.map(d => d.id).join(', '));

  const domainInNew = newDomains.find(d => d.id === DOMAIN);
  if (domainInNew) {
    console.log(`Domain ${DOMAIN} already exists in new tenant, status:`, domainInNew.status);
    if (domainInNew.status === 'verified') {
      console.log('Domain is already verified - nothing to do!');
    }
  } else {
    console.log(`Domain ${DOMAIN} not in new tenant - adding...`);
    try {
      await addDomain(newToken, NEW_TENANT_ID, DOMAIN);
      console.log('Domain added to new tenant!');

      // Get verification records
      console.log('Getting verification TXT records...');
      await new Promise(r => setTimeout(r, 3000));
      const records = await getVerificationRecords(newToken, DOMAIN);
      const txtRecord = records.find(r => r.recordType === 'TXT');
      if (txtRecord) {
        console.log('TXT record needed:', { name: txtRecord.name, text: txtRecord.text });
        console.log('Note: These records should be in Cloudflare DNS');
      }
    } catch (e) {
      console.error('Add failed:', e.response?.data?.error?.message || e.message);
    }
  }
}

main().catch(console.error);
