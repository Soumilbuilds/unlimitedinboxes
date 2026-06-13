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

async function verifyDomain(token, domain) {
  await axios.post(`https://graph.microsoft.com/v1.0/domains/${domain}/verify`, {}, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function getServiceConfig(token, domain) {
  const res = await axios.get(`https://graph.microsoft.com/v1.0/domains/${domain}/serviceConfigurationRecords`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.value || [];
}

async function getVerificationDns(token, domain) {
  const res = await axios.get(`https://graph.microsoft.com/v1.0/domains/${domain}/verificationDnsRecords`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.value || [];
}

async function main() {
  console.log('=== VERIFY DOMAIN IN NEW TENANT ===\n');

  const token = await getAppToken(NEW_TENANT_ID);
  console.log('Got app token for meetsaasy tenant');

  // Check domain status
  const domain = await getDomain(token, DOMAIN);
  console.log(`Domain: ${domain.id}`);
  console.log(`Verified: ${domain.isVerified}`);
  console.log(`Services: ${domain.supportedServices?.join(', ') || 'none'}`);

  if (domain.isVerified) {
    console.log('\nDomain is already verified!');
  } else {
    console.log('\nDomain not verified - attempting verification...');
    try {
      await verifyDomain(token, DOMAIN);
      console.log('Verification requested successfully!');

      // Wait and get service configuration
      console.log('Waiting for DNS propagation...');
      await new Promise(r => setTimeout(r, 5000));

      const config = await getServiceConfig(token, DOMAIN);
      if (config.length > 0) {
        console.log('\nService configuration records:');
        config.forEach(r => {
          console.log(`  ${r.recordType}: ${r.label || r.name} -> ${r.text || r.mailExchange || r.value}`);
        });
      }

      // Check verification DNS records
      const verDns = await getVerificationDns(token, DOMAIN);
      const txt = verDns.find(r => r.recordType === 'TXT');
      if (txt) {
        console.log('\nTXT Verification Record:');
        console.log(`  Name: ${txt.name}`);
        console.log(`  Text: ${txt.text}`);
      }
    } catch (e) {
      console.log('Error:', e.response?.data?.error?.message || e.message);
    }
  }

  // Check if domain has Exchange services
  if (domain.supportedServices?.includes('Email')) {
    console.log('\nDomain has Email service enabled - ready for mailboxes!');
  }
}

main().catch(console.error);