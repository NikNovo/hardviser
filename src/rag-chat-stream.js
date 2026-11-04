const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_STREAM_BYTES = 64 * 1024;
const VALID_ROUTES = new Set(['general', 'technical']);
const VALID_ERROR_CODES = new Set(['service_unavailable', 'timeout', 'service_error']);
export class RagChatStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RagChatStreamError';
    this.code = code;
  }
}
const RESULT_KEYS = [
  'request_id',
  'message_id',
  'route',
  'answer',
  'recommendations',
  'unknowns',
  'follow_up_questions',
  'model',
  'usage',
];


function invalidStream() {
  return new RagChatStreamError('invalid_stream', 'The RAG service returned an invalid response stream. Your question is still here.');
}

function interruptedStream() {
  return new RagChatStreamError('stream_interrupted', 'The answer stream ended before a complete answer. Your question is still here.');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function utf8Length(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function stripEvidenceMarkers(value) {
  return value.replace(/\[e\d+\]/gi, '');
}

function cleanStringList(value) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw invalidStream();
  return value.map(stripEvidenceMarkers).filter(item => item.trim());
}

function followUpList(value) {
  if (!Array.isArray(value) || value.length > 3) throw invalidStream();
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\u0000')
      || Array.from(item).length > 300 || utf8Length(item) > 512) throw invalidStream();
    return stripEvidenceMarkers(item);
  }).filter(item => item.trim());
}

function validateResult(value, route) {
  const isGeneralKnowledge = hasExactKeys(value, [...RESULT_KEYS, 'general_knowledge']);
  if ((!hasExactKeys(value, RESULT_KEYS) && !isGeneralKnowledge)
    || typeof value.request_id !== 'string' || !UUID_PATTERN.test(value.request_id)
    || typeof value.message_id !== 'string' || !UUID_PATTERN.test(value.message_id)
    || !VALID_ROUTES.has(value.route) || value.route !== route
    || typeof value.answer !== 'string' || !value.answer.trim()
    || typeof value.model !== 'string' || !value.model.trim()
    || !isObject(value.usage)
    || !hasExactKeys(value.follow_up_questions, ['general', 'technical'])) throw invalidStream();

  let answer = stripEvidenceMarkers(value.answer);
  answer = answer.replace(/^(?:MUSE Standard answer|Result)[:\s]*\n*/i, '');
  if (!answer.trim()) throw invalidStream();
  return {
    requestId: value.request_id,
    messageId: value.message_id,
    route: value.route,
    answer,
    recommendations: cleanStringList(value.recommendations),
    unknowns: cleanStringList(value.unknowns),
    followUpQuestions: {
      general: followUpList(value.follow_up_questions.general),
      technical: followUpList(value.follow_up_questions.technical),
    },
    model: value.model,
    usage: value.usage,
  };
}


function validateProgress(value, state) {
  if (typeof value.stage !== 'string') throw invalidStream();
  switch (value.stage) {
    case 'accepted':
      if (!hasExactKeys(value, ['type', 'stage']) || state.nextStage !== 0) throw invalidStream();
      state.nextStage = 1;
      break;
    case 'classifying':
      if (!hasExactKeys(value, ['type', 'stage']) || state.nextStage !== 1) throw invalidStream();
      state.nextStage = 2;
      break;
    case 'classified':
      if (!hasExactKeys(value, ['type', 'stage', 'route']) || state.nextStage !== 2 || !VALID_ROUTES.has(value.route)) throw invalidStream();
      state.route = value.route;
      state.nextStage = 3;
      break;
    case 'project_context':
      if (!hasExactKeys(value, ['type', 'stage', 'available']) || state.nextStage !== 3 || typeof value.available !== 'boolean') throw invalidStream();
      state.nextStage = 4;
      break;
    case 'reading_files':
      if (!hasExactKeys(value, ['type', 'stage', 'count']) || state.nextStage !== 4 || state.readFiles
        || !Number.isInteger(value.count) || value.count < 1 || value.count > 200) throw invalidStream();
      state.readFiles = true;
      break;
    case 'searching': {
      if (!hasExactKeys(value, ['type', 'stage', 'queries']) || state.nextStage !== 4
        || state.route !== 'technical' || state.searched
        || !Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 2) throw invalidStream();
      const queries = value.queries.map(query => {
        if (typeof query !== 'string' || !query.trim() || query.includes('\u0000') || Array.from(query).length > 256) throw invalidStream();
        return stripEvidenceMarkers(query);
      });
      state.searched = true;
      return { type: 'progress', stage: 'searching', queries };
    }
    case 'answering':
      if (!hasExactKeys(value, ['type', 'stage']) || state.nextStage !== 4
        || (state.route === 'technical' && !state.searched)) throw invalidStream();
      state.nextStage = 5;
      break;
    default:
      throw invalidStream();
  }
  return value;
}

function parseEvent(line, state, onProgress) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw invalidStream();
  }
  if (!isObject(value) || state.terminal) throw invalidStream();

  if (value.type === 'progress') {
    if (state.nextStage === 0 && value.stage !== 'accepted') throw invalidStream();
    const progress = validateProgress(value, state);
    onProgress?.(progress);
    return;
  }

  if (value.type === 'result' && hasExactKeys(value, ['type', 'data'])) {
    if (state.nextStage !== 5) throw invalidStream();
    state.result = validateResult(value.data, state.route);
    state.terminal = true;
    return;
  }

  if (value.type === 'error' && hasExactKeys(value, ['type', 'code', 'error'])) {
    if (state.nextStage === 0 || !VALID_ERROR_CODES.has(value.code)
      || typeof value.error !== 'string' || !value.error.trim() || value.error.includes('\u0000')
      || Array.from(value.error).length > 512 || utf8Length(value.error) > 512) throw invalidStream();
    throw new RagChatStreamError(value.code, stripEvidenceMarkers(value.error));
  }

  throw invalidStream();
}

export async function consumeRagStream(body, onProgress) {
  if (!body || typeof body.getReader !== 'function') throw invalidStream();
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const state = { nextStage: 0, route: null, searched: false, readFiles: false, terminal: false, result: null };
  let buffered = '';
  let streamBytes = 0;

  function consumeLine(line) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized) throw invalidStream();
    parseEvent(normalized, state, onProgress);
  }

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw interruptedStream();
      }
      const { value, done } = chunk;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidStream();
      streamBytes += value.byteLength;
      if (streamBytes > MAX_STREAM_BYTES) throw invalidStream();
      try {
        buffered += decoder.decode(value, { stream: true });
      } catch {
        throw invalidStream();
      }
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }

    try {
      buffered += decoder.decode();
    } catch {
      throw invalidStream();
    }
    if (buffered) consumeLine(buffered);
    if (!state.terminal) throw interruptedStream();
    return state.result;
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Keep the original stream error. */ }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}
