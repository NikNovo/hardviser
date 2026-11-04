import { randomUUID } from 'node:crypto';
import {
  bearerToken,
  bridgeConfig,
  fail,
  hasExactKeys,
  isRecord,
  isUuid,
  logRequest,
  parseJsonBody,
  readBridgeJson,
  sameOrigin,
  signedBridgeRequest,
} from './_bridge.js';
import {
  isAdminReason,
  isAdminUserData,
  isAuditOperation,
  isAuditPage,
  isCursor,
  isIsoTimestamp,
  isRoleList,
  isUserPage,
} from './_identity.js';

const BODY_LIMIT = 48 * 1024;
const CONFLICT_CODES = new Set(['stale_user', 'self_protection', 'last_admin', 'conflict']);
const CONFLICT_MESSAGES = {
  stale_user: 'The account changed before your update. Refresh and try again.',
  self_protection: 'You cannot remove your own administrator role.',
  last_admin: 'The last administrator cannot be removed.',
  conflict: 'The request conflicts with current server state.',
};
const ROLE_FILTERS = new Set(['admin', 'expert']);
const STATUS_FILTERS = new Set(['active', 'disabled']);

export const config = {
  api: {
    bodyParser: { sizeLimit: '48kb' },
  },
};

function countCharacters(value) {
  return [...value].length;
}

function validQuery(value) {
  return typeof value === 'string' && countCharacters(value) <= 254;
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const operations = {
  'admin.users.list': {
    path: '/admin/users/list',
    required: {},
    optional: {
      query: validQuery,
      role: value => ROLE_FILTERS.has(value),
      status: value => STATUS_FILTERS.has(value),
      cursor: isCursor,
      limit: validLimit,
    },
    response: isUserPage,
  },
  'admin.users.get': {
    path: '/admin/users/get',
    required: { user_id: isUuid },
    optional: {},
    response: isAdminUserData,
  },
  'admin.users.roles.set': {
    path: '/admin/users/roles/set',
    required: { user_id: isUuid, roles: isRoleList, expected_revision: validRevision, reason: isAdminReason },
    optional: {},
    response: isAdminUserData,
  },
  'admin.users.status.set': {
    path: '/admin/users/status/set',
    required: {
      user_id: isUuid,
      disabled: value => typeof value === 'boolean',
      expected_revision: validRevision,
      reason: isAdminReason,
    },
    optional: {},
    response: isAdminUserData,
  },
  'admin.audit.list': {
    path: '/admin/audit/list',
    required: {},
    optional: {
      target_user_id: isUuid,
      actor_id: isUuid,
      operation: isAuditOperation,
      since: isIsoTimestamp,
      until: isIsoTimestamp,
      cursor: isCursor,
      limit: validLimit,
    },
    response: isAuditPage,
  },
};

function validateOperation(body) {
  if (!isRecord(body) || typeof body.op !== 'string' || !Object.hasOwn(operations, body.op)) {
    return { error: 'invalid_request' };
  }
  const operation = operations[body.op];
  const requiredKeys = Object.keys(operation.required);
  const optionalKeys = Object.keys(operation.optional);
  if (requiredKeys.some(key => !Object.hasOwn(body, key))) return { error: 'invalid_request' };
  if (Object.keys(body).some(key => key !== 'op' && !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    return { error: 'invalid_request' };
  }
  if (requiredKeys.some(key => !operation.required[key](body[key]))) return { error: 'invalid_request' };
  if (optionalKeys.some(key => Object.hasOwn(body, key) && !operation.optional[key](body[key]))) {
    return { error: 'invalid_request' };
  }
  if (body.op === 'admin.audit.list' && Object.hasOwn(body, 'since') && Object.hasOwn(body, 'until')
      && Date.parse(body.since) > Date.parse(body.until)) {
    return { error: 'invalid_request' };
  }
  return { operation };
}

function bridgeFailure(response, payload) {
  if (response.status === 400) return { status: 400, code: 'invalid_request', error: 'The admin request is invalid.' };
  if (response.status === 401) return { status: 401, code: 'unauthorized', error: 'Sign in again to continue.' };
  if (response.status === 403) return { status: 403, code: 'forbidden', error: 'You are not allowed to perform this operation.' };
  if (response.status === 404) return { status: 404, code: 'not_found', error: 'The requested account or audit entry was not found.' };
  if (response.status === 409) {
    const code = CONFLICT_CODES.has(payload?.code) ? payload.code : 'conflict';
    return { status: 409, code, error: CONFLICT_MESSAGES[code] };
  }
  if (response.status === 413) return { status: 413, code: 'request_too_large', error: 'The request exceeds the allowed size.' };
  if (response.status === 503) return { status: 503, code: 'service_unavailable', error: 'The storage service is temporarily unavailable.' };
  return { status: 502, code: 'bridge_error', error: 'The storage service could not complete this request.' };
}

function clientError(res, context, status, code, error, errorClass = 'request_rejected') {
  return fail(res, context, status, code, error, errorClass);
}

export default async function handler(req, res) {
  const context = {
    event: 'rag_admin_request',
    requestId: randomUUID(),
    startedAt: Date.now(),
    upstreamStatus: null,
    op: null,
  };
  res.setHeader('X-RAG-Request-ID', context.requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.RAG_CHAT_ENABLED !== 'true') {
    return clientError(res, context, 404, 'feature_disabled', 'The admin service is not available.');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return clientError(res, context, 405, 'method_not_allowed', 'Use POST to perform an admin operation.');
  }
  if (!sameOrigin(req)) return clientError(res, context, 403, 'origin_rejected', 'Send admin requests from this workspace.');

  const parsed = parseJsonBody(req, BODY_LIMIT);
  if (parsed.error === 'too_large') {
    return clientError(res, context, 413, 'request_too_large', 'The request body exceeds the allowed size.');
  }
  if (parsed.error) return clientError(res, context, 400, 'invalid_request', 'The admin request is not valid JSON.');
  context.op = isRecord(parsed.value) && typeof parsed.value.op === 'string'
    && Object.hasOwn(operations, parsed.value.op) ? parsed.value.op : null;
  const validation = validateOperation(parsed.value);
  if (validation.error) {
    context.rejectReason = 'input_schema';
    return clientError(res, context, 400, 'invalid_request', 'The admin request is invalid.');
  }
  const { operation } = validation;
  const token = bearerToken(req);
  if (!token) return clientError(res, context, 401, 'unauthorized', 'Sign in again to continue.', 'authentication');

  const bridge = bridgeConfig();
  if (!bridge) {
    return clientError(res, context, 503, 'service_unavailable', 'The storage service is temporarily unavailable.', 'configuration');
  }
  const bridgeBody = { request_id: context.requestId, session_token: token };
  for (const key of [...Object.keys(operation.required), ...Object.keys(operation.optional)]) {
    if (Object.hasOwn(parsed.value, key)) bridgeBody[key] = parsed.value[key];
  }

  try {
    const request = signedBridgeRequest({ ...bridge, path: operation.path, body: bridgeBody });
    const response = await fetch(request.url, request.options);
    context.upstreamStatus = response.status;
    if (!response.ok || response.status !== 200) {
      let payload = null;
      try { payload = await readBridgeJson(response); } catch { /* Upstream error details are never returned. */ }
      const mapped = bridgeFailure(response, payload);
      return clientError(res, context, mapped.status, mapped.code, mapped.error, 'upstream_http');
    }
    let payload;
    try {
      payload = await readBridgeJson(response);
    } catch {
      return clientError(res, context, 502, 'invalid_response', 'The storage service returned an invalid response.', 'invalid_response');
    }
    if (!hasExactKeys(payload, ['data']) || !operation.response(payload.data)) {
      return clientError(res, context, 502, 'invalid_response', 'The storage service returned an invalid response.', 'invalid_response');
    }
    if (['admin.users.list', 'admin.audit.list'].includes(parsed.value.op)
        && payload.data.items.length > (parsed.value.limit ?? 50)) {
      return clientError(res, context, 502, 'invalid_response', 'The storage service returned an invalid response.', 'invalid_response');
    }
    logRequest(context, 200);
    return res.status(200).json({ data: payload.data });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return clientError(
      res,
      context,
      timedOut ? 504 : 502,
      timedOut ? 'bridge_timeout' : 'bridge_error',
      timedOut ? 'The storage service timed out.' : 'The storage service could not complete this request.',
      timedOut ? 'upstream_timeout' : 'upstream_transport',
    );
  }
}
