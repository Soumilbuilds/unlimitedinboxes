import axios from 'axios';

/**
 * Discover the Microsoft tenant ID from an admin email or domain.
 * Uses OpenID discovery endpoint which is public and requires no auth.
 *
 * @param {string} emailOrDomain - Admin email (e.g. "admin@contoso.onmicrosoft.com") or just domain
 * @returns {Promise<string|null>} - The tenant GUID or null if not found
 */
export async function discoverMicrosoftTenantId(emailOrDomain) {
  if (!emailOrDomain || typeof emailOrDomain !== 'string') {
    return null;
  }

  // Extract domain from email if needed
  let domain = emailOrDomain;
  const atIndex = emailOrDomain.indexOf('@');
  if (atIndex !== -1) {
    domain = emailOrDomain.substring(atIndex + 1);
  }

  // Validate domain has some TLD-like structure
  if (!domain || !domain.includes('.')) {
    return null;
  }

  try {
    const url = `https://login.microsoftonline.com/${domain}/v2.0/.well-known/openid-configuration`;
    const response = await axios.get(url, {
      timeout: 10000,
      validateStatus: (status) => status < 500
    });

    if (response.status !== 200 || !response.data?.issuer) {
      return null;
    }

    // Issuer format: https://login.microsoftonline.com/{tenant-guid}/v2.0
    const issuer = response.data.issuer;
    const match = issuer.match(/^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]+)\/v2\.0$/i);

    if (match && match[1]) {
      return match[1];
    }

    return null;
  } catch (error) {
    // Log the failure for debugging but don't throw
    console.error('[tenantDiscovery] Failed to discover tenant ID:', error.message);
    return null;
  }
}