import { randomUUID } from 'node:crypto';
import {
  bearerToken,
  bridgeConfig,
  clientBucket,
  fail,
  hasExactKeys,
  isRecord,
  isUuid,
  logRequest,
  parseJsonBody,
  readBridgeJson,
  sameOrigin,
  signedBridgeRequest,
  trustedClientIp,
} from './_bridge.js';
import {
  EmailAuthError,
  emailAuthConfig,
  isEmailAddress,
  isEmailLinkToken,
  isEmailReturnPath,
  isEmailSession,
  isPreparedEmailLink,
  sendEmailLink,
  verifyEmailChallenge,
} from './_email-auth.js';
import { isDisplayName, isIdentity, isLoginResult } from './_identity.js';

const BODY_LIMIT = 4 * 1024 * 1024;
const UPLOAD_CHUNK_LIMIT = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log',
  'docx', 'pptx', 'xlsx', 'odt', 'ods',
  'kicad_sch', 'sch',
  'kicad_pcb', 'brd',
  'gbr', 'ger', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gko', 'gm1', 'drl', 'xln',
  'step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf', 'fcstd',
  'dxf', 'svg',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'dwg', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'ipt', 'iam', 'schdoc', 'pcbdoc', 'prjpcb', 'catpart', 'x_t', 'x_b',
]);
const SAFE_INVALID_CODES = new Set(['unsupported_type', 'mentions', 'pinned', 'mode']);
const BRIEF_FIELDS = new Set(['description', 'audience', 'markets', 'team', 'goal', 'notes']);

export const config = {
  api: {
    bodyParser: { sizeLimit: '4mb' },
  },
};

function countCharacters(value) {
  return [...value].length;
}

function boundedText(value, maxChars, { allowEmpty = false, maxBytes = Infinity } = {}) {
  return typeof value === 'string'
    && (allowEmpty || value.trim().length > 0)
    && countCharacters(value) <= maxChars
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validLabel(value) {
  return boundedText(value, 200);
}

function validFilename(value) {
  return validLabel(value) && !/[\\/\u0000]/.test(value);
}

function hasSupportedExtension(value) {
  const extension = value.slice(value.lastIndexOf('.') + 1).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension);
}

function validPinned(value) {
  return Array.isArray(value) && value.length <= 20 && value.every(isUuid);
}

function validBase64Chunk(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength <= UPLOAD_CHUNK_LIMIT && bytes.byteLength > 0 && bytes.toString('base64') === value;
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isBillingSnapshot(value) {
  return hasExactKeys(value, ['environment', 'plan', 'expires_at', 'verified_at'])
    && value.environment === 'sandbox'
    && ['free', 'pro', 'ultra_pro', 'max'].includes(value.plan)
    && (value.expires_at === null || isIsoTimestamp(value.expires_at))
    && (value.verified_at === null || isIsoTimestamp(value.verified_at))
    && ((value.plan === 'free' && value.expires_at === null)
      || (value.plan !== 'free' && value.expires_at !== null));
}


const operations = {
  login: {
    path: '/auth/login',
    auth: false,
    required: { login: value => boundedText(value, 100, { maxBytes: 200 }), password: value => boundedText(value, 1024, { maxBytes: 2048 }) },
    optional: {},
  },
  logout: { path: '/auth/logout', auth: true, required: {}, optional: {} },
  me: { path: '/auth/me', auth: true, required: {}, optional: {} },
  'account.profile.update': {
    path: '/account/profile/update',
    auth: true,
    required: { display_name: isDisplayName },
    optional: {},
  },
  'billing.status': { path: '/billing/status', auth: true, required: {}, optional: {} },
  'billing.sync': { path: '/billing/sync', auth: true, required: {}, optional: {} },
  'auth.email.request': {
    path: '/auth/email/request', auth: false,
    required: {
      email: isEmailAddress,
      turnstile_token: value => boundedText(value, 2048, { maxBytes: 2048 }),
      return_to: isEmailReturnPath,
    },
    optional: {},
  },
  'auth.email.prepare': {
    path: '/auth/email/prepare', auth: false,
    required: { token: isEmailLinkToken }, optional: {},
  },
  'auth.email.consume': {
    path: '/auth/email/consume', auth: false,
    required: { token: isEmailLinkToken }, optional: {},
  },
  'projects.list': { path: '/projects/list', auth: true, required: {}, optional: {} },
  'projects.create': {
    path: '/projects/create', auth: true,
    required: { name: validLabel, brief_text: value => boundedText(value, 8192, { allowEmpty: true, maxBytes: 8192 }) },
    optional: {},
  },
  'projects.update': {
    path: '/projects/update', auth: true,
    required: { project_id: isUuid },
    optional: {
      name: validLabel,
      brief_text: value => boundedText(value, 8192, { allowEmpty: true, maxBytes: 8192 }),
    },
    requireOptional: true,
  },
  'projects.delete': { path: '/projects/delete', auth: true, required: { project_id: isUuid }, optional: {} },
  'chats.list': { path: '/chats/list', auth: true, required: { project_id: isUuid }, optional: {} },
  'chats.create': {
    path: '/chats/create', auth: true,
    required: { project_id: isUuid }, optional: { title: validLabel },
  },
  'chats.update': {
    path: '/chats/update', auth: true,
    required: { chat_id: isUuid },
    optional: {
      title: validLabel,
      mode: value => value === 'auto' || value === 'technical',
      pinned: validPinned,
    },
    requireOptional: true,
  },
  'chats.delete': { path: '/chats/delete', auth: true, required: { chat_id: isUuid }, optional: {} },
  'messages.list': { path: '/messages/list', auth: true, required: { chat_id: isUuid }, optional: {} },
  'files.list': { path: '/files/list', auth: true, required: { project_id: isUuid }, optional: {} },
  'todos.list': { path: '/todos/list', auth: true, required: { project_id: isUuid }, optional: {} },
  'todos.create': {
    path: '/todos/create', auth: true,
    required: { project_id: isUuid, text: value => boundedText(value, 2000, { maxBytes: 8000 }) },
    optional: { source_message_id: isUuid },
  },
  'todos.update': {
    path: '/todos/update', auth: true,
    required: { todo_id: isUuid },
    optional: {
      text: value => boundedText(value, 2000, { maxBytes: 8000 }),
      completed: value => typeof value === 'boolean',
    },
    requireOptional: true,
  },
  'todos.delete': { path: '/todos/delete', auth: true, required: { todo_id: isUuid }, optional: {} },
  'projects.brief.save': {
    path: '/projects/brief/save', auth: true,
    required: {
      project_id: isUuid,
      field: value => BRIEF_FIELDS.has(value),
      text: value => boundedText(value, 8192, { allowEmpty: true, maxBytes: 8192 }),
      expected_text: value => boundedText(value, 8192, { allowEmpty: true, maxBytes: 8192 }),
    },
    optional: { source_message_id: isUuid },
  },
  'files.browse': { path: '/files/browse', auth: true, required: {}, optional: {} },
  'files.attach': {
    path: '/files/attach', auth: true, required: { project_id: isUuid, file_id: isUuid }, optional: {},
  },
  'files.delete': { path: '/files/delete', auth: true, required: { file_id: isUuid }, optional: {} },
  'files.upload.start': {
    path: '/files/upload/start', auth: true,
    required: {
      project_id: isUuid,
      name: validFilename,
      mime: value => boundedText(value, 100, { allowEmpty: true }),
      size_bytes: value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_UPLOAD_BYTES,
      sha256: value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value),
    },
    optional: {},
  },
  'files.upload.chunk': {
    path: '/files/upload/chunk', auth: true,
    required: { upload_id: isUuid, index: value => Number.isSafeInteger(value) && value >= 0 && value < MAX_UPLOAD_BYTES / UPLOAD_CHUNK_LIMIT, data_b64: validBase64Chunk },
    optional: {},
  },
  'files.upload.finish': { path: '/files/upload/finish', auth: true, required: { upload_id: isUuid }, optional: {} },
};

function validateOperation(body) {
  if (!isRecord(body) || typeof body.op !== 'string') return { error: 'invalid_request' };
  const operation = Object.hasOwn(operations, body.op) ? operations[body.op] : null;
  if (!operation) return { error: 'invalid_request' };
  const requiredKeys = Object.keys(operation.required);
  const optionalKeys = Object.keys(operation.optional);
  if (requiredKeys.some(key => !Object.hasOwn(body, key))) return { error: 'invalid_request' };
  if (Object.keys(body).some(key => key !== 'op' && !requiredKeys.includes(key) && !optionalKeys.includes(key))) return { error: 'invalid_request' };
  if (body.op === 'files.upload.start' && validFilename(body.name) && !hasSupportedExtension(body.name)) {
    return { error: 'unsupported_type' };
  }
  if (Object.keys(operation.required).some(key => !operation.required[key](body[key]))) return { error: 'invalid_request' };
  if (Object.keys(operation.optional).some(key => Object.hasOwn(body, key) && !operation.optional[key](body[key]))) return { error: 'invalid_request' };
  const presentOptional = optionalKeys.some(key => Object.hasOwn(body, key));
  if (operation.requireOptional && !presentOptional) return { error: 'invalid_request' };
  return { operation };
}

function bridgeFailure(response, payload) {
  if (response.status === 400) {
    if (payload?.code === 'invalid_link') return { status: 400, code: 'invalid_link', error: 'That sign-in link cannot be used. Request a new link.' };
    if (payload?.code === 'unsupported_type') return { status: 400, code: 'unsupported_type', error: 'Unsupported file type. See the list of supported formats.' };
    const code = SAFE_INVALID_CODES.has(payload?.code) ? payload.code : 'invalid_request';
    return { status: 400, code, error: 'The request is invalid.' };
  }
  if (response.status === 401) return { status: 401, code: 'unauthorized', error: 'Sign in to use server projects and chats.' };
  if (response.status === 403) return { status: 403, code: 'forbidden', error: 'You are not allowed to perform this operation.' };
  if (response.status === 404) return { status: 404, code: 'not_found', error: 'The requested item was not found.' };
  if (response.status === 409) return { status: 409, code: 'conflict', error: 'The request conflicts with current server state.' };
  if (response.status === 413) return { status: 413, code: 'request_too_large', error: 'The request exceeds the allowed size.' };
  if (response.status === 429) return { status: 429, code: 'quota_exceeded', error: 'The account request limit was reached. Try again later.' };
  if (response.status === 503) return { status: 503, code: 'service_unavailable', error: 'The storage service is temporarily unavailable.' };
  return { status: 502, code: 'bridge_error', error: 'The storage service could not complete this request.' };
}

function clientError(res, context, status, code, error, errorClass = 'request_rejected') {
  return fail(res, context, status, code, error, errorClass);
}

export default async function handler(req, res) {
  const context = {
    event: 'rag_app_request',
    requestId: randomUUID(),
    startedAt: Date.now(),
    upstreamStatus: null,
    op: null,
  };
  res.setHeader('X-RAG-Request-ID', context.requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.RAG_CHAT_ENABLED !== 'true') return clientError(res, context, 404, 'feature_disabled', 'The RAG chat service is not available.');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return clientError(res, context, 405, 'method_not_allowed', 'Use POST to perform an app operation.');
  }
  if (!sameOrigin(req)) return clientError(res, context, 403, 'origin_rejected', 'Send app requests from this workspace.');

  const parsed = parseJsonBody(req, BODY_LIMIT);
  if (parsed.error === 'too_large') return clientError(res, context, 413, 'request_too_large', 'The request body exceeds the allowed size.');
  if (parsed.error) return clientError(res, context, 400, 'invalid_request', 'The app request is not valid JSON.');
  context.op = isRecord(parsed.value) && typeof parsed.value.op === 'string' && Object.hasOwn(operations, parsed.value.op) ? parsed.value.op : null;
  const validation = validateOperation(parsed.value);
  if (validation.error) {
    const unsupported = validation.error === 'unsupported_type';
    context.rejectReason = unsupported ? 'unsupported_type' : 'input_schema';
    return clientError(res, context, 400, validation.error, unsupported ? 'Unsupported file type. See the list of supported formats.' : 'The app request is not valid.');
  }
  const { operation } = validation;
  const token = operation.auth ? bearerToken(req) : null;
  if (operation.auth && !token) return clientError(res, context, 401, 'unauthorized', 'Sign in again to continue.', 'authentication');

  const bridge = bridgeConfig();
  if (!bridge) return clientError(res, context, 503, 'service_unavailable', 'The storage service is temporarily unavailable.', 'configuration');
  const bridgeBody = { request_id: context.requestId };
  const emailOperation = parsed.value.op.startsWith('auth.email.');
  const emailRequest = parsed.value.op === 'auth.email.request';
  if (operation.auth) bridgeBody.session_token = token;
  for (const key of [...Object.keys(operation.required), ...Object.keys(operation.optional)]) {
    if (emailRequest && key === 'turnstile_token') continue;
    if (Object.hasOwn(parsed.value, key)) bridgeBody[key] = parsed.value[key];
  }
  if (parsed.value.op === 'login' || emailOperation) {
    const bucket = clientBucket(req.headers, bridge.keyBytes);
    if (!bucket) return clientError(res, context, 400, 'invalid_client_ip', 'A valid public client address is required.', 'invalid_client_ip');
    bridgeBody.client_bucket = bucket;
  }

  try {
    let mailSettings = null;
    if (emailRequest) {
      mailSettings = emailAuthConfig();
      if (!mailSettings) return clientError(res, context, 503, 'email_unavailable', 'Email sign-in is temporarily unavailable.', 'email_configuration');
      await verifyEmailChallenge(parsed.value.turnstile_token, trustedClientIp(req.headers), mailSettings);
    }
    const request = signedBridgeRequest({ ...bridge, path: operation.path, body: bridgeBody });
    const response = await fetch(request.url, request.options);
    context.upstreamStatus = response.status;
    if (!response.ok || response.status !== 200) {
      let errorPayload = null;
      try { errorPayload = await readBridgeJson(response); } catch { /* Upstream error details are never returned. */ }
      const mapped = bridgeFailure(response, errorPayload);
      return clientError(res, context, mapped.status, mapped.code, mapped.error, 'upstream_http');
    }
    let payload;
    try {
      payload = await readBridgeJson(response);
    } catch {
      return clientError(res, context, 502, 'invalid_response', 'The storage service returned an invalid response.', 'invalid_response');
    }
    if (!isRecord(payload) || !hasExactKeys(payload, ['data'])) {
      return clientError(res, context, 502, 'invalid_response', 'The storage service returned an invalid response.', 'invalid_response');
    }
    if (emailRequest) {
      await sendEmailLink(payload.data, context.requestId, mailSettings);
      logRequest(context, 200);
      return res.status(200).json({ data: { ok: true } });
    }
    if (parsed.value.op === 'auth.email.prepare' && !isPreparedEmailLink(payload.data)) {
      return clientError(res, context, 502, 'invalid_response', 'The sign-in service returned an invalid response.', 'invalid_response');
    }
    if (parsed.value.op === 'login' && !isLoginResult(payload.data)) {
      return clientError(res, context, 502, 'invalid_response', 'The sign-in service returned an invalid response.', 'invalid_response');
    }
    if ((parsed.value.op === 'me' || parsed.value.op === 'account.profile.update') && !isIdentity(payload.data)) {
      return clientError(res, context, 502, 'invalid_response', 'The account service returned an invalid response.', 'invalid_response');
    }
    if (parsed.value.op === 'auth.email.consume' && !isEmailSession(payload.data, parsed.value.token)) {
      return clientError(res, context, 502, 'invalid_response', 'The sign-in service returned an invalid response.', 'invalid_response');
    }
    if ((parsed.value.op === 'billing.status' || parsed.value.op === 'billing.sync')
        && !isBillingSnapshot(payload.data)) {
      return clientError(res, context, 502, 'invalid_response', 'The billing service returned an invalid response.', 'invalid_response');
    }
    logRequest(context, 200);
    return res.status(200).json({ data: payload.data });
  } catch (error) {
    if (error instanceof EmailAuthError) {
      return clientError(res, context, error.status, error.code, error.message, error.errorClass);
    }
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
