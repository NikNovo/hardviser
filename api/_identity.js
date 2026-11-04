import { hasExactKeys, isUuid } from './_bridge.js';

const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])((?:0\d|1\d|2[0-3])):([0-5]\d))$/;
const EMAIL_LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ROLE_ORDER = { admin: 0, expert: 1 };
const AUDIT_OPERATIONS = new Set(['admin.users.roles.set', 'admin.users.status.set', 'admin.bootstrap']);

function countCharacters(value) {
  return [...value].length;
}

function isBoundedText(value, maxCharacters) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && countCharacters(value) <= maxCharacters
    && !/\p{Cc}/u.test(value);
}

export function isEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim()) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const labels = domain.split('.');
  return local.length > 0 && local.length <= 64 && EMAIL_LOCAL.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && labels.length >= 2 && labels.every(label => DOMAIN_LABEL.test(label));
}

export function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone, , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  if (timezone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function isDisplayName(value) {
  return value === null || (isBoundedText(value, 80));
}

export function isRoleList(value) {
  return Array.isArray(value) && value.length <= 2
    && value.every((role, index) => Object.hasOwn(ROLE_ORDER, role)
      && (index === 0 || ROLE_ORDER[value[index - 1]] < ROLE_ORDER[role]));
}

export function isIdentity(value) {
  return hasExactKeys(value, ['id', 'login', 'display_name', 'roles'])
    && isUuid(value.id) && isBoundedText(value.login, 254)
    && isDisplayName(value.display_name) && isRoleList(value.roles);
}

export function isLoginResult(value) {
  return hasExactKeys(value, ['id', 'login', 'display_name', 'roles', 'token', 'expires_at'])
    && isIdentity({ id: value.id, login: value.login, display_name: value.display_name, roles: value.roles })
    && typeof value.token === 'string' && SESSION_TOKEN.test(value.token)
    && isIsoTimestamp(value.expires_at);
}

export function isCursor(value) {
  return hasExactKeys(value, ['at', 'id']) && isIsoTimestamp(value.at) && isUuid(value.id);
}

export function isAdminUser(value) {
  return hasExactKeys(value, ['id', 'login', 'display_name', 'roles', 'email', 'created_at', 'disabled_at', 'revision'])
    && isUuid(value.id) && isBoundedText(value.login, 254)
    && isDisplayName(value.display_name) && isRoleList(value.roles)
    && (value.email === null || isEmailAddress(value.email))
    && isIsoTimestamp(value.created_at)
    && (value.disabled_at === null || isIsoTimestamp(value.disabled_at))
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function isUserState(value) {
  return hasExactKeys(value, ['roles', 'disabled_at', 'revision'])
    && isRoleList(value.roles)
    && (value.disabled_at === null || isIsoTimestamp(value.disabled_at))
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function isNullableLabel(value) {
  return value === null || isBoundedText(value, 254);
}

function isAuditEntry(value) {
  return hasExactKeys(value, [
    'id', 'created_at', 'actor_kind', 'actor_id', 'actor_label', 'operation',
    'target_user_id', 'before', 'after', 'reason',
  ])
    && isUuid(value.id) && isIsoTimestamp(value.created_at)
    && (value.actor_kind === 'user' || value.actor_kind === 'operator')
    && (value.actor_id === null || isUuid(value.actor_id))
    && isNullableLabel(value.actor_label)
    && AUDIT_OPERATIONS.has(value.operation)
    && isUuid(value.target_user_id)
    && isUserState(value.before) && isUserState(value.after)
    && typeof value.reason === 'string' && value.reason === value.reason.trim()
    && countCharacters(value.reason) >= 1 && countCharacters(value.reason) <= 500;
}

function isNextCursor(value) {
  return value === null || isCursor(value);
}

export function isUserPage(value) {
  return hasExactKeys(value, ['items', 'next_cursor'])
    && Array.isArray(value.items) && value.items.every(isAdminUser)
    && isNextCursor(value.next_cursor);
}

export function isAuditPage(value) {
  return hasExactKeys(value, ['items', 'next_cursor'])
    && Array.isArray(value.items) && value.items.every(isAuditEntry)
    && isNextCursor(value.next_cursor);
}

export function isAdminUserData(value) {
  return isAdminUser(value);
}

export function isAuditOperation(value) {
  return AUDIT_OPERATIONS.has(value);
}

export function isAdminReason(value) {
  return typeof value === 'string' && value === value.trim()
    && countCharacters(value) >= 1 && countCharacters(value) <= 500;
}

