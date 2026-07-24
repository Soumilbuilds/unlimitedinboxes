import axios from 'axios';
import {
 buildTotpResolver,
 completeMicrosoftDeviceCodeFlow,
 createIncognitoPage
} from './puppeteer.js';

const EXCHANGE_ONLINE_APP_ID = '00000002-0000-0ff1-ce00-000000000000';
const GRAPH_COMMAND_LINE_APP_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const GRAPH_SCOPE = 'https://graph.microsoft.com/Application.ReadWrite.All';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function graphClient(accessToken) {
 return axios.create({
 baseURL: 'https://graph.microsoft.com/v1.0',
 headers: { Authorization: `Bearer ${accessToken}` },
 timeout: 30000
 });
}

async function requestDeviceCode(tenantId) {
 const params = new URLSearchParams({
 client_id: GRAPH_COMMAND_LINE_APP_ID,
 scope: `${GRAPH_SCOPE} offline_access openid profile`
 });
 const response = await axios.post(
 `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`,
 params,
 { timeout: 30000 }
 );
 return response.data;
}

async function pollDeviceToken(tenantId, deviceCode) {
 const deadline = Date.now() + (Number(deviceCode.expires_in || 900) * 1000);
 const interval = Math.max(5, Number(deviceCode.interval || 5)) * 1000;
 while (Date.now() < deadline) {
 await sleep(interval);
 const params = new URLSearchParams({
 grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
 client_id: GRAPH_COMMAND_LINE_APP_ID,
 device_code: deviceCode.device_code
 });
 try {
 const response = await axios.post(
 `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
 params,
 { timeout: 30000 }
 );
 return response.data.access_token;
 } catch (error) {
 const code = error.response?.data?.error;
 if (code === 'authorization_pending' || code === 'slow_down') continue;
 throw new Error(error.response?.data?.error_description || error.message);
 }
 }
 throw new Error('Microsoft device authorization expired before it completed');
}

export function isMissingExchangeServicePrincipalError(error) {
 const text = String(error?.message || error || '');
 return /AADSTS650052/i.test(text) && text.includes(EXCHANGE_ONLINE_APP_ID);
}

export async function ensureExchangeOnlineServicePrincipal({
 tenantId,
 email,
 password,
 mfaSecret,
 getTotpCode,
 log = () => {}
}) {
 let context;
 let page;
 try {
 log('Microsoft tenant is missing Exchange Online; starting one-time service bootstrap...');
 const deviceCode = await requestDeviceCode(tenantId);
 const browser = await createIncognitoPage();
 context = browser.context;
 page = browser.page;
 const browserResult = await completeMicrosoftDeviceCodeFlow({
 page,
 context,
 verificationUri: deviceCode.verification_uri,
 userCode: deviceCode.user_code,
 email,
 password,
 getTotpCode: getTotpCode || buildTotpResolver(mfaSecret),
 mfaSecret
 });
 if (!browserResult.success) {
 throw new Error(browserResult.error);
 }

 const accessToken = await pollDeviceToken(tenantId, deviceCode);
 const client = graphClient(accessToken);
 const filter = encodeURIComponent(`appId eq '${EXCHANGE_ONLINE_APP_ID}'`);
 const existing = await client.get(
 `/servicePrincipals?$filter=${filter}&$select=id,appId,displayName`
 );
 if (existing.data?.value?.length) {
 log('Exchange Online service principal is already present.');
 return existing.data.value[0];
 }

 try {
 const created = await client.post('/servicePrincipals', {
 appId: EXCHANGE_ONLINE_APP_ID
 });
 log('Exchange Online service principal created successfully.');
 return created.data;
 } catch (error) {
 const message = error.response?.data?.error?.message || error.message;
 if (/already exists|conflicting object/i.test(String(message))) {
 log('Exchange Online service principal appeared during bootstrap.');
 return { appId: EXCHANGE_ONLINE_APP_ID };
 }
 throw new Error(`Could not create Exchange Online service principal: ${message}`);
 }
 } finally {
 if (page && !page.isClosed()) {
 try { await page.close(); } catch { /* ignore */ }
 }
 if (context) {
 try { await context.close(); } catch { /* ignore */ }
 }
 }
}
