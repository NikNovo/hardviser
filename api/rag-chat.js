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
  sameOrigin,
  signedBridgeRequest,
} from './_bridge.js';

const BODY_LIMIT = 48 * 1024;
const QUESTION_BYTE_LIMIT = 8 * 1024;
const BRIDGE_RESPONSE_LIMIT = 64 * 1024;
const CLIENT_ERROR_LIMIT = 1024;
const CLIENT_ERROR_CODES = new Set(['network_error', 'stream_interrupted', 'invalid_stream', 'timeout']);
const CLIENT_ERROR_STAGES = new Set([
  'sending', 'accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'searching', 'answering',
]);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_KEYS = [
  'request_id', 'message_id', 'route', 'answer', 'recommendations', 'unknowns',
  'follow_up_questions', 'model', 'usage',
];
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens'];
const FOLLOW_UP_KEYS = ['general', 'technical'];
const SEARCH_QUERY_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SEARCH_QUERY_LONG_HEX_ID = /\b[0-9a-f]{32,}\b/i;
const SEARCH_QUERY_PRIVATE_PATH = /(?<![\p{L}\p{N}_])(?:~?\/|[A-Za-z]:\\|\.{1,2}\/)[^\s]/u;
const STREAM_ERROR_MESSAGES = {
  service_unavailable: 'The RAG chat service is unavailable.',
  timeout: 'The RAG chat service took too long to answer.',
  service_error: 'The RAG chat service could not answer this request.',
};
const MODEL = 'muse-spark-1.3';

export const config = {
  api: {
    bodyParser: { sizeLimit: '48kb' },
  },
};

class InvalidBridgeStream extends Error {}

function characterCount(value) {
  return [...value].length;
}

function validQuestion(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && characterCount(value) <= 4000
    && Buffer.byteLength(value, 'utf8') <= QUESTION_BYTE_LIMIT;
}

// The browser supplies the request UUID so its pending message matches the stored server message.
function validateAsk(body) {
  if (!hasExactKeys(body, ['request_id', 'chat_id', 'question', 'mentions', 'route_mode'])) return false;
  if (!isUuid(body.request_id)) return false;
  return isUuid(body.chat_id)
    && validQuestion(body.question)
    && Array.isArray(body.mentions)
    && body.mentions.length <= 10
    && body.mentions.every(isUuid)
    && new Set(body.mentions).size === body.mentions.length
    && (body.route_mode === 'auto' || body.route_mode === 'technical');
}

function validClientErrorReport(value) {
  if (!hasExactKeys(value, ['event', 'request_id', 'code', 'stage']) || value.event !== 'client_error') return false;
  if (!CLIENT_ERROR_CODES.has(value.code) || !CLIENT_ERROR_STAGES.has(value.stage)) return false;
  if (value.request_id === null) return value.code === 'network_error' && value.stage === 'sending';
  return typeof value.request_id === 'string' && REQUEST_ID_PATTERN.test(value.request_id);
}

function logClientError(report) {
  console.error(JSON.stringify({
    event: 'rag_chat_client_error',
    received_at: new Date().toISOString(),
    request_id: report.request_id,
    code: report.code,
    stage: report.stage,
    source: 'client',
  }));
}

function validSearchQuery(query) {
  return typeof query === 'string'
    && characterCount(query) <= 256
    && Buffer.byteLength(query, 'utf8') <= 1024
    && !SEARCH_QUERY_UUID.test(query)
    && !SEARCH_QUERY_LONG_HEX_ID.test(query)
    && !SEARCH_QUERY_PRIVATE_PATH.test(query);
}

function stripEvidenceMarkers(value) {
  return value.replace(/\[e\d+\]/gi, '');
}

function validateStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateFollowUpQuestions(value) {
  if (!hasExactKeys(value, FOLLOW_UP_KEYS)) return null;
  const result = {};
  for (const key of FOLLOW_UP_KEYS) {
    const questions = value[key];
    if (!Array.isArray(questions) || questions.length > 3) return null;
    const safeQuestions = [];
    for (const question of questions) {
      if (typeof question !== 'string'
        || !question.trim()
        || characterCount(question) > 300
        || Buffer.byteLength(question, 'utf8') > 512) return null;
      const safeQuestion = stripEvidenceMarkers(question);
      if (!safeQuestion.trim()) return null;
      safeQuestions.push(safeQuestion);
    }
    result[key] = safeQuestions;
  }
  return result;
}

function validateBridgeResult(value, requestId, route) {
  if (!hasExactKeys(value, RESULT_KEYS)) return null;
  if (value.request_id !== requestId || !isUuid(value.message_id) || value.route !== route) return null;
  if (typeof value.answer !== 'string' || !value.answer.trim()) return null;
  if (!validateStringArray(value.recommendations) || !validateStringArray(value.unknowns)) return null;
  const followUpQuestions = validateFollowUpQuestions(value.follow_up_questions);
  if (followUpQuestions === null || value.model !== MODEL) return null;
  if (!hasExactKeys(value.usage, USAGE_KEYS)) return null;
  if (!Number.isSafeInteger(value.usage.prompt_tokens) || value.usage.prompt_tokens < 0 || value.usage.prompt_tokens > 32 * 1024) return null;
  if (!Number.isSafeInteger(value.usage.completion_tokens) || value.usage.completion_tokens < 0 || value.usage.completion_tokens > 8000) return null;
  const answer = stripEvidenceMarkers(value.answer);
  if (!answer.trim()) return null;
  return {
    request_id: value.request_id,
    message_id: value.message_id,
    route: value.route,
    answer,
    recommendations: value.recommendations.map(stripEvidenceMarkers),
    unknowns: value.unknowns.map(stripEvidenceMarkers),
    follow_up_questions: followUpQuestions,
    model: value.model,
    usage: { ...value.usage },
  };
}

function createEventValidator(requestId, routeMode) {
  let phase = 0;
  let route = null;
  let filesRead = false;
  let searched = false;
  let answering = false;
  let terminal = false;

  return value => {
    if (terminal || !isRecord(value)) return null;
    if (value.type === 'progress') {
      if (phase === 0 && hasExactKeys(value, ['type', 'stage']) && value.stage === 'accepted') {
        phase = 1;
        return { type: 'progress', stage: 'accepted' };
      }
      if (phase === 1 && hasExactKeys(value, ['type', 'stage']) && value.stage === 'classifying') {
        phase = 2;
        return { type: 'progress', stage: 'classifying' };
      }
      if (phase === 2 && hasExactKeys(value, ['type', 'stage', 'route'])
        && value.stage === 'classified'
        && (value.route === 'general' || value.route === 'technical')
        && (routeMode !== 'technical' || value.route === 'technical')) {
        route = value.route;
        phase = 3;
        return { type: 'progress', stage: 'classified', route };
      }
      if (phase === 3 && hasExactKeys(value, ['type', 'stage', 'available'])
        && value.stage === 'project_context' && typeof value.available === 'boolean') {
        phase = 4;
        return { type: 'progress', stage: 'project_context', available: value.available };
      }
      if (phase === 4 && !filesRead && !searched && !answering
        && hasExactKeys(value, ['type', 'stage', 'count'])
        && value.stage === 'reading_files'
        && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= 200) {
        filesRead = true;
        return { type: 'progress', stage: 'reading_files', count: value.count };
      }
      if (phase === 4 && route === 'technical' && !searched && !answering
        && hasExactKeys(value, ['type', 'stage', 'queries'])
        && value.stage === 'searching'
        && Array.isArray(value.queries) && value.queries.length >= 1 && value.queries.length <= 2
        && value.queries.every(validSearchQuery)) {
        searched = true;
        return { type: 'progress', stage: 'searching', queries: value.queries };
      }
      if (phase === 4 && !answering && (route === 'general' || (route === 'technical' && searched))
        && hasExactKeys(value, ['type', 'stage']) && value.stage === 'answering') {
        answering = true;
        phase = 5;
        return { type: 'progress', stage: 'answering' };
      }
      return null;
    }
    if (value.type === 'error') {
      if (phase === 0 || !hasExactKeys(value, ['type', 'code', 'error'])) return null;
      if (!Object.hasOwn(STREAM_ERROR_MESSAGES, value.code) || value.error !== STREAM_ERROR_MESSAGES[value.code]) return null;
      terminal = true;
      return { type: 'error', code: value.code, error: STREAM_ERROR_MESSAGES[value.code] };
    }
    if (value.type === 'result') {
      if (!answering || !hasExactKeys(value, ['type', 'data'])) return null;
      const data = validateBridgeResult(value.data, requestId, route);
      if (!data) return null;
      terminal = true;
      return { type: 'result', data };
    }
    return null;
  };
}

function responseHeader(headers, name) {
  if (!headers) return undefined;
  return typeof headers.get === 'function' ? headers.get(name) ?? undefined : undefined;
}

function validateStreamHeaders(response) {
  const contentType = responseHeader(response.headers, 'content-type');
  if (typeof contentType !== 'string' || !/^application\/x-ndjson(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) throw new InvalidBridgeStream();
  const declaredLength = responseHeader(response.headers, 'content-length');
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(String(declaredLength))) throw new InvalidBridgeStream();
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > BRIDGE_RESPONSE_LIMIT) throw new InvalidBridgeStream();
  }
}

function terminalError(timedOut) {
  const code = timedOut ? 'timeout' : 'service_error';
  return { type: 'error', code, error: STREAM_ERROR_MESSAGES[code] };
}

function markDisconnected(control) {
  control.disconnected = true;
  control.context.clientDisconnected = true;
}

function writeEvent(res, control, event, state, begin = false) {
  if (control.disconnected || res.writableEnded) return;
  try {
    if (begin) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders?.();
      state.started = true;
    }
    res.write(`${JSON.stringify(event)}\n`);
  } catch {
    markDisconnected(control);
  }
}

async function streamBridgeResponse(response, requestId, routeMode, res, control, state) {
  let reader;
  let totalBytes = 0;
  let frameBuffer = '';
  let terminalEvent = null;
  let decoder;
  const validateEvent = createEventValidator(requestId, routeMode);
  try {
    validateStreamHeaders(response);
    reader = response.body?.getReader?.();
    if (!reader) throw new InvalidBridgeStream();
    control.reader = reader;
    decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        try { frameBuffer += decoder.decode(); } catch { throw new InvalidBridgeStream(); }
        if (frameBuffer !== '' || !terminalEvent || !state.hasProgress) throw new InvalidBridgeStream();
        if (terminalEvent.type === 'error') {
          state.code = terminalEvent.code;
          state.errorClass = 'upstream_error';
        }
        writeEvent(res, control, terminalEvent, state);
        if (!control.disconnected && !res.writableEnded) res.end();
        return;
      }
      if (!(value instanceof Uint8Array)) throw new InvalidBridgeStream();
      totalBytes += value.byteLength;
      if (totalBytes > BRIDGE_RESPONSE_LIMIT) throw new InvalidBridgeStream();
      let decoded;
      try { decoded = decoder.decode(value, { stream: true }); } catch { throw new InvalidBridgeStream(); }
      frameBuffer += decoded;
      let newline;
      while ((newline = frameBuffer.indexOf('\n')) !== -1) {
        const frame = frameBuffer.slice(0, newline);
        frameBuffer = frameBuffer.slice(newline + 1);
        if (!frame || terminalEvent) throw new InvalidBridgeStream();
        let value;
        try { value = JSON.parse(frame); } catch { throw new InvalidBridgeStream(); }
        const event = validateEvent(value);
        if (!event) throw new InvalidBridgeStream();
        if (event.type === 'result' || event.type === 'error') {
          terminalEvent = event;
          continue;
        }
        state.lastStage = event.stage;
        state.hasProgress = true;
        writeEvent(res, control, event, state, !state.started && !control.disconnected);
      }
    }
  } catch (error) {
    try { await reader?.cancel(); } catch { /* The stream may already be closed. */ }
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    state.code = timedOut ? 'timeout' : 'service_error';
    state.errorClass = error instanceof InvalidBridgeStream ? 'invalid_stream' : (timedOut ? 'upstream_timeout' : 'upstream_stream');
    if (state.started) {
      writeEvent(res, control, terminalError(timedOut), state);
      if (!control.disconnected && !res.writableEnded) res.end();
      return;
    }
    throw error;
  } finally {
    control.reader = null;
    try { reader?.releaseLock(); } catch { /* Reader is no longer usable. */ }
  }
}

function logClientDisconnect(context) {
  context.clientDisconnected = true;
  logRequest(context, 499, 'client_disconnected', 'client_disconnect');
}

function bridgeHttpFailure(response) {
  if (response.status === 400) return { status: 400, code: 'invalid_request', error: 'The question request is not valid.' };
  if (response.status === 401) return { status: 401, code: 'unauthorized', error: 'Sign in again to continue.' };
  if (response.status === 404) return { status: 404, code: 'not_found', error: 'The requested chat was not found.' };
  if (response.status === 409) return { status: 409, code: 'conflict', error: 'The request conflicts with current server state.' };
  if (response.status === 413) return { status: 413, code: 'request_too_large', error: 'The question request exceeds the allowed size.' };
  if (response.status === 429) return { status: 429, code: 'quota_exceeded', error: 'The chat request limit was reached. Try again later.' };
  if (response.status === 503) return { status: 503, code: 'service_unavailable', error: 'The RAG chat service is unavailable.' };
  if (response.status === 504) return { status: 504, code: 'bridge_timeout', error: 'The RAG chat service timed out.' };
  return { status: 502, code: 'bridge_error', error: 'The RAG chat service could not answer this request.' };
}

export default async function handler(req, res) {
  const context = {
    event: 'rag_chat_request',
    requestId: randomUUID(),
    startedAt: Date.now(),
    lastStage: null,
    upstreamStatus: null,
    code: null,
    errorClass: null,
    op: 'ask',
  };
  res.setHeader('X-RAG-Request-ID', context.requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.RAG_CHAT_ENABLED !== 'true') return fail(res, context, 404, 'feature_disabled', 'The RAG chat service is not available.');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, context, 405, 'method_not_allowed', 'Use POST to ask a question.');
  }
  if (!sameOrigin(req)) return fail(res, context, 403, 'origin_rejected', 'Send questions from this workspace.');
  const token = bearerToken(req);
  if (!token) return fail(res, context, 401, 'unauthorized', 'Sign in again to continue.', 'authentication');

  const parsed = parseJsonBody(req, BODY_LIMIT);
  if (parsed.error === 'too_large') return fail(res, context, 413, 'request_too_large', 'The request body exceeds the allowed size.');
  if (parsed.error) return fail(res, context, 400, 'invalid_request', 'The request body is not valid JSON.');
  if (isRecord(parsed.value) && parsed.value.event === 'client_error') {
    if (parsed.size > CLIENT_ERROR_LIMIT || (parsed.declaredLength !== null && parsed.declaredLength > CLIENT_ERROR_LIMIT)) {
      return fail(res, context, 413, 'request_too_large', 'The client error report exceeds the allowed size.');
    }
    if (!validClientErrorReport(parsed.value)) return fail(res, context, 400, 'invalid_request', 'The client error report is not valid.');
    logClientError(parsed.value);
    logRequest(context, 204);
    return res.status(204).end();
  }
  if (!validateAsk(parsed.value)) {
    context.rejectReason = 'input_schema';
    return fail(res, context, 400, 'invalid_request', 'Use a chat, a question, up to ten file mentions, and an auto or technical route.');
  }
  context.requestId = parsed.value.request_id;
  res.setHeader('X-RAG-Request-ID', context.requestId);

  const bridge = bridgeConfig();
  if (!bridge) return fail(res, context, 503, 'service_unavailable', 'The RAG chat service is unavailable.', 'configuration');
  const bridgeBody = {
    request_id: context.requestId,
    session_token: token,
    chat_id: parsed.value.chat_id,
    question: parsed.value.question,
    mentions: parsed.value.mentions,
    route_mode: parsed.value.route_mode,
  };
  const request = signedBridgeRequest({ ...bridge, path: '/ask', body: bridgeBody, timeoutMs: 55_000 });
  const state = { started: false, hasProgress: false, lastStage: null, code: null, errorClass: null };
  const control = { disconnected: false, context, reader: null };
  const onDisconnect = () => {
    if (res.writableEnded || control.disconnected) return;
    markDisconnected(control);
  };
  res.on?.('close', onDisconnect);
  req.on?.('aborted', onDisconnect);
  if (req.aborted) onDisconnect();

  try {
    const response = await fetch(request.url, request.options);
    context.upstreamStatus = response.status;
    if (response.status !== 200) {
      try { await response.body?.cancel?.(); } catch { /* Response body can already be closed. */ }
      if (control.disconnected) {
        logClientDisconnect(context);
        return;
      }
      const mapped = bridgeHttpFailure(response);
      return fail(res, context, mapped.status, mapped.code, mapped.error, 'upstream_http');
    }
    await streamBridgeResponse(response, context.requestId, parsed.value.route_mode, res, control, state);
    context.lastStage = state.lastStage;
    context.code = state.code;
    context.errorClass = state.errorClass;
    if (control.disconnected) logClientDisconnect(context);
    else logRequest(context, 200, state.code, state.errorClass);
  } catch (error) {
    context.lastStage = state.lastStage;
    context.code = state.code;
    context.errorClass = state.errorClass;
    if (control.disconnected) {
      logClientDisconnect(context);
      return;
    }
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return fail(
      res,
      context,
      timedOut ? 504 : 502,
      timedOut ? 'bridge_timeout' : 'bridge_error',
      timedOut ? 'The RAG chat service timed out.' : error instanceof InvalidBridgeStream
        ? 'The RAG chat service returned an invalid response.'
        : 'The RAG chat service could not answer this request.',
      timedOut ? 'upstream_timeout' : error instanceof InvalidBridgeStream ? 'invalid_stream' : 'upstream_transport',
    );
  } finally {
    res.off?.('close', onDisconnect);
    req.off?.('aborted', onDisconnect);
    if (!res.off) res.removeListener?.('close', onDisconnect);
    if (!req.off) req.removeListener?.('aborted', onDisconnect);
  }
}
