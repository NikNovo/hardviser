import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const BRIDGE_BASE_PATH = '/v1/public-rag/chat';

export function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const target = name.toLowerCase();
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === target);
  return key === undefined ? undefined : headers[key];
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function bearerToken(req) {
  const authorization = headerValue(req.headers, 'authorization');
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/i.exec(authorization);
  return match?.[1] ?? null;
}

export function sameOrigin(req) {
  const origin = headerValue(req.headers, 'origin');
  if (origin === undefined) return true;
  const host = headerValue(req.headers, 'host');
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return !parsed.username && !parsed.password && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function parseJsonBody(req, maxBytes) {
  const declared = headerValue(req.headers, 'content-length');
  let declaredLength = null;
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) return { error: 'invalid' };
    declaredLength = Number(declared);
    if (!Number.isSafeInteger(declaredLength)) return { error: 'invalid' };
    if (declaredLength > maxBytes) return { error: 'too_large' };
  }

  let requestBody;
  try {
    requestBody = req.body;
  } catch (error) {
    // @vercel/node's lazy req.body parser reports malformed JSON with this ApiError.
    if (error instanceof Error && error.statusCode === 400 && error.message === 'Invalid JSON') {
      return { error: 'invalid' };
    }
    throw error;
  }
  let bytes;
  let value;
  if (typeof requestBody === 'string') {
    bytes = Buffer.from(requestBody, 'utf8');
    try { value = JSON.parse(requestBody); } catch { return { error: 'invalid' }; }
  } else if (Buffer.isBuffer(requestBody) || requestBody instanceof Uint8Array) {
    bytes = Buffer.from(requestBody);
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return { error: 'invalid' }; }
  } else if (requestBody !== null && requestBody !== undefined) {
    try {
      const serialized = JSON.stringify(requestBody);
      if (typeof serialized !== 'string') return { error: 'invalid' };
      bytes = Buffer.from(serialized, 'utf8');
      value = requestBody;
    } catch {
      return { error: 'invalid' };
    }
  } else {
    return { error: 'invalid' };
  }
  if (bytes.byteLength > maxBytes) return { error: 'too_large' };
  return { value, size: bytes.byteLength, declaredLength };
}

function isPublicIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0) || (a === 192 && b === 2)
    || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

function ipv6Words(address) {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const octets = normalized.slice(separator + 1).split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
  }
  const separator = normalized.indexOf('::');
  const left = separator === -1 ? normalized.split(':') : normalized.slice(0, separator).split(':').filter(Boolean);
  const right = separator === -1 ? [] : normalized.slice(separator + 2).split(':').filter(Boolean);
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  return groups.length === 8 ? groups.map(group => Number.parseInt(group || '0', 16)) : null;
}

function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return false;
  const first = words[0];
  const second = words[1];
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && second <= 0x000f) return false;
  return true;
}

export function trustedClientIp(headers) {
  const address = headerValue(headers, 'x-forwarded-for');
  return typeof address === 'string' && !address.includes(',') && isPublicIp(address) ? address : null;
}

export function bridgeConfig() {
  const value = process.env.SEVERUS_RAG_BRIDGE_URL;
  const key = process.env.SEVERUS_RAG_BRIDGE_HMAC_KEY;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('?') || value.includes('#')) return null;
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { origin: url.origin, keyBytes: Buffer.from(key, 'hex') };
  } catch {
    return null;
  }
}

export function clientBucket(headers, keyBytes) {
  const ip = trustedClientIp(headers);
  if (!ip) return null;
  return createHmac('sha256', keyBytes).update(`client-bucket\n${ip}`, 'utf8').digest('hex');
}

export function signedBridgeRequest({ origin, keyBytes, path, body, timeoutMs = 25_000 }) {
  const requestId = body.request_id || randomUUID();
  const signedBody = Buffer.from(JSON.stringify({ ...body, request_id: requestId }), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const requestPath = `${BRIDGE_BASE_PATH}${path}`;
  const signature = createHmac('sha256', keyBytes)
    .update(`${timestamp}\n${nonce}\nPOST\n${requestPath}\n`, 'utf8')
    .update(signedBody)
    .digest('hex');
  return {
    requestId,
    url: `${origin}${requestPath}`,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RAG-Timestamp': timestamp,
        'X-RAG-Nonce': nonce,
        'X-RAG-Signature': signature,
      },
      body: signedBody,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    },
  };
}

export function logRequest(context, status, code = null, errorClass = null) {
  const record = {
    event: context.event,
    request_id: context.requestId,
    op: context.op ?? null,
    status,
    code,
    upstream_status: context.upstreamStatus ?? null,
    error_class: errorClass,
    reject_reason: context.rejectReason ?? null,
    ...(context.clientDisconnected ? { client_disconnected: true } : {}),
  };
  const line = JSON.stringify(record);
  if (status >= 400 || errorClass) console.error(line);
  else console.info(line);
}

export function fail(res, context, status, code, error, errorClass = 'request_rejected') {
  logRequest(context, status, code, errorClass);
  return res.status(status).json({ code, error });
}

export async function readBridgeJson(response, maxBytes = 1024 * 1024) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('bridge_response_too_large');
  return JSON.parse(text);
}
