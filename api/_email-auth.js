import { hasExactKeys, isRecord, readBridgeJson } from './_bridge.js';
import { isEmailAddress, isLoginResult } from './_identity.js';
export { isEmailAddress };

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RETURN_PATH = /^\/[A-Za-z0-9/_-]*(?:\?[A-Za-z0-9_=&%.-]*)?$/;

export class EmailAuthError extends Error {
  constructor(status, code, message, errorClass) {
    super(message);
    this.name = 'EmailAuthError';
    this.status = status;
    this.code = code;
    this.errorClass = errorClass;
  }
}


export function isEmailLinkToken(value) {
  return typeof value === 'string' && LINK_TOKEN.test(value);
}

export function isEmailReturnPath(value) {
  return typeof value === 'string' && value.length <= 512
    && value.startsWith('/') && !value.startsWith('//') && RETURN_PATH.test(value);
}

function validLinkDetails(value) {
  return isRecord(value) && isEmailAddress(value.email)
    && isEmailReturnPath(value.return_to)
    && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at));
}

export function isIssuedEmailLink(value) {
  return hasExactKeys(value, ['email', 'token', 'expires_at', 'return_to'])
    && validLinkDetails(value) && isEmailLinkToken(value.token);
}

export function isPreparedEmailLink(value) {
  return hasExactKeys(value, ['email', 'expires_at', 'return_to']) && validLinkDetails(value);
}

export function isEmailSession(value, linkToken) {
  return isLoginResult(value) && isEmailAddress(value.login) && value.token !== linkToken;
}

export function emailAuthConfig() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const replyTo = process.env.RESEND_REPLY_TO;
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  const configuredOrigin = process.env.AUTH_ORIGIN;
  const sender = typeof from === 'string' && /^[^<>\r\n]+ <([^<>\s]+)>$/.exec(from);
  if (typeof key !== 'string' || !/^re_[A-Za-z0-9_-]{20,256}$/.test(key)
      || !sender || !isEmailAddress(sender[1]) || !isEmailAddress(replyTo)
      || typeof turnstileSecret !== 'string' || !turnstileSecret.trim()
      || typeof configuredOrigin !== 'string') return null;
  try {
    const origin = new URL(configuredOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return { key, from, replyTo, turnstileSecret, origin: origin.origin, hostname: origin.hostname };
  } catch {
    return null;
  }
}

export async function verifyEmailChallenge(token, remoteip, config) {
  let response;
  let validation;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.turnstileSecret, response: token, remoteip }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    validation = await readBridgeJson(response, 16 * 1024);
  } catch {
    throw new EmailAuthError(503, 'verification_unavailable', 'Verification is temporarily unavailable. Please try again.', 'turnstile_transport');
  }
  if (!response.ok) {
    throw new EmailAuthError(503, 'verification_unavailable', 'Verification is temporarily unavailable. Please try again.', 'turnstile_http');
  }
  if (!isRecord(validation) || validation.success !== true
      || validation.hostname !== config.hostname || validation.action !== 'email_login') {
    throw new EmailAuthError(403, 'verification_failed', 'Complete the verification again before requesting a sign-in link.', 'turnstile_rejected');
  }
}

export async function sendEmailLink(delivery, requestId, config) {
  if (!isIssuedEmailLink(delivery)) {
    throw new EmailAuthError(502, 'bridge_error', 'The sign-in service returned an invalid response.', 'invalid_response');
  }
  const link = new URL(config.origin);
  link.hash = '/auth/email?' + new URLSearchParams({ token: delivery.token }).toString();
  const text = [
    'Sign in to Hardviser',
    '',
    'Open this link, check the email address shown, and confirm to sign in or create your account:',
    link.href,
    '',
    'This link expires in 15 minutes and can be used once. Requesting a new link replaces the previous one.',
    'If you did not request this email, you can ignore it. No account is created until you confirm.',
    '',
    'Hardviser — Your AI hardware cofounder',
  ].join('\n');
  const html = '<main style="max-width:520px;margin:32px auto;padding:24px;font:16px/1.6 Arial,sans-serif;color:#242a2e">'
    + '<p style="font-weight:700">hardviser.com</p><h1 style="font-size:26px">Sign in to Hardviser</h1>'
    + '<p>Check the email address shown on the next screen, then confirm to sign in or create your account.</p>'
    + '<p style="margin:28px 0"><a style="display:inline-block;padding:12px 20px;background:#2f6fbd;color:#fff;text-decoration:none;border-radius:5px" href="'
    + link.href + '">Continue to Hardviser</a></p>'
    + '<p>This link expires in <strong>15 minutes</strong> and can be used once. Requesting a new link replaces the previous one.</p>'
    + '<p>If you did not request this email, you can ignore it. No account is created until you confirm.</p>'
    + '<p style="font-size:13px;color:#5d6870">Your AI hardware cofounder</p></main>';
  let response;
  let receipt;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `magic-link/${requestId}`,
      },
      body: JSON.stringify({ from: config.from, to: [delivery.email], reply_to: config.replyTo,
        subject: 'Your Hardviser sign-in link', text, html }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    receipt = await readBridgeJson(response, 16 * 1024);
  } catch {
    throw new EmailAuthError(503, 'email_unavailable', 'The sign-in email could not be confirmed. Wait a minute before requesting a new link.', 'email_transport');
  }
  if (!response.ok || !isRecord(receipt) || typeof receipt.id !== 'string' || !receipt.id) {
    throw new EmailAuthError(503, 'email_unavailable', 'The sign-in email could not be sent. Please try again later.', 'email_http');
  }
}
