// Test the MFA login flow with the actual tenant credentials
import { loginToMicrosoft365, createIncognitoPage, closeBrowser } from './server/services/puppeteer.js';
import { generateTotpCode, isValidTotpSecret } from './server/services/totp.js';

const ADMIN_EMAIL = 'admin@securemailcloud.onmicrosoft.com';
const ADMIN_PASSWORD = process.env.TENANT_ADMIN_PASSWORD || 'CloUd#81mX!pR6zQ';
const MFA_SECRET = process.env.TENANT_MFA_SECRET || 'gzrxzxt7whqlvpfd';

console.log('Testing MFA login flow...');
console.log('Email:', ADMIN_EMAIL);
console.log('MFA Secret valid:', isValidTotpSecret(MFA_SECRET));
console.log('Generated code:', generateTotpCode(MFA_SECRET));

const getTotpCode = () => {
  const code = generateTotpCode(MFA_SECRET);
  console.log(`[TOTP] Generated code: ${code}`);
  return code;
};

(async () => {
  try {
    const { context, page } = await createIncognitoPage();
    page.setDefaultTimeout;

    console.log('\nAttempting login...');
    const result = await loginToMicrosoft365(page, ADMIN_EMAIL, ADMIN_PASSWORD, context, getTotpCode);

    if (result.success) {
      console.log('\n✅ LOGIN SUCCESSFUL!');
      console.log('Final URL:', result.page.url());
    } else {
      console.log('\n❌ LOGIN FAILED');
      console.log('Error:', result.error);
      console.log('Current URL:', result.page.url());
    }

    await closeBrowser(context);
  } catch (error) {
    console.error('\n💥 EXCEPTION:', error.message);
    console.error(error.stack);
  }
})();
