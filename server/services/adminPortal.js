import { ensureMicrosoftLogin } from './puppeteer.js';

const ADMIN_PORTAL_URL = 'https://admin.cloud.microsoft/#/homepage';
const ADMIN_PORTAL_FALLBACK_URL = 'https://admin.microsoft.com/#/homepage';
const GLOBAL_ADMIN_ROLE_ID = '62e90394-69f5-4237-9190-012177145e10';
const MAC_APP_ID = '2e97b156-5cb7-4188-8d77-6954a2ac07aa';
const MAC_VERSION = 'host-mac_2026.1.15.3';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ROLE_IDS = [
  '11648597-926c-4cf3-9c36-bcebb0ba8dcc',
  'eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c',
  '74ef975b-6605-40af-a5d2-b9539d836353',
  '0964bb5e-9bdb-4d7b-ac29-58e794862a40',
  '8835291a-918c-4fd7-a9ce-faa49f0cf7d9',
  '0526716b-113d-4c15-b2c8-68e3c22b9f80',
  'fdd7a751-b60b-444a-984c-02652fe8fa1c',
  '2b745bdf-0803-4d80-aa65-822c4493daac',
  'd37c8bed-0711-4417-ba38-b4abe66ce4c2',
  '31e939ad-9672-4796-9c2e-873181342d2d',
  'b5a8dcf3-09d5-43a9-a639-8e29ef291470',
  '744ec460-397e-42ad-a462-8b3f9747a02c',
  'd2562ede-74db-457e-a7b6-544e236ebb61',
  '31392ffb-586c-42d1-9346-e59415a2cc4e',
  '45d8d3c5-c802-45c6-b32a-1d70b5e1e86e',
  '892c5842-a9a6-463a-8041-72aa08ca3cf6',
  '32696413-001a-46ae-978c-ce0f6b3620d2',
  '810a2642-a034-447f-a5e8-41beaa378541',
  'e300d9e7-4a2b-4295-9eff-f1c78b36cc98',
  '25df335f-86eb-4119-b717-0ff02de207e9',
  '92b086b3-e367-4ef2-b869-1de128fb986e',
  '1a7d78b6-429f-476b-b8eb-35fb715fffd4',
  '1707125e-0aa2-4d4d-8655-a7c786c76a25',
  '9d70768a-0cbc-4b4c-aea3-2e124b2477f4',
  '9d3e04ba-3ee4-4d1b-a3a7-9aef423a09be',
  '49eb8f75-97e9-4e37-9b2b-6c3ebfcffa31',
  '99009c4a-3b3f-4957-82a9-9d35e12db77e',
  '29232cdf-9323-42fd-ade2-1d097af3e4de',
  'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
  '75941009-915a-4869-abe7-691bff18279e',
  '44367163-eba1-44c3-98af-f5787879f96a',
  'a9ea8996-122f-4c74-9520-8edcd192826c',
  '11451d60-acb2-45eb-a7d6-43d0f0125c13',
  '3a2c62db-5318-420d-8d74-23affee5d9d5',
  '7698a772-787b-4ac8-901f-60d6b08affd2',
  '38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4',
  'e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477',
  '644ef478-e28f-4e28-b9dc-3fdde9aa0b1f',
  GLOBAL_ADMIN_ROLE_ID,
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  'cf1c38e5-3621-4004-a7cb-879624dced7c',
  '8329153b-31d0-4727-b945-745eb3bc5f31',
  '158c047a-c907-4556-b7ef-446551a6b5f7',
  'be2f45a1-457d-42af-a067-6ec1fa63bc45',
  '966707d0-3269-4727-9be2-8c3a10f19b9d',
  '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
  '729827e3-9c14-49f7-bb1b-9608f156bbb8',
  'e8611ab8-c189-46e8-94e1-60213ab1f814',
  '4d6ac14f-3453-41d0-bef9-a3e0c569773a',
  'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
  'c4e39bd9-1100-46d3-8c65-fb160da0071f',
  '8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2',
  'fe930be7-5e62-47db-91af-98c3a49a38b1',
  '95e79109-95c0-4d8e-aee3-d01accf2d47b',
  '024906de-61e5-49c8-8572-40335f1e0e10',
  '27460883-1df1-4691-b032-3b79643e5e63',
  '507f53e4-4e52-4077-abd3-d2e1558b6ea2',
  '3f1acade-1e04-4fbc-9b69-f0302cd84aef',
  'b0f54661-2d74-4c50-afa3-1ec803f12efe',
  '963797fb-eb3b-4cde-8ce3-5878b3f32a3f',
  '8c8b803f-96e1-4129-9349-20738d9f9652',
  '281fe777-fb20-4fbb-b7a3-ccebce5b0d96',
  '92ed04bf-c94a-4b82-9729-b799a7a4c178',
  'e48398e2-f4bb-4074-8f31-4586725e205b',
  'f023fd81-a637-4b56-95fd-791ac0226033',
  '0ec3f692-38d6-4d14-9e69-0377ca7797ad',
  '87761b17-1ed2-4af3-9acd-92a150038160',
  '1501b917-7653-4ff9-a4b5-203eaf33784f',
  '1d336d2c-4ae8-42ef-9711-b3604ce3fc2c',
  '25a516ed-2fa0-40ea-a2d0-12923a21473a',
  'ffd52fa5-98dc-465c-991d-fc073eb59f8f',
  'e93e3737-fa85-474a-aee4-7d3fb86510f3',
  '58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d',
  '8424c6f0-a189-499e-bbd0-26c1753c96d4',
  '5d6b6bb7-de71-4623-b4af-96380a352509',
  '790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b',
  'ac16e43d-7b2d-40e0-ac05-243ff356ab5b',
  '4a5d8f65-41da-4de4-8968-e035b65339cf',
  '75934031-6c7e-415a-99d7-48dbd49e875e',
  'f2ef992c-3afb-46b9-b7cf-a126ee74c451',
  '17315797-102d-40b4-93e0-432062caca18',
  '5f2222b1-57c3-48ba-8ad5-d4759f1fde6f',
  '9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f',
  '5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91',
  'e6d1a23a-da11-4be4-9570-befc86d067a7',
  '194ae4cb-b126-40b2-bd5b-6091b380977d',
  'c430b396-e693-46cc-96f3-db01bf8bb62a',
  '7495fdc4-34c4-4d15-a289-98788ce399fd'
];

function buildRoleAssignments() {
  return ROLE_IDS.map(roleId => ({
    RoleId: roleId,
    IsAssigned: roleId === GLOBAL_ADMIN_ROLE_ID,
    ResourceScopes: ['/'],
    RoleAssignmentId: '',
    AssignmentState: 'Active'
  }));
}

async function adminApiRequest(page, path, method, body, adminRequestPath) {
  return page.evaluate(async ({ path, method, body, adminRequestPath }) => {
    const url = `https://admin.cloud.microsoft${path}`;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-ms-mac-hostingapp': 'M365AdminPortal',
      'x-ms-mac-target-app': 'MAC',
      'x-ms-mac-appid': '2e97b156-5cb7-4188-8d77-6954a2ac07aa',
      'x-ms-mac-version': 'host-mac_2026.1.15.3'
    };

    if (adminRequestPath) {
      headers['x-adminapp-request'] = adminRequestPath;
    }

    const cookies = document.cookie || '';
    const ajaxMatch = cookies.match(/s\\.AjaxSessionKey=([^;]+)/);
    if (ajaxMatch?.[1]) {
      headers.ajaxsessionkey = decodeURIComponent(ajaxMatch[1]);
    }

    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore non-json
    }
    return { ok: res.ok, status: res.status, text, json };
  }, { path, method, body, adminRequestPath });
}

function formatAdminError(result) {
  const message =
    result?.json?.Message ||
    result?.json?.error?.message ||
    result?.json?.message ||
    result?.text ||
    'Unknown error';
  return `${result?.status || 'ERR'}: ${message}`;
}

async function waitForAdminReady(page) {
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 });

  await page.waitForFunction(() => {
    const hasNav = !!document.querySelector('nav');
    const hasSidebar = !!document.querySelector('[data-automation-id="NavigationMenu"], [data-automation-id="LeftNav"]');
    const hasAppRoot = !!document.querySelector('#root, #app, [role="main"]');
    const text = (document.body && (document.body.innerText || '').trim()) || '';
    return hasNav || hasSidebar || hasAppRoot || text.length > 20;
  }, { timeout: 60000 });
}

export async function ensureAdminPortal(page, email, password, context = null) {
  const login = await ensureMicrosoftLogin(page, email, password, context, ADMIN_PORTAL_URL);
  if (!login.success) return login;

  const appPage = login.page || page;
  appPage.setDefaultTimeout(60000);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      try { await appPage.setCacheEnabled(false); } catch { }
      for (const url of [ADMIN_PORTAL_URL, ADMIN_PORTAL_FALLBACK_URL]) {
        try {
          await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(3000);
          await waitForAdminReady(appPage);
          return { success: true, page: appPage };
        } catch {
          // try next url
        }
      }
      await sleep(3000);
    } catch (e) {
      try {
        await appPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
      } catch {
        // ignore
      }
    }
  }

  return { success: false, error: 'Admin portal not fully ready (blank or missing AjaxSessionKey)', page: appPage };
}

export async function updateUserUpn(page, userId, upn) {
  const result = await adminApiRequest(
    page,
    '/admin/api/users/emailaddressesupn',
    'PUT',
    { HasChangeOnUpn: true, ObjectId: userId, UserPrincipalName: upn },
    `/users/:/UserDetails/${userId}`
  );

  if (!result.ok) {
    return { success: false, status: result.status, error: formatAdminError(result) };
  }
  return { success: true, status: result.status };
}

export async function unblockSignIn(page, userId) {
  const result = await adminApiRequest(
    page,
    `/admin/api/users/${userId}/signinstatus?isAllowed=true`,
    'PUT',
    {},
    `/users/:/BlockUser/${userId}`
  );

  if (!result.ok) {
    return { success: false, status: result.status, error: formatAdminError(result) };
  }
  return { success: true, status: result.status };
}

export async function resetPassword(page, userId, password) {
  const result = await adminApiRequest(
    page,
    '/admin/api/users/passwordreset',
    'PUT',
    {
      NotifyResetPassword: false,
      ForceChangePassword: false,
      UserId: [userId],
      Password: password
    },
    `/users/:/UserDetails/${userId}`
  );

  if (!result.ok) {
    return { success: false, status: result.status, error: formatAdminError(result) };
  }
  return { success: true, status: result.status };
}

export async function assignGlobalAdmin(page, userId) {
  const result = await adminApiRequest(
    page,
    '/admin/api/users/setuserroles',
    'PUT',
    {
      PrincipalId: userId,
      AssignedRoles: buildRoleAssignments(),
      ExistingRoleAssignments: [],
      ExistingAzureRoleAssignments: [],
      AllUserSecurityGroupsInTenant: [],
      UserSecurityGroupsToBeAssignedToUser: [],
      NoAdminRoleAssigned: false
    },
    `/users/:/managerbacroles/userDetail/${userId}/roleAssignments`
  );

  if (!result.ok) {
    return { success: false, status: result.status, error: formatAdminError(result) };
  }
  return { success: true, status: result.status };
}
