const IDENTITY_KEYS = ['id', 'login', 'display_name', 'roles'];
const LOGIN_RESULT_KEYS = [...IDENTITY_KEYS, 'token', 'expires_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])((?:0\d|1\d|2[0-3])):([0-5]\d))$/;
const ROLE_ORDER = { admin: 0, expert: 1 };

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isBoundedText(value, maxCharacters) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && [...value].length <= maxCharacters
    && !/\p{Cc}/u.test(value);
}

function isIdentityFields(value) {
  if (!UUID.test(value.id) || !isBoundedText(value.login, 254)) return false;
  if (value.display_name !== null && !isBoundedText(value.display_name, 80)) return false;
  if (!Array.isArray(value.roles) || value.roles.length > 2) return false;
  for (let index = 0; index < value.roles.length; index += 1) {
    const role = value.roles[index];
    if (!Object.hasOwn(ROLE_ORDER, role)
        || (index > 0 && ROLE_ORDER[value.roles[index - 1]] >= ROLE_ORDER[role])) return false;
  }
  return true;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone, , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
      || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  if (timezone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function isAccountIdentity(user) {
  return hasExactKeys(user, IDENTITY_KEYS) && isIdentityFields(user);
}

export function isLoginResult(user) {
  return hasExactKeys(user, LOGIN_RESULT_KEYS)
    && isIdentityFields(user)
    && typeof user.token === 'string'
    && SESSION_TOKEN.test(user.token)
    && isIsoTimestamp(user.expires_at);
}

export function identityPatch(user) {
  return {
    userId: user.id,
    loginName: user.login,
    roles: [...user.roles],
    displayName: user.display_name,
  };
}
