import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  bridgeConfig,
  hasExactKeys,
  isRecord,
  logRequest,
  readBridgeJson,
  signedBridgeRequest,
} from './_bridge.js';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{0,79}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store' };

class InvalidBody extends Error {}
class BodyTooLarge extends Error {}

function webhookConfig() {
  const environment = process.env.REVENUECAT_ENVIRONMENT;
  const appId = process.env.REVENUECAT_APP_ID;
  const authorization = process.env.REVENUECAT_WEBHOOK_AUTHORIZATION;
  const signingSecret = process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
  const bridge = bridgeConfig();
  if (environment !== 'sandbox' || !bridge
      || typeof appId !== 'string' || !IDENTIFIER.test(appId)
      || typeof authorization !== 'string' || !authorization
      || authorization !== authorization.trim() || authorization.length > 512
      || /[\r\n\0]/.test(authorization)
      || typeof signingSecret !== 'string' || signingSecret.length < 16
      || signingSecret !== signingSecret.trim() || signingSecret.length > 1024
      || /[\r\n\0]/.test(signingSecret)) {
    return null;
  }
  return { bridge, appId, authorization, signingSecret };
}

function constantTimeTextEqual(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function verifyRevenueCatSignature(rawBody, header, secret) {
  if (typeof header !== 'string' || header.length > 256) return false;
  const match = /^t=([0-9]{1,16}),v1=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const timestamp = match[1];
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt)) return false;
  const supplied = Buffer.from(match[2], 'hex');
  const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  if (!timingSafeEqual(expected, supplied)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - issuedAt) <= MAX_TIMESTAMP_SKEW_SECONDS;
}

async function readRawBody(request) {
  const declared = request.headers.get('content-length');
  let declaredLength = null;
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new InvalidBody();
    declaredLength = Number(declared);
    if (!Number.isSafeInteger(declaredLength)) throw new InvalidBody();
    if (declaredLength > MAX_BODY_BYTES) throw new BodyTooLarge();
  }
  if (!request.body) throw new InvalidBody();
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(bytes);
  }
  if (declaredLength !== null && size !== declaredLength) throw new InvalidBody();
  return Buffer.concat(chunks, size);
}

function parseEvent(rawBody) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    throw new InvalidBody();
  }
  if (!isRecord(payload) || payload.api_version !== '1.0' || !isRecord(payload.event)) {
    throw new InvalidBody();
  }
  const event = payload.event;
  if (typeof event.id !== 'string' || event.id.length < 1 || event.id.length > 255
      || /[\u0000-\u001f\u007f]/.test(event.id)
      || typeof event.type !== 'string' || !EVENT_TYPE.test(event.type)
      || !Number.isSafeInteger(event.event_timestamp_ms) || event.event_timestamp_ms < 0) {
    throw new InvalidBody();
  }
  if (Object.hasOwn(event, 'app_id')
      && (typeof event.app_id !== 'string' || !IDENTIFIER.test(event.app_id))) {
    throw new InvalidBody();
  }
  if (Object.hasOwn(event, 'environment')
      && !['SANDBOX', 'PRODUCTION'].includes(event.environment)) {
    throw new InvalidBody();
  }
  return payload;
}

function fail(context, status, code, error, errorClass = 'request_rejected', headers = {}) {
  logRequest(context, status, code, errorClass);
  return Response.json({ code, error }, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
}

function upstreamFailure(response, context) {
  context.upstreamStatus = response.status;
  if (response.status === 400) {
    return fail(context, 400, 'invalid_request', 'The RevenueCat notification is not valid.', 'upstream_http');
  }
  return fail(context, 503, 'service_unavailable', 'The billing service is temporarily unavailable.', 'upstream_http');
}

async function handler(request) {
  const context = {
    event: 'revenuecat_webhook_request',
    requestId: randomUUID(),
    startedAt: Date.now(),
    upstreamStatus: null,
    op: 'revenuecat.webhook',
  };
  if (request.method !== 'POST') {
    return fail(context, 405, 'method_not_allowed', 'Use POST to receive RevenueCat notifications.', 'request_rejected', { Allow: 'POST' });
  }
  const settings = webhookConfig();
  if (!settings) {
    return fail(context, 503, 'service_unavailable', 'The billing service is temporarily unavailable.', 'configuration');
  }
  const contentType = request.headers.get('content-type');
  if (typeof contentType !== 'string'
      || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return fail(context, 400, 'invalid_request', 'The RevenueCat notification is not valid.');
  }
  const authorization = request.headers.get('authorization');
  if (typeof authorization !== 'string'
      || !constantTimeTextEqual(authorization, settings.authorization)) {
    return fail(context, 401, 'unauthorized', 'The RevenueCat notification is not authorized.', 'authentication');
  }

  let rawBody;
  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      return fail(context, 413, 'request_too_large', 'The RevenueCat notification exceeds the allowed size.');
    }
    return fail(context, 400, 'invalid_request', 'The RevenueCat notification is not valid.');
  }
  if (!verifyRevenueCatSignature(
    rawBody, request.headers.get('x-revenuecat-webhook-signature'), settings.signingSecret)) {
    return fail(context, 401, 'unauthorized', 'The RevenueCat notification is not authorized.', 'authentication');
  }
  let webhookPayload;
  try {
    webhookPayload = parseEvent(rawBody);
  } catch {
    return fail(context, 400, 'invalid_request', 'The RevenueCat notification is not valid.');
  }

  try {
    const bridgeRequest = signedBridgeRequest({
      ...settings.bridge,
      path: '/revenuecat-webhook',
      body: { request_id: context.requestId, payload: webhookPayload },
      timeoutMs: 25_000,
    });
    const response = await fetch(bridgeRequest.url, bridgeRequest.options);
    context.upstreamStatus = response.status;
    if (!response.ok || response.status !== 200) return upstreamFailure(response, context);
    let payload;
    try {
      payload = await readBridgeJson(response, 4096);
    } catch {
      return fail(context, 502, 'invalid_response', 'The billing service returned an invalid response.', 'invalid_response');
    }
    if (!hasExactKeys(payload, ['data'])
        || !hasExactKeys(payload.data, ['accepted']) || payload.data.accepted !== true) {
      return fail(context, 502, 'invalid_response', 'The billing service returned an invalid response.', 'invalid_response');
    }
    logRequest(context, 200);
    return Response.json({ ok: true }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return fail(context, 503, 'service_unavailable', 'The billing service is temporarily unavailable.',
      timedOut ? 'upstream_timeout' : 'upstream_transport');
  }
}

// Native Request avoids Vercel's Node helpers consuming the signed body first.
export default { fetch: handler };
