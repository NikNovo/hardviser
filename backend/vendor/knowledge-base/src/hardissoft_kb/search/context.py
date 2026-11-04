"""Trusted operator grants: never populated from request JSON."""
import hashlib
import json
import os
from pathlib import Path

_OPERATIONS = {'explain', 'rfq', 'quote_compare'}


def validate_context(context):
    if not isinstance(context, dict):
        raise ValueError('trusted context required')
    for key in ('principal_id', 'scope', 'allowed_collections', 'purpose', 'grant_fingerprint'):
        if not context.get(key):
            raise ValueError('missing trusted ' + key)
    if context['purpose'] not in ('internal_retrieval', 'customer_display', 'external_inference'):
        raise ValueError('unsupported purpose')
    if 'operation' in context and context['operation'] not in _OPERATIONS:
        raise ValueError('unsupported operation')
    scope = context['scope']
    if not isinstance(scope, dict) or scope.get('kind') not in ('global', 'user', 'project'):
        raise ValueError('invalid scope')
    if scope['kind'] != 'global' and not scope.get('tenant_id'):
        raise ValueError('tenant required')
    if scope['kind'] == 'user' and not scope.get('owner_user_id'):
        raise ValueError('owner required')
    if scope['kind'] == 'project' and not scope.get('project_id'):
        raise ValueError('project required')
    if not isinstance(context['allowed_collections'], list):
        raise ValueError('collections must be explicit')
    return dict(context)


def scope_allows(record_scope, grant_scope):
    if record_scope.get('kind') == 'global':
        return True
    if record_scope.get('kind') != grant_scope.get('kind'):
        return False
    keys = ('tenant_id', 'owner_user_id') if record_scope.get('kind') == 'user' else ('tenant_id', 'project_id')
    return all(record_scope.get(key) is not None and record_scope.get(key) == grant_scope.get(key) for key in keys)


def load_operator_context(path=None):
    data_home = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    default_root = Path(os.environ.get('HIS_KB_ROOT', str(data_home / 'hardviser' / 'knowledge-base')))
    configured = os.environ.get('HIS_KB_OPERATOR_CONFIG')
    path = Path(path or configured or default_root / 'runtime' / 'operator-context.json')
    stat = path.stat()
    if stat.st_mode & 0o077 or stat.st_uid != os.geteuid():
        raise PermissionError('operator grants must be owner-only')
    context = json.loads(path.read_text())
    context['grant_fingerprint'] = hashlib.sha256(json.dumps(context, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    context['operator'] = True
    return validate_context(context)


def cache_key(request, context, release_id, policy_revision, index_spec):
    operation = request.get('operation', context.get('operation', 'explain'))
    if operation not in _OPERATIONS:
        raise ValueError('unsupported operation')
    payload = [request, operation, context.get('operation', 'explain'), context['principal_id'],
               context['grant_fingerprint'], context['scope'], context['allowed_collections'],
               context['purpose'], release_id, policy_revision, index_spec]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
