export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function isForbiddenError(error) {
  return error?.status === 403 || error?.code === 'forbidden';
}

export function isNotFoundError(error) {
  return error?.status === 404 || error?.code === 'not_found';
}

export function isAmbiguousError(error) {
  return error instanceof TypeError
    || error?.status === 0
    || error?.status === 502
    || error?.status === 503
    || error?.status === 504
    || ['network_error', 'timeout', 'bridge_error', 'bridge_timeout', 'invalid_response', 'service_unavailable'].includes(error?.code);
}

export function adminErrorText(error, fallback = 'Administration could not complete this request. Try again.') {
  if (error?.code === 'stale_user') return 'This account changed while you were reviewing it. Refresh its latest state before trying again.';
  if (error?.code === 'self_protection') return 'You cannot remove the administrator role or disable your own account.';
  if (error?.code === 'last_admin') return 'The last administrator cannot be demoted or disabled.';
  if (isForbiddenError(error)) return 'You do not have access to administration.';
  if (isNotFoundError(error)) return 'This account is no longer available.';
  if (error?.status === 401) return 'Your server sign-in has expired. Sign in again to continue.';
  if (error?.code === 'service_unavailable' || error?.status === 503) return 'Administration is temporarily unavailable. Try again shortly.';
  if (error?.code === 'invalid_request' || error?.status === 400) return 'The request could not be validated. Check the filters or account changes and try again.';
  return fallback;
}

const ADMIN_DATETIME_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function formatAdminDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Unknown';
  return ADMIN_DATETIME_FORMATTER.format(date);
}

export function adminUserHref(userId) {
  return `#/admin/users/${encodeURIComponent(userId)}`;
}

export function userStatus(user) {
  return user.disabled_at ? 'Disabled' : 'Active';
}

export function auditStatus(state) {
  return state.disabled_at ? 'Disabled' : 'Active';
}

export function roleNames(roles = []) {
  return roles.length ? roles.map(role => role === 'admin' ? 'Admin' : role === 'expert' ? 'Expert' : role).join(', ') : 'No elevated roles';
}
