"""Server-verified RevenueCat sandbox subscription snapshots and webhook recovery."""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import argparse
import json
import math
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

from psycopg.rows import dict_row

from . import appstore

_API_BASE = 'https://api.revenuecat.com'
_API_TIMEOUT_SECONDS = 2.5
_API_MAX_RESPONSE_BYTES = 1024 * 1024
_API_MAX_REQUESTS = 8
_API_MAX_PAGES = 5
_MAX_WEBHOOK_CUSTOMERS = 10
_MAX_INT64 = 9223372036854775807
_PLAN_RANK = {'free': 0, 'pro': 1, 'ultra_pro': 2, 'max': 3}
_KNOWN_ENTITLEMENTS = {'pro': 'pro', 'ultra_pro': 'ultra_pro', 'max': 'max'}
_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
_EVENT_TYPE = re.compile(r'^[A-Z][A-Z0-9_]{0,79}$')
_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
_AUTO_RENEWAL = frozenset((
    'will_renew', 'will_not_renew', 'will_change_product', 'will_pause',
    'requires_price_increase_consent', 'has_already_renewed'))
_SUBSCRIPTION_STATUSES = frozenset((
    'trialing', 'active', 'expired', 'in_grace_period', 'in_billing_retry',
    'paused', 'unknown', 'incomplete'))
_STORES = frozenset((
    'amazon', 'app_store', 'mac_app_store', 'play_store', 'promotional',
    'stripe', 'rc_billing', 'external', 'roku', 'paddle', 'paypal', 'galaxy',
    'test_store'))
_OWNERSHIP = frozenset(('purchased', 'family_shared', 'assigned'))
_PRODUCT_TYPES = frozenset(('subscription', 'one_time'))
_SYNC_EVENT_TYPES = frozenset((
    'INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'UNCANCELLATION',
    'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_PAUSED', 'EXPIRATION',
    'BILLING_ISSUE', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED',
    'REFUND_REVERSED', 'INVOICE_ISSUANCE', 'TEMPORARY_ENTITLEMENT_GRANT',
    'PURCHASE_REDEEMED', 'PRICE_INCREASE_CONSENT_REQUIRED',
    'PRICE_INCREASE_CONSENT_APPROVED'))


class ConfigurationError(RuntimeError):
    """RevenueCat sandbox configuration is incomplete or unsafe."""


class ProviderError(RuntimeError):
    """RevenueCat could not provide a valid current sandbox snapshot."""

    def __init__(self, message='provider request failed', *, category='provider'):
        self.category = category
        super().__init__(message)


@dataclass(frozen=True)
class RevenueCatConfig:
    api_key: str
    project_id: str
    app_id: str
    environment: str = 'sandbox'


def load_config(environ=None):
    """Read only sandbox credentials; production configuration is rejected."""
    source = os.environ if environ is None else environ
    if source.get('REVENUECAT_ENVIRONMENT') != 'sandbox':
        raise ConfigurationError('RevenueCat sandbox environment is required')
    api_key = source.get('REVENUECAT_API_KEY')
    project_id = source.get('REVENUECAT_PROJECT_ID')
    app_id = source.get('REVENUECAT_APP_ID')
    if (not isinstance(api_key, str) or not _valid_text(
            api_key, max_chars=500, max_bytes=500)
            or api_key != api_key.strip()
            or not isinstance(project_id, str) or not _ID.fullmatch(project_id)
            or not isinstance(app_id, str) or not _ID.fullmatch(app_id)):
        raise ConfigurationError('RevenueCat sandbox configuration is incomplete')
    return RevenueCatConfig(api_key=api_key, project_id=project_id, app_id=app_id)


def _valid_text(value, *, max_chars, max_bytes, allow_empty=False):
    if (not isinstance(value, str) or (not allow_empty and not value)
            or len(value) > max_chars or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        return False
    try:
        return len(value.encode('utf-8')) <= max_bytes
    except UnicodeEncodeError:
        return False


def _valid_identifier(value, *, max_chars=255):
    return (isinstance(value, str) and len(value) <= max_chars
            and _ID.fullmatch(value) is not None)


def _strict_uuid(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        return None
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return None
    return str(parsed) if str(parsed) == value.lower() else None


def _as_uuid(value):
    normalized = _strict_uuid(str(value)) if isinstance(value, uuid.UUID) else _strict_uuid(value)
    if normalized is None:
        raise ValueError('invalid user id')
    return uuid.UUID(normalized)


def _now(value=None):
    result = datetime.now(timezone.utc) if value is None else value
    if (not isinstance(result, datetime) or result.tzinfo is None
            or result.utcoffset() is None):
        raise ValueError('an aware UTC timestamp is required')
    return result.astimezone(timezone.utc)


def _iso(value):
    return value.isoformat() if value is not None else None


def _timestamp_from_ms(value, *, nullable=False):
    if value is None and nullable:
        return None
    if type(value) is not int or not 0 <= value <= _MAX_INT64:
        raise ProviderError('invalid RevenueCat timestamp', category='provider_schema')
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        raise ProviderError('invalid RevenueCat timestamp', category='provider_schema') from None


def _integer(value, *, nullable=False):
    if value is None and nullable:
        return True
    return type(value) is int and 0 <= value <= _MAX_INT64


def _finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _validate_list(value, expected_path):
    if (not isinstance(value, dict) or value.get('object') != 'list'
            or not {'object', 'items', 'next_page', 'url'}.issubset(value)
            or not isinstance(value.get('items'), list) or len(value['items']) > 100
            or not isinstance(value.get('url'), str)
            or value['url'] not in (expected_path, _API_BASE + expected_path)
            or (value.get('next_page') is not None
                and (not isinstance(value.get('next_page'), str) or not value['next_page']))):
        raise ProviderError('invalid RevenueCat list response', category='provider_schema')
    if value['next_page'] is not None and not value['items']:
        raise ProviderError('invalid RevenueCat pagination', category='provider_schema')
    return value



def _validate_customer_reference(value, config):
    required = {
        'object', 'id', 'project_id', 'first_seen_at', 'last_seen_at',
        'last_seen_app_version', 'last_seen_country', 'last_seen_platform',
        'last_seen_platform_version',
    }
    if not isinstance(value, dict) or not required.issubset(value):
        raise ProviderError('invalid RevenueCat customer', category='provider_schema')
    if (value.get('object') != 'customer'
            or not _valid_text(value.get('id'), max_chars=1500, max_bytes=1500)
            or value.get('project_id') != config.project_id
            or not _integer(value.get('first_seen_at'))
            or not _integer(value.get('last_seen_at'), nullable=True)):
        raise ProviderError('invalid RevenueCat customer fields', category='provider_schema')
    nullable_fields = {
        'last_seen_app_version': 255,
        'last_seen_country': 2,
        'last_seen_platform': 100,
        'last_seen_platform_version': 255,
    }
    if any(value.get(key) is not None and not _valid_text(
            value.get(key), max_chars=limit, max_bytes=limit * 4)
           for key, limit in nullable_fields.items()):
        raise ProviderError('invalid RevenueCat customer fields', category='provider_schema')

def _validate_subscription(value, config, customer_id):
    required = {
        'object', 'id', 'customer_id', 'original_customer_id', 'product_id', 'starts_at',
        'current_period_starts_at', 'current_period_ends_at', 'ends_at', 'gives_access',
        'pending_payment', 'auto_renewal_status', 'status', 'total_revenue_in_usd',
        'presented_offering_id', 'entitlements', 'environment', 'store',
        'store_subscription_identifier', 'ownership', 'management_url',
    }
    if not isinstance(value, dict) or not required.issubset(value):
        raise ProviderError('invalid RevenueCat subscription', category='provider_schema')
    if (value.get('object') != 'subscription' or not _valid_identifier(value.get('id'))
            or value.get('customer_id') != customer_id
            or not _valid_text(value.get('original_customer_id'), max_chars=1500, max_bytes=1500)
            or (value.get('product_id') is not None
                and not _valid_identifier(value.get('product_id')))
            or any(not _integer(value.get(key), nullable=key in ('current_period_ends_at', 'ends_at'))
                   for key in ('starts_at', 'current_period_starts_at',
                               'current_period_ends_at', 'ends_at'))
            or type(value.get('gives_access')) is not bool
            or type(value.get('pending_payment')) is not bool
            or value.get('auto_renewal_status') not in _AUTO_RENEWAL
            or value.get('status') not in _SUBSCRIPTION_STATUSES
            or value.get('environment') not in ('sandbox', 'production')
            or value.get('store') not in _STORES
            or not _valid_text(value.get('store_subscription_identifier'), max_chars=255, max_bytes=255)
            or value.get('ownership') not in _OWNERSHIP
            or (value.get('presented_offering_id') is not None
                and not _valid_text(value.get('presented_offering_id'), max_chars=200, max_bytes=200))
            or (value.get('management_url') is not None
                and not _valid_text(value.get('management_url'), max_chars=5000, max_bytes=5000))):
        raise ProviderError('invalid RevenueCat subscription fields', category='provider_schema')
    revenue = value.get('total_revenue_in_usd')
    if (not isinstance(revenue, dict)
            or not {'currency', 'gross', 'tax', 'proceeds'}.issubset(revenue)
            or not _valid_text(revenue.get('currency'), max_chars=3, max_bytes=3)
            or any(not _finite_number(revenue.get(key)) for key in ('gross', 'tax', 'proceeds'))
            or ('commission' in revenue and not _finite_number(revenue.get('commission')))):
        raise ProviderError('invalid RevenueCat revenue fields', category='provider_schema')
    entitlements_path = (
        f'/v2/projects/{quote(config.project_id, safe="")}/subscriptions/'
        f'{quote(value["id"], safe="")}/entitlements')
    _validate_list(value.get('entitlements'), entitlements_path)
    for entitlement in value['entitlements']['items']:
        _validate_entitlement(entitlement, config)
    if value['entitlements']['next_page'] is not None and not value['entitlements']['items']:
        raise ProviderError('invalid RevenueCat pagination', category='provider_schema')
    return value


def _validate_entitlement(value, config):
    required = {'object', 'project_id', 'id', 'lookup_key', 'display_name', 'state', 'created_at'}
    if not isinstance(value, dict) or not required.issubset(value):
        raise ProviderError('invalid RevenueCat entitlement', category='provider_schema')
    if (value.get('object') != 'entitlement'
            or value.get('project_id') != config.project_id
            or not _valid_identifier(value.get('id'))
            or not _valid_text(value.get('lookup_key'), max_chars=200, max_bytes=200)
            or not _valid_text(value.get('display_name'), max_chars=1500, max_bytes=6000)
            or value.get('state') not in ('active', 'inactive')
            or not _integer(value.get('created_at'))):
        raise ProviderError('invalid RevenueCat entitlement fields', category='provider_schema')
    products = value.get('products')
    if products is not None:
        products_path = (
            f'/v2/projects/{quote(config.project_id, safe="")}/entitlements/'
            f'{quote(value["id"], safe="")}/products')
        _validate_list(products, products_path)
        for product in products['items']:
            _validate_product(product)
        if products['next_page'] is not None and not products['items']:
            raise ProviderError('invalid RevenueCat pagination', category='provider_schema')


def _validate_product(value):
    required = {'object', 'id', 'store_identifier', 'type', 'state', 'created_at', 'app_id', 'display_name'}
    if not isinstance(value, dict) or not required.issubset(value):
        raise ProviderError('invalid RevenueCat product', category='provider_schema')
    display_name = value.get('display_name')
    if (value.get('object') != 'product'
            or not _valid_identifier(value.get('id'))
            or not _valid_text(value.get('store_identifier'), max_chars=255, max_bytes=255)
            or value.get('type') not in _PRODUCT_TYPES
            or value.get('state') not in ('active', 'inactive')
            or not _integer(value.get('created_at'))
            or not _valid_identifier(value.get('app_id'))
            or (display_name is not None
                and not _valid_text(display_name, max_chars=1500, max_bytes=6000))):
        raise ProviderError('invalid RevenueCat product fields', category='provider_schema')


def snapshot_from_subscriptions(customer_id, subscriptions, config, *, now=None):
    """Choose the highest known app entitlement that still grants access in sandbox."""
    normalized_customer = _strict_uuid(customer_id)
    if normalized_customer is None or not isinstance(subscriptions, list):
        raise ProviderError('invalid RevenueCat subscriptions', category='provider_schema')
    current_time = _now(now)
    best_plan = 'free'
    best_expiry = None
    for subscription in subscriptions:
        _validate_subscription(subscription, config, normalized_customer)
        if subscription['environment'] != 'sandbox':
            raise ProviderError('RevenueCat returned a non-sandbox subscription', category='provider_schema')
        if not subscription['gives_access']:
            continue
        expiry_ms = (subscription['ends_at'] if subscription['ends_at'] is not None
                     else subscription['current_period_ends_at'])
        expiry = _timestamp_from_ms(expiry_ms, nullable=True)
        if expiry is None or expiry <= current_time:
            continue
        for entitlement in subscription['entitlements']['items']:
            if entitlement['state'] != 'active':
                continue
            plan = _KNOWN_ENTITLEMENTS.get(entitlement['lookup_key'])
            if plan is None or plan not in _PLAN_RANK:
                continue
            products = entitlement.get('products')
            if products is None:
                continue
            grants_to_app = any(
                product['state'] == 'active' and product['app_id'] == config.app_id
                and product['id'] == subscription['product_id']
                for product in products['items'])
            if not grants_to_app:
                continue
            if (_PLAN_RANK[plan] > _PLAN_RANK[best_plan]
                    or (plan == best_plan and (best_expiry is None or expiry > best_expiry))):
                best_plan, best_expiry = plan, expiry
    return {'environment': 'sandbox', 'plan': best_plan, 'expires_at': _iso(best_expiry)}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _provider_get(path, config, timeout):
    parsed = urlsplit(path)
    if (parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith('/v2/')
            or '\\' in parsed.path):
        raise ProviderError('invalid RevenueCat request path', category='provider_schema')
    url = _API_BASE + path
    request = Request(url, headers={
        'Authorization': 'Bearer ' + config.api_key,
        'Accept': 'application/json',
    }, method='GET')
    opener = build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            if response.status != 200 or response.geturl() != url:
                return response.status, None
            if response.headers.get_content_type() != 'application/json':
                raise ProviderError('RevenueCat returned an unexpected content type', category='provider_schema')
            raw = response.read(_API_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _API_MAX_RESPONSE_BYTES:
                raise ProviderError('RevenueCat response exceeded its size limit', category='provider_schema')
            try:
                payload = json.loads(
                    raw.decode('utf-8'), object_pairs_hook=_unique_object,
                    parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
            except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
                raise ProviderError('RevenueCat returned invalid JSON', category='provider_schema') from None
            if not isinstance(payload, dict):
                raise ProviderError('RevenueCat returned an invalid response', category='provider_schema')
            return response.status, payload
    except HTTPError as error:
        return error.code, None
    except (URLError, TimeoutError, OSError, ValueError):
        raise ProviderError('RevenueCat request failed') from None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


class _RevenueCatAPI:
    def __init__(self, config, http_get=None):
        self.config = config
        self.http_get = _provider_get if http_get is None else http_get
        self.started = time.monotonic()
        self.requests = 0
        self.seen_pages = set()

    def get(self, path):
        if (self.requests >= _API_MAX_REQUESTS
                or time.monotonic() - self.started >= _API_TIMEOUT_SECONDS * _API_MAX_REQUESTS):
            raise ProviderError('RevenueCat pagination exceeded its bounds', category='provider_schema')
        self.requests += 1
        try:
            result = self.http_get(path, self.config, _API_TIMEOUT_SECONDS)
        except ProviderError:
            raise
        except Exception:
            raise ProviderError('RevenueCat request failed') from None
        if (not isinstance(result, tuple) or len(result) != 2
                or type(result[0]) is not int):
            raise ProviderError('RevenueCat returned an invalid response', category='provider_schema')
        return result

    def collect_pages(self, first_page, expected_path, validator, *, append_environment=False):
        items = []
        page = _validate_list(first_page, expected_path)
        page_count = 0
        while True:
            page_count += 1
            if page_count > _API_MAX_PAGES:
                raise ProviderError('RevenueCat pagination exceeded its bounds', category='provider_schema')
            for item in page['items']:
                validator(item)
                items.append(item)
            next_page = page['next_page']
            if next_page is None:
                return items
            cursor = page['items'][-1].get('id')
            next_path = _validated_next_page(
                next_page, expected_path, cursor, append_environment=append_environment)
            if next_path in self.seen_pages:
                raise ProviderError('RevenueCat repeated a pagination link', category='provider_schema')
            self.seen_pages.add(next_path)
            status, page_data = self.get(next_path)
            if status != 200 or not isinstance(page_data, dict):
                raise ProviderError('RevenueCat pagination request failed')
            page = _validate_list(page_data, expected_path)
            if not page['items'] and page['next_page'] is not None:
                raise ProviderError('RevenueCat returned an empty page with a continuation', category='provider_schema')


def _validated_next_page(value, expected_path, last_id, *, append_environment=False):
    try:
        parsed = urlsplit(value)
        if (((parsed.scheme or parsed.netloc) and f'{parsed.scheme}://{parsed.netloc}' != _API_BASE)
                or parsed.fragment or parsed.path != expected_path or not parsed.query):
            raise ValueError
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    except (ValueError, TypeError):
        raise ProviderError('invalid RevenueCat pagination URL', category='provider_schema') from None
    if (set(query) - {'starting_after', 'limit', 'environment', 'status'}
            or len(query.get('starting_after', ())) != 1
            or query['starting_after'][0] != last_id):
        raise ProviderError('invalid RevenueCat pagination cursor', category='provider_schema')
    if 'limit' in query:
        limit = query['limit']
        if len(limit) != 1 or not limit[0].isdigit() or not 1 <= int(limit[0]) <= 100:
            raise ProviderError('invalid RevenueCat pagination limit', category='provider_schema')
    if 'environment' in query and query['environment'] != ['sandbox']:
        raise ProviderError('invalid RevenueCat pagination environment', category='provider_schema')
    if 'status' in query and (len(query['status']) != 1
                              or query['status'][0] not in ('active', 'inactive')):
        raise ProviderError('invalid RevenueCat pagination status', category='provider_schema')
    if append_environment and 'environment' not in query:
        query['environment'] = ['sandbox']
    normalized_query = urlencode([(key, values[0]) for key, values in sorted(query.items())])
    return parsed.path + '?' + normalized_query


def fetch_customer_snapshot(customer_id, config, *, http_get=None, now=None):
    """Fetch and validate all sandbox subscription and nested entitlement pages."""
    normalized_customer = _strict_uuid(customer_id)
    if normalized_customer is None:
        raise ProviderError('invalid RevenueCat customer id', category='provider_schema')
    project = quote(config.project_id, safe='')
    customer = quote(normalized_customer, safe='')
    customers_path = f'/v2/projects/{project}/customers'
    api = _RevenueCatAPI(config, http_get)
    status, customer_list = api.get(
        customers_path + '?' + urlencode({'search': normalized_customer, 'limit': 2}))
    if status != 200 or not isinstance(customer_list, dict):
        raise ProviderError('RevenueCat customer lookup failed')
    customer_page = _validate_list(customer_list, customers_path)
    if customer_page['next_page'] is not None or len(customer_page['items']) > 2:
        raise ProviderError('invalid RevenueCat customer search results', category='provider_schema')
    for customer_record in customer_page['items']:
        _validate_customer_reference(customer_record, config)
    if not customer_page['items']:
        return None
    if len(customer_page['items']) != 1:
        raise ProviderError('ambiguous RevenueCat customer search results', category='provider_schema')

    subscriptions_path = f'{customers_path}/{customer}/subscriptions'
    status, first_page = api.get(subscriptions_path + '?environment=sandbox&limit=100')
    if status != 200 or not isinstance(first_page, dict):
        raise ProviderError('RevenueCat subscription lookup failed')
    subscriptions = api.collect_pages(
        first_page, subscriptions_path,
        lambda item: _validate_subscription(item, config, normalized_customer),
        append_environment=True)
    complete = []
    for subscription in subscriptions:
        entitlements_path = (
            f'/v2/projects/{project}/subscriptions/{quote(subscription["id"], safe="")}/entitlements')
        entitlements = api.collect_pages(
            subscription['entitlements'], entitlements_path,
            lambda item: _validate_entitlement(item, config))
        complete_entitlements = []
        for entitlement in entitlements:
            products_path = (
                f'/v2/projects/{project}/entitlements/{quote(entitlement["id"], safe="")}/products')
            products = entitlement.get('products')
            if products is None:
                status, products = api.get(products_path + '?limit=100')
                if status != 200 or not isinstance(products, dict):
                    raise ProviderError('RevenueCat entitlement products lookup failed')
            product_items = api.collect_pages(products, products_path, _validate_product)
            entitlement = {**entitlement, 'products': {
                'object': 'list', 'items': product_items, 'next_page': None,
                'url': products_path,
            }}
            complete_entitlements.append(entitlement)
        complete.append({**subscription, 'entitlements': {
            'object': 'list', 'items': complete_entitlements, 'next_page': None,
            'url': entitlements_path,
        }})
    return snapshot_from_subscriptions(normalized_customer, complete, config, now=now)


@contextmanager
def _connection(connection_factory=None):
    conn = (appstore.connect if connection_factory is None else connection_factory)()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _execute(conn, query, params=()):
    return conn.cursor(row_factory=dict_row).execute(query, params)


def _format_snapshot(row, *, now=None):
    current = _now(now)
    plan = row['plan']
    expires_at = row['expires_at']
    if plan not in _PLAN_RANK or row['environment'] != 'sandbox':
        raise ProviderError('invalid stored billing snapshot', category='provider_schema')
    if plan != 'free' and (expires_at is None or expires_at <= current):
        plan, expires_at = 'free', None
    if plan == 'free':
        expires_at = None
    return {
        'environment': 'sandbox', 'plan': plan,
        'expires_at': _iso(expires_at), 'verified_at': _iso(row['verified_at']),
    }


def status(conn, user_id, *, now=None):
    """Read the user's server snapshot; local expiry always fails closed."""
    load_config()
    user_uuid = _as_uuid(user_id)
    row = _execute(conn, '''SELECT environment,plan,expires_at,verified_at
        FROM revenuecat_billing_snapshots WHERE user_id=%s''', (user_uuid,)).fetchone()
    if row is None:
        return {'environment': 'sandbox', 'plan': 'free', 'expires_at': None, 'verified_at': None}
    return _format_snapshot(row, now=now)


def _normalized_provider_snapshot(value, *, now):
    if value is None:
        return {'environment': 'sandbox', 'plan': 'free', 'expires_at': None}
    if (not isinstance(value, dict) or value.get('environment') != 'sandbox'
            or value.get('plan') not in _PLAN_RANK):
        raise ProviderError('invalid RevenueCat snapshot', category='provider_schema')
    plan = value['plan']
    raw_expiry = value.get('expires_at')
    if raw_expiry is None:
        expiry = None
    elif isinstance(raw_expiry, datetime):
        if raw_expiry.tzinfo is None or raw_expiry.utcoffset() is None:
            raise ProviderError('invalid RevenueCat expiry', category='provider_schema')
        expiry = raw_expiry.astimezone(timezone.utc)
    elif isinstance(raw_expiry, str):
        try:
            expiry = datetime.fromisoformat(
                raw_expiry[:-1] + '+00:00' if raw_expiry.endswith('Z') else raw_expiry)
        except (ValueError, OverflowError):
            raise ProviderError('invalid RevenueCat expiry', category='provider_schema') from None
        if expiry.tzinfo is None or expiry.utcoffset() is None:
            raise ProviderError('invalid RevenueCat expiry', category='provider_schema')
        expiry = expiry.astimezone(timezone.utc)
    else:
        raise ProviderError('invalid RevenueCat expiry', category='provider_schema')
    if plan == 'free':
        if expiry is not None:
            raise ProviderError('invalid free RevenueCat snapshot', category='provider_schema')
    elif expiry is None or expiry <= now:
        plan, expiry = 'free', None
    return {'environment': 'sandbox', 'plan': plan, 'expires_at': expiry}


def _save_snapshot(conn, user_id, value, *, verified_at, fetch_started_at):
    user_uuid = _as_uuid(user_id)
    snapshot = _normalized_provider_snapshot(value, now=fetch_started_at)
    _execute(conn, '''INSERT INTO revenuecat_billing_snapshots
        (user_id,environment,plan,expires_at,verified_at)
        VALUES (%s,'sandbox',%s,%s,%s)
        ON CONFLICT (user_id) DO UPDATE SET
          environment=EXCLUDED.environment,plan=EXCLUDED.plan,
          expires_at=EXCLUDED.expires_at,verified_at=EXCLUDED.verified_at
        WHERE revenuecat_billing_snapshots.verified_at <= %s''',
        (user_uuid, snapshot['plan'], snapshot['expires_at'], verified_at, fetch_started_at))


def _fetch_state(customer_id, config, fetcher, *, now):
    if fetcher is None:
        return fetch_customer_snapshot(customer_id, config, now=now)
    return fetcher(str(customer_id), config)


def sync_user(user_id, *, fetcher=None, connection_factory=None, now=None):
    """Fetch provider state before opening a DB transaction, then persist it atomically."""
    config = load_config()
    normalized = str(_as_uuid(user_id))
    fetch_started_at = _now(now)
    provider_state = _fetch_state(normalized, config, fetcher, now=fetch_started_at)
    verified_at = _now(now)
    with _connection(connection_factory) as conn:
        _save_snapshot(
            conn, normalized, provider_state, verified_at=verified_at,
            fetch_started_at=fetch_started_at)
        row = _execute(conn, '''SELECT environment,plan,expires_at,verified_at
            FROM revenuecat_billing_snapshots WHERE user_id=%s''',
            (_as_uuid(normalized),)).fetchone()
    if row is None:
        raise ProviderError('billing snapshot was not persisted', category='database')
    return _format_snapshot(row, now=verified_at)


def _webhook_fields(payload, config):
    if (not isinstance(payload, dict) or payload.get('api_version') != '1.0'
            or not isinstance(payload.get('event'), dict)):
        raise ValueError('invalid RevenueCat webhook body')
    event = payload['event']
    event_id = event.get('id')
    event_type = event.get('type')
    timestamp = event.get('event_timestamp_ms')
    if (not _valid_text(event_id, max_chars=255, max_bytes=255)
            or not isinstance(event_type, str) or not _EVENT_TYPE.fullmatch(event_type)
            or not _integer(timestamp)):
        raise ValueError('invalid RevenueCat webhook event')
    app_id = event.get('app_id')
    if app_id is not None and not _valid_identifier(app_id):
        raise ValueError('invalid RevenueCat webhook app')
    raw_environment = event.get('environment')
    if raw_environment is None:
        environment = 'unknown'
    elif raw_environment == 'SANDBOX':
        environment = 'sandbox'
    elif raw_environment == 'PRODUCTION':
        environment = 'production'
    else:
        raise ValueError('invalid RevenueCat webhook environment')

    candidate_ids = []
    if event_type == 'TRANSFER':
        for field in ('transferred_from', 'transferred_to'):
            ids = event.get(field)
            if (not isinstance(ids, list) or len(ids) > 100
                    or any(not _valid_text(item, max_chars=1500, max_bytes=1500) for item in ids)):
                raise ValueError('invalid RevenueCat transfer event')
            candidate_ids.extend(
                normalized for item in ids if (normalized := _strict_uuid(item)) is not None)
    elif event_type in _SYNC_EVENT_TYPES:
        app_user_id = event.get('app_user_id')
        if not _valid_text(app_user_id, max_chars=1500, max_bytes=1500):
            raise ValueError('invalid RevenueCat customer event')
        if event_type != 'TEMPORARY_ENTITLEMENT_GRANT':
            aliases = event.get('aliases')
            original = event.get('original_app_user_id')
            if (not isinstance(aliases, list) or len(aliases) > 100
                    or any(not _valid_text(alias, max_chars=1500, max_bytes=1500)
                           for alias in aliases)
                    or not _valid_text(original, max_chars=1500, max_bytes=1500)):
                raise ValueError('invalid RevenueCat subscriber identity')
        normalized = _strict_uuid(app_user_id)
        if normalized is not None:
            candidate_ids.append(normalized)

    known_event = event_type in _SYNC_EVENT_TYPES or event_type == 'TRANSFER'
    disposition = (
        'process' if known_event and environment == 'sandbox'
        and (app_id is None or app_id == config.app_id) else 'ignore')
    candidate_ids = list(dict.fromkeys(candidate_ids))
    if len(candidate_ids) > _MAX_WEBHOOK_CUSTOMERS:
        disposition = 'ignore'
        candidate_ids = []
    if not candidate_ids:
        disposition = 'ignore'
    return {
        'environment': environment, 'event_id': event_id,
        'event_type': event_type, 'app_id': app_id,
        'candidate_ids': candidate_ids, 'disposition': disposition,
    }

def _event_users(conn, environment, event_id):
    return [str(row['user_id']) for row in _execute(conn, '''SELECT eu.user_id
        FROM revenuecat_webhook_event_users eu
        JOIN users u ON u.id=eu.user_id
        WHERE eu.environment=%s AND eu.event_id=%s AND u.disabled_at IS NULL
        ORDER BY eu.user_id''', (environment, event_id)).fetchall()]


def _set_event_status(conn, environment, event_id, new_status, *, completed_at):
    _execute(conn, '''UPDATE revenuecat_webhook_events SET status=%s,completed_at=%s,
        last_error=NULL WHERE environment=%s AND event_id=%s AND status='pending' ''',
        (new_status, completed_at, environment, event_id))


def _record_event(fields, *, connection_factory=None, now=None):
    received_at = _now(now)
    with _connection(connection_factory) as conn:
        inserted = _execute(conn, '''INSERT INTO revenuecat_webhook_events
            (environment,event_id,event_type,app_id,status,received_at)
            VALUES (%s,%s,%s,%s,'pending',%s)
            ON CONFLICT (environment,event_id) DO NOTHING
            RETURNING event_id''',
            (fields['environment'], fields['event_id'], fields['event_type'], fields['app_id'], received_at)).fetchone()
        if inserted is None:
            row = _execute(conn, '''SELECT status FROM revenuecat_webhook_events
                WHERE environment=%s AND event_id=%s FOR UPDATE''',
                (fields['environment'], fields['event_id'])).fetchone()
            if row is None or row['status'] != 'pending':
                return 'duplicate', []
            users = _event_users(conn, fields['environment'], fields['event_id'])
            if not users:
                _set_event_status(conn, fields['environment'], fields['event_id'], 'ignored', completed_at=received_at)
                return 'ignored', []
            return 'pending', users
        if fields['disposition'] != 'process':
            _set_event_status(conn, fields['environment'], fields['event_id'], 'ignored', completed_at=received_at)
            return 'ignored', []
        users = []
        for candidate in fields['candidate_ids']:
            row = _execute(conn, '''SELECT id FROM users
                WHERE id=%s AND disabled_at IS NULL''', (_as_uuid(candidate),)).fetchone()
            if row is None:
                continue
            user_id = str(row['id'])
            _execute(conn, '''INSERT INTO revenuecat_webhook_event_users
                (environment,event_id,user_id) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING''',
                (fields['environment'], fields['event_id'], row['id']))
            users.append(user_id)
        if not users:
            _set_event_status(conn, fields['environment'], fields['event_id'], 'ignored', completed_at=received_at)
            return 'ignored', []
        return 'pending', users


def _record_failure(environment, event_id, category, *, connection_factory=None, now=None):
    current = _now(now)
    safe_category = category if category in ('configuration', 'provider', 'provider_schema', 'database') else 'provider'
    try:
        with _connection(connection_factory) as conn:
            _execute(conn, '''UPDATE revenuecat_webhook_events SET
                attempt_count=attempt_count+1,last_attempt_at=%s,last_error=%s
                WHERE environment=%s AND event_id=%s AND status='pending' ''',
                (current, safe_category, environment, event_id))
    except Exception:
        # The event remains pending even if recording retry metadata is unavailable.
        pass


def _retry_event(environment, event_id, candidate_ids, config, *, fetcher=None,
                 connection_factory=None, now=None):
    fetch_started_at = _now(now)
    states = []
    try:
        for customer_id in candidate_ids:
            states.append((customer_id, _fetch_state(
                customer_id, config, fetcher, now=fetch_started_at)))
        verified_at = _now(now)
        with _connection(connection_factory) as conn:
            for customer_id, state_value in states:
                _save_snapshot(
                    conn, customer_id, state_value, verified_at=verified_at,
                    fetch_started_at=fetch_started_at)
            _execute(conn, '''UPDATE revenuecat_webhook_events SET
                status='processed',attempt_count=attempt_count+1,
                last_attempt_at=%s,last_error=NULL,completed_at=%s
                WHERE environment=%s AND event_id=%s AND status='pending' ''',
                (verified_at, verified_at, environment, event_id))
    except ConfigurationError:
        _record_failure(environment, event_id, 'configuration',
                        connection_factory=connection_factory, now=now)
        raise
    except ProviderError as error:
        _record_failure(environment, event_id, error.category,
                        connection_factory=connection_factory, now=now)
        raise
    except Exception:
        _record_failure(environment, event_id, 'provider',
                        connection_factory=connection_factory, now=now)
        raise ProviderError('RevenueCat reconciliation failed') from None
    return 'processed'


def process_webhook(payload, *, fetcher=None, connection_factory=None, now=None):
    """Durably deduplicate a signed bridge event, then reconcile only exact local UUIDs."""
    config = load_config()
    fields = _webhook_fields(payload, config)
    status_value, candidate_ids = _record_event(
        fields, connection_factory=connection_factory, now=now)
    if status_value in ('duplicate', 'ignored'):
        return status_value
    return _retry_event(
        fields['environment'], fields['event_id'], candidate_ids, config,
        fetcher=fetcher, connection_factory=connection_factory, now=now)


def recover_pending_events(*, limit=20, fetcher=None, connection_factory=None):
    """Retry sandbox webhook rows after RevenueCat's finite delivery retry window."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('limit must be between 1 and 100')
    config = load_config()
    with _connection(connection_factory) as conn:
        events = _execute(conn, '''SELECT environment,event_id
            FROM revenuecat_webhook_events WHERE status='pending' AND environment='sandbox'
            ORDER BY received_at,event_id LIMIT %s''', (limit,)).fetchall()
        work = [(row['environment'], row['event_id'], _event_users(
            conn, row['environment'], row['event_id'])) for row in events]
    completed = failed = ignored = 0
    for environment, event_id, candidates in work:
        if not candidates:
            with _connection(connection_factory) as conn:
                _set_event_status(conn, environment, event_id, 'ignored', completed_at=_now())
            ignored += 1
            continue
        try:
            _retry_event(
                environment, event_id, candidates, config, fetcher=fetcher,
                connection_factory=connection_factory)
            completed += 1
        except (ProviderError, ConfigurationError):
            failed += 1
    return {'completed': completed, 'failed': failed, 'ignored': ignored}


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Recover durable pending RevenueCat sandbox webhook reconciliations.')
    parser.add_argument('--recover-pending', action='store_true',
                        help='reconcile pending sandbox events using current RevenueCat state')
    parser.add_argument('--limit', type=int, default=20,
                        help='maximum pending events to process (1–100; default 20)')
    arguments = parser.parse_args(argv)
    if not arguments.recover_pending:
        parser.error('use --recover-pending')
    try:
        result = recover_pending_events(limit=arguments.limit)
    except (ConfigurationError, ValueError):
        print(json.dumps({'event': 'revenuecat_pending_recovery', 'status': 'unavailable'}), file=sys.stderr)
        return 1
    print(json.dumps({'event': 'revenuecat_pending_recovery', **result}, separators=(',', ':')))
    return 1 if result['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
