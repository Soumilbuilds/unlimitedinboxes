import axios from 'axios';

async function getAccessToken(clientId, clientSecret, tenantId) {
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params,
    { timeout: 30000 }
  );
  return res.data.access_token;
}

async function getDelegatedAccessToken(clientId, clientSecret, tenantId, username, password) {
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  if (clientSecret) {
    params.append('client_secret', clientSecret);
  }
  params.append('grant_type', 'password');
  params.append('username', username);
  params.append('password', password);
  params.append(
    'scope',
    [
      'https://graph.microsoft.com/User.ReadWrite.All',
      'https://graph.microsoft.com/Directory.ReadWrite.All',
      'https://graph.microsoft.com/RoleManagement.ReadWrite.Directory'
    ].join(' ')
  );

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params,
    { timeout: 30000 }
  );
  return res.data.access_token;
}

function graphClient(token) {
  return axios.create({
    baseURL: 'https://graph.microsoft.com/v1.0',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000
  });
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

export async function getDelegatedClient(clientId, clientSecret, tenantId, username, password) {
  const token = await getDelegatedAccessToken(clientId, clientSecret, tenantId, username, password);
  return graphClient(token);
}

export async function getAppClient(clientId, clientSecret, tenantId) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  return graphClient(token);
}

export async function getInitialDomainWithClient(client) {
  const res = await client.get('/domains');
  const domains = res.data?.value || [];
  const initial = domains.find(d => d.isInitial) || domains.find(d => d.isDefault && String(d.id || '').endsWith('.onmicrosoft.com'));
  return initial?.id || null;
}

export async function getInitialDomain(clientId, clientSecret, tenantId) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);
  return getInitialDomainWithClient(client);
}

export async function enableSignInAndSetPasswordWithClient(client, userId, password) {
  await client.patch(`/users/${userId}`, {
    accountEnabled: true,
    passwordProfile: {
      forceChangePasswordNextSignIn: false,
      forceChangePasswordNextSignInWithMfa: false,
      password
    }
  });
}

export async function updateUserUpnWithClient(client, userId, upn) {
  await client.patch(`/users/${userId}`, { userPrincipalName: upn });
}

export async function getGlobalAdminRoleIdWithClient(client) {
  const rolesRes = await client.get('/directoryRoles');
  let adminRole = rolesRes.data.value.find(r => r.displayName === 'Global Administrator');

  if (!adminRole) {
    const templatesRes = await client.get('/directoryRoleTemplates');
    const template = templatesRes.data.value.find(r => r.displayName === 'Global Administrator');
    if (template) {
      const activateRes = await client.post('/directoryRoles', { roleTemplateId: template.id });
      adminRole = activateRes.data;
    }
  }

  if (!adminRole) throw new Error('Could not find Global Administrator role');
  return adminRole.id;
}

export async function assignGlobalAdminWithClient(client, userId, roleId) {
  try {
    await client.post(`/directoryRoles/${roleId}/members/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`
    });
  } catch (e) {
    const status = e.response?.status;
    const message = e.response?.data?.error?.message || '';
    const normalized = String(message).toLowerCase();
    if ((status === 400 || status === 409) && normalized.includes('already')) {
      return;
    }
    throw e;
  }
}

export async function addDomainToMicrosoft(clientId, clientSecret, tenantId, domain) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);

  try {
    await client.post('/domains', { id: domain });
  } catch (e) {
    if (e.response?.status !== 400 && e.response?.status !== 409) throw e;
  }

  let verificationRes = null;
  let attempts = 0;
  while (attempts < 5) {
    try {
      verificationRes = await client.get(`/domains/${domain}/verificationDnsRecords`);
      break;
    } catch (e) {
      if (e.response?.status === 404) {
        // Domain can take a moment to appear after creation
        await new Promise(r => setTimeout(r, 2000));
        attempts += 1;
        continue;
      }
      throw e;
    }
  }

  if (!verificationRes) {
    throw new Error('Domain verification records not available yet (404). Try again in a minute.');
  }

  const txtRecord = verificationRes.data.value.find(r => r.recordType === 'Txt');

  if (!txtRecord) throw new Error('No TXT verification record found from Microsoft');

  return {
    txt_text: txtRecord.text,
    txt_name: '@',
    ttl: 3600
  };
}

export async function verifyDomain(clientId, clientSecret, tenantId, domain) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);

  try {
    await client.post(`/domains/${domain}/verify`, {});
  } catch (e) {
    const message = e.response?.data?.error?.message || e.message || '';
    const normalized = String(message).toLowerCase();
    if (!normalized.includes('already verified')) {
      throw new Error(`Verification Failed: ${message}`);
    }
  }

  await new Promise(r => setTimeout(r, 5000));
  const configRes = await client.get(`/domains/${domain}/serviceConfigurationRecords`);
  const records = Array.isArray(configRes.data?.value) ? configRes.data.value : [];
  const exchangeRecords = records.filter(r => (r.service || '').toLowerCase() === 'exchange');
  return { success: true, records: exchangeRecords.length ? exchangeRecords : records };
}

export async function listDomains(clientId, clientSecret, tenantId) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);
  const res = await client.get('/domains');
  return res.data?.value || [];
}

export async function deleteDomain(clientId, clientSecret, tenantId, domain) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);
  await client.delete(`/domains/${domain}`);
}

export async function getUserByEmail(clientId, clientSecret, tenantId, email) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);

  const safeEmail = escapeODataString(email);
  const resUpn = await client.get(`/users?$filter=userPrincipalName eq '${safeEmail}'`);
  if (resUpn.data.value[0]) return resUpn.data.value[0];

  const resMail = await client.get(`/users?$filter=mail eq '${safeEmail}'`);
  return resMail.data.value[0];
}

export async function getUserByEmailWithClient(client, email) {
  const safeEmail = escapeODataString(email);
  const resUpn = await client.get(`/users?$filter=userPrincipalName eq '${safeEmail}'`);
  if (resUpn.data.value[0]) return resUpn.data.value[0];

  const resMail = await client.get(`/users?$filter=mail eq '${safeEmail}'`);
  return resMail.data.value[0];
}

export async function enableSignInAndSetPassword(clientId, clientSecret, tenantId, userId, password) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);

  await client.patch(`/users/${userId}`, {
    accountEnabled: true,
    passwordProfile: {
      forceChangePasswordNextSignIn: false,
      forceChangePasswordNextSignInWithMfa: false,
      password
    }
  });
}

export async function waitForUserByEmail(clientId, clientSecret, tenantId, email, attempts = 8, delayMs = 3000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const user = await getUserByEmail(clientId, clientSecret, tenantId, email);
      if (user) return user;
    } catch (e) {
      // ignore intermittent graph errors
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

export async function waitForUserByEmailWithClient(client, email, attempts = 8, delayMs = 3000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const user = await getUserByEmailWithClient(client, email);
      if (user) return user;
    } catch {
      // ignore intermittent graph errors
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

export async function assignGlobalAdmin(clientId, clientSecret, tenantId, userId) {
  const token = await getAccessToken(clientId, clientSecret, tenantId);
  const client = graphClient(token);

  const rolesRes = await client.get('/directoryRoles');
  let adminRole = rolesRes.data.value.find(r => r.displayName === 'Global Administrator');

  if (!adminRole) {
    const templatesRes = await client.get('/directoryRoleTemplates');
    const template = templatesRes.data.value.find(r => r.displayName === 'Global Administrator');
    if (template) {
      const activateRes = await client.post('/directoryRoles', { roleTemplateId: template.id });
      adminRole = activateRes.data;
    }
  }

  if (!adminRole) throw new Error('Could not find Global Administrator role');

  try {
    await client.post(`/directoryRoles/${adminRole.id}/members/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`
    });
  } catch (e) {
    const status = e.response?.status;
    const message = e.response?.data?.error?.message || '';
    const normalized = String(message).toLowerCase();
    if ((status === 400 || status === 409) && normalized.includes('already')) {
      return;
    }
    throw e;
  }
}
