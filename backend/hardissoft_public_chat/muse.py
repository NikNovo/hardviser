"""Bounded MUSE Standard calls: one submission per stage, schema-constrained JSON, no content logging."""
import json
import os
import time
import urllib.error
import urllib.request

from . import state

ENDPOINT = 'https://api.meta.ai/v1/chat/completions'
MODEL = 'muse-spark-1.3'
RESPONSE_LIMIT = 64 * 1024
# The maximum request body includes a 48 KiB inbound request, 16 KiB of evidence,
# and prompt/schema overhead. Keep the serialized body capped at each stage.
STAGES = {
    'plan': {'max_bytes': 64 * 1024, 'max_completion_tokens': 1000, 'reasoning_effort': 'minimal'},
    'answer': {'max_bytes': 96 * 1024, 'max_completion_tokens': 6000, 'reasoning_effort': 'low'},
}
_ROLES = ('developer', 'user')


class Unavailable(RuntimeError):
    """No credential is configured; nothing was submitted."""


class ProviderError(RuntimeError):
    """The provider answered without a usable result; never resent automatically."""

    def __init__(self, message, *, http_status=None):
        self.http_status = http_status
        super().__init__(message)


class AmbiguousOutcome(RuntimeError):
    """The submission outcome is unknown; never resent automatically."""

    def __init__(self, message, *, http_status=None):
        self.http_status = http_status
        super().__init__(message)


class ProviderTimeout(TimeoutError):
    """The provider deadline expired; the submission receipt is ambiguous and is never retried."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _read_response(response, limit, deadline):
    try:
        sock = response.fp.raw._sock
    except AttributeError:
        raise ProviderError('MUSE response stream is unavailable') from None
    raw = bytearray()
    while len(raw) <= limit:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('MUSE response deadline exceeded')
        sock.settimeout(remaining)
        chunk = response.read1(min(8192, limit + 1 - len(raw)))
        if not chunk:
            break
        raw.extend(chunk)
    if len(raw) > limit:
        raise ProviderError('MUSE response exceeds 64 KiB')
    return bytes(raw)


def _post(body, token, timeout, url=ENDPOINT, *, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    })
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('MUSE request deadline exceeded')
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=remaining) as response:
        raw = _read_response(response, RESPONSE_LIMIT, deadline)
    return raw


def complete(messages, *, request_id, stage, schema_name, schema, timeout):
    config = STAGES.get(stage)
    if config is None:
        raise ValueError('stage must be plan or answer')
    if not isinstance(messages, list) or not 1 <= len(messages) <= 16:
        raise ValueError('bounded chat messages required')
    for message in messages:
        if not isinstance(message, dict) or set(message) != {'role', 'content'} \
                or message['role'] not in _ROLES or not isinstance(message['content'], str):
            raise ValueError('chat messages must contain only developer/user text')
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ValueError('positive timeout required')
    deadline = time.monotonic() + timeout
    payload = {
        'model': MODEL,
        'messages': messages,
        'max_completion_tokens': config['max_completion_tokens'],
        'reasoning_effort': config['reasoning_effort'],
        'response_format': {'type': 'json_schema', 'json_schema': {'name': schema_name, 'schema': schema}},
        'stream': False,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(body) > config['max_bytes']:
        raise ValueError('MUSE stage payload exceeds its byte limit')
    token = os.environ.get('MODEL_API_KEY')
    if not token:
        raise Unavailable('MUSE credential unavailable; nothing submitted')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProviderTimeout('MUSE stage deadline expired before submission')
    try:
        state.begin_provider_attempt(request_id, stage)
    except state.StageAlreadyAttempted:
        raise ProviderError('MUSE stage already submitted; not resending') from None
    try:
        raw = _post(body, token, timeout, deadline=deadline)
    except urllib.error.HTTPError as exc:
        definitive = 400 <= exc.code < 500 and exc.code not in (408, 409, 429)
        state.finish_provider_attempt(request_id, stage, 'failed' if definitive else 'ambiguous')
        error_type = ProviderError if definitive else AmbiguousOutcome
        raise error_type('MUSE HTTP %d; body omitted' % exc.code, http_status=exc.code) from None
    except TimeoutError:
        state.finish_provider_attempt(request_id, stage, 'ambiguous')
        raise ProviderTimeout('MUSE outcome unknown after deadline; not resending') from None
    except ProviderError:
        state.finish_provider_attempt(request_id, stage, 'failed')
        raise
    except Exception:
        state.finish_provider_attempt(request_id, stage, 'ambiguous')
        raise AmbiguousOutcome('MUSE outcome unknown; not resending') from None
    try:
        data = json.loads(raw)
        choice = data['choices'][0]
        content = choice['message']['content']
        prompt_tokens = data['usage']['prompt_tokens']
        completion_tokens = data['usage']['completion_tokens']
        if data.get('model') != MODEL or choice.get('finish_reason') != 'stop' or not isinstance(content, str):
            raise ValueError('unusable MUSE response')
        if any(type(value) is not int or value < 0 for value in (prompt_tokens, completion_tokens)) \
                or completion_tokens > config['max_completion_tokens']:
            raise ValueError('invalid MUSE usage')
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError('MUSE content is not a JSON object')
    except Exception:
        state.finish_provider_attempt(request_id, stage, 'failed')
        raise ProviderError('MUSE response could not be validated') from None
    state.finish_provider_attempt(request_id, stage, 'succeeded')
    return {'data': parsed, 'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens}}
