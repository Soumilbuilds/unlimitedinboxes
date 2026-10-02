const ERRORS = Object.freeze({
  UNAUTHORIZED: [401, 'Sign in to continue.'],
  NOT_FOUND: [404, 'Order not found.'],
  BILLING_REQUIRED: [403, 'An active subscription is required. Get access to continue.'],
  INBOX_LIMIT_REACHED: [403, 'This order exceeds your inbox allowance. Upgrade your plan or request fewer inboxes.'],
  ORDER_CONCURRENCY_LIMIT: [409, 'Another order is processing. Wait for it to finish, then try again.'],
  DOMAIN_UNAVAILABLE: [409, 'This domain is already in use. Choose another domain or continue its existing order.'],
  INVALID_DOMAIN: [400, 'Enter a valid domain, such as example.com.'],
  INVALID_MAILBOX_NAMES: [400, 'Enter valid inbox names, one per line. Full addresses must belong to this domain.'],
  DUPLICATE_MAILBOX_NAMES: [400, 'Each inbox name must be unique. Remove duplicate names and try again.'],
  INVALID_MAILBOX_QUANTITY: [400, 'Request between 1 and 500 inboxes per order.'],
  RESEND_INVALID_KEY: [400, 'This API key is invalid.'],
  RESEND_FULL_ACCESS_REQUIRED: [400, 'This API key does not have Full Access. Create a Full Access key in Resend and try again.'],
  RESEND_CONNECTION_REQUIRED: [409, 'Connect Resend before creating an order.'],
  RESEND_CONNECTION_INVALID: [409, 'Your Resend connection is no longer valid. Reconnect your account.'],
  RESEND_DOMAIN_LIMIT: [400, 'Your Resend domain limit has been reached. Check your Resend plan.'],
  RESEND_DOMAIN_NOT_FOUND: [409, 'This domain is no longer available in your Resend account. Prepare the domain again.'],
  RESEND_DOMAIN_CONFLICT: [409, 'This domain is already connected to another Resend account.'],
  RESEND_RATE_LIMITED: [429, 'Resend is busy. Wait a moment, then try again.'],
  RESEND_UNAVAILABLE: [503, 'Resend could not be reached. Try again.'],
  NAMESERVERS_PENDING: [409, 'Nameservers have not propagated yet. Update them at your registrar, then check again.'],
  ORDER_STATE_CONFLICT: [409, 'The order state changed. Refresh and try again.'],
  CONNECTION_BUSY: [409, 'An order is running. Stop the order before replacing or disconnecting Resend.'],
  ORDER_NOT_DELETABLE: [409, 'This order has prepared infrastructure and cannot be deleted.'],
  DOWNLOAD_NOT_READY: [409, 'Your inboxes are still being provisioned. Try again when the order is complete.'],
  DOWNLOAD_ALLOWANCE_REACHED: [403, 'Your trial credential allowance has been used. Upgrade to download more inboxes.'],
  MAIL_INFRASTRUCTURE_UNAVAILABLE: [503, 'Mail infrastructure could not be reached. Try provisioning again.'],
  MAILBOX_PROVISIONING_FAILED: [503, 'One or more inboxes could not be created. Try provisioning again.'],
  EMAIL_AUTHENTICATION_PENDING: [409, 'Email authentication is still propagating.'],
  DNS_UNAVAILABLE: [503, 'DNS could not be checked. Try again.'],
  SERVICE_UNAVAILABLE: [503, 'Provisioning is temporarily unavailable. Try again.'],
});
const PROVIDER_CODES = Object.freeze({
  INVALID_API_KEY: 'RESEND_INVALID_KEY', invalid_api_key: 'RESEND_INVALID_KEY',
  RESEND_UNAUTHORIZED: 'RESEND_INVALID_KEY', RESEND_KEY_INVALID: 'RESEND_INVALID_KEY',
  RESEND_FORBIDDEN: 'RESEND_FULL_ACCESS_REQUIRED', RESEND_INSUFFICIENT_PERMISSION: 'RESEND_FULL_ACCESS_REQUIRED',
  INSUFFICIENT_PERMISSIONS: 'RESEND_FULL_ACCESS_REQUIRED',
  RESEND_RATE_LIMIT: 'RESEND_RATE_LIMITED',
  DNS_ZONE_UNCLAIMED: 'DOMAIN_UNAVAILABLE', DNS_ZONE_MISSING: 'DOMAIN_UNAVAILABLE',
  DNS_CONFLICT: 'DOMAIN_UNAVAILABLE',
  RESEND_TIMEOUT: 'RESEND_UNAVAILABLE', RESEND_UPSTREAM_ERROR: 'RESEND_UNAVAILABLE',
  RESEND_NETWORK_ERROR: 'RESEND_UNAVAILABLE', RESEND_DOMAIN_ALREADY_EXISTS: 'RESEND_DOMAIN_CONFLICT',
});
export function publicSmtpError(error) {
  const code = Object.hasOwn(ERRORS, error?.code) ? error.code : (Object.hasOwn(PROVIDER_CODES, error?.code) ? PROVIDER_CODES[error.code] : 'SERVICE_UNAVAILABLE');
  const [status, message] = ERRORS[code];
  return { code, status, error: message };
}
export function smtpErrorMessage(code) { return ERRORS[code]?.[1] || ERRORS.SERVICE_UNAVAILABLE[1]; }
export function publicSmtpConnection(connection) {
  return {
    connected: connection?.status === 'connected',
    status: connection?.status || 'disconnected',
    connected_domain_count: Number(connection?.connected_domain_count || 0),
    validated_at: connection?.validated_at || null,
  };
}
export function parseSmtpJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}
export function publicSmtpOrder(order, mailboxes = []) {
  return {
    id: order.id, domain: order.domain, order_name: order.order_name,
    status: order.status, progress: Number(order.progress), total_mailboxes: Number(order.total_mailboxes),
    created_mailboxes_count: mailboxes.filter(row => ['created', 'verified'].includes(row.status)).length,
    name_servers: parseSmtpJson(order.cloudflare_ns), nameservers_connected: Boolean(order.nameservers_connected),
    error_code: order.error_code ? publicSmtpError({ code: order.error_code }).code : null,
    error_message: order.error_code ? smtpErrorMessage(publicSmtpError({ code: order.error_code }).code) : null,
    created_at: order.created_at, updated_at: order.updated_at,
    mailbox_names: mailboxes.map(row => row.local_part),
  };
}
const LOG_MESSAGES = new Set([
  'Preparing Domain', 'Waiting For Nameservers', 'Nameservers Connected', 'Applying DNS Records',
  'Configuring Email Authentication', 'Testing SMTP', 'Testing IMAP', 'Running Final Checks',
  'Provisioning Complete', 'Waiting For Email Authentication', 'Waiting For DNS', 'Order Stopped',
  'Provisioning Paused', 'Provisioning Started', 'Provisioning Could Not Be Completed',
]);
export function safeSmtpLog(message) {
  return LOG_MESSAGES.has(message) || /^Creating Inbox [1-9]\d{0,2} Of [1-9]\d{0,2}$/.test(message)
    ? message : 'Provisioning Paused';
}
