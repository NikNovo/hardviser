"""Sandbox billing snapshot, provider verification, and webhook isolation tests."""
from datetime import datetime, timedelta, timezone

import pytest

from hardissoft_public_chat import appstore, billing

PROJECT_ID = 'proj73c96e0c'
APP_ID = 'app96e448cc36'
USER_ONE = '123e4567-e89b-42d3-a456-426614174000'
USER_TWO = '123e4567-e89b-42d3-a456-426614174001'
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def _configure(monkeypatch):
    monkeypatch.setenv('REVENUECAT_ENVIRONMENT', 'sandbox')
    monkeypatch.setenv('REVENUECAT_API_KEY', 'sandbox-secret-key')
    monkeypatch.setenv('REVENUECAT_PROJECT_ID', PROJECT_ID)
    monkeypatch.setenv('REVENUECAT_APP_ID', APP_ID)


def _user(conn, user_id):
    conn.execute('INSERT INTO users(id,login,password_hash) VALUES (%s,%s,%s)',
                 (user_id, f'user-{user_id[-1]}', 'not-used-in-this-test'))


def _subscription(customer_id, entitlements, *, sub_id='sub1', gives_access=True,
                  expires_at_ms=None, environment='sandbox'):
    expires_at_ms = expires_at_ms or int((NOW + timedelta(days=30)).timestamp() * 1000)
    return {
        'object': 'subscription', 'id': sub_id, 'customer_id': customer_id,
        'original_customer_id': customer_id, 'product_id': 'prod1',
        'starts_at': int((NOW - timedelta(days=1)).timestamp() * 1000),
        'current_period_starts_at': int((NOW - timedelta(days=1)).timestamp() * 1000),
        'current_period_ends_at': expires_at_ms, 'ends_at': expires_at_ms,
        'gives_access': gives_access, 'pending_payment': False,
        'auto_renewal_status': 'will_renew', 'status': 'active',
        'total_revenue_in_usd': {'currency': 'USD', 'gross': 19.0, 'tax': 0.0, 'proceeds': 19.0},
        'presented_offering_id': 'ofrngbad4c67484',
        'entitlements': {
            'object': 'list', 'items': entitlements, 'next_page': None,
            'url': f'https://api.revenuecat.com/v2/projects/{PROJECT_ID}/subscriptions/{sub_id}/entitlements',
        },
        'environment': environment, 'store': 'stripe',
        'store_subscription_identifier': 'subscription-1', 'ownership': 'purchased',
        'management_url': None,
    }


def _entitlement(key, product_app_id=APP_ID, *, state='active', entitlement_id=None):
    entitlement_id = entitlement_id or f'entl-{key}'
    return {
        'object': 'entitlement', 'project_id': PROJECT_ID, 'id': entitlement_id,
        'lookup_key': key, 'display_name': key.title(), 'state': state,
        'created_at': 1793793600000,
        'products': {
            'object': 'list', 'items': [{
                'object': 'product', 'id': 'prod1', 'store_identifier': f'{key}_monthly',
                'type': 'subscription', 'state': 'active', 'created_at': 1793793600000,
                'app_id': product_app_id, 'display_name': key.title(),
            }],
            'next_page': None,
            'url': f'https://api.revenuecat.com/v2/projects/{PROJECT_ID}/entitlements/{entitlement_id}/products',
        },
    }


def _webhook(event_id, *, user_id=USER_ONE, aliases=(), event_type='INITIAL_PURCHASE', **extra):
    event = {
        'id': event_id, 'type': event_type,
        'event_timestamp_ms': int(NOW.timestamp() * 1000),
        'app_id': APP_ID, 'environment': 'SANDBOX',
        'app_user_id': user_id, 'original_app_user_id': user_id,
        'aliases': list(aliases),
        **extra,
    }
    return {'api_version': '1.0', 'event': event}


def test_configuration_refuses_production_and_missing_server_secrets(monkeypatch):
    _configure(monkeypatch)
    monkeypatch.setenv('REVENUECAT_ENVIRONMENT', 'production')
    with pytest.raises(billing.ConfigurationError):
        billing.load_config()

    monkeypatch.setenv('REVENUECAT_ENVIRONMENT', 'sandbox')
    monkeypatch.delenv('REVENUECAT_API_KEY')
    with pytest.raises(billing.ConfigurationError):
        billing.load_config()


def test_snapshot_status_is_user_isolated_and_expiry_fails_closed(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    _user(app_db, USER_TWO)
    app_db.execute('''INSERT INTO revenuecat_billing_snapshots
        (user_id,environment,plan,expires_at,verified_at)
        VALUES (%s,'sandbox','max',%s,%s)''',
        (USER_ONE, NOW - timedelta(seconds=1), NOW - timedelta(days=1)))
    app_db.commit()

    expired = billing.status(app_db, USER_ONE, now=NOW)
    isolated = billing.status(app_db, USER_TWO, now=NOW)
    assert expired == {
        'environment': 'sandbox', 'plan': 'free', 'expires_at': None,
        'verified_at': (NOW - timedelta(days=1)).isoformat(),
    }
    assert isolated == {
        'environment': 'sandbox', 'plan': 'free', 'expires_at': None, 'verified_at': None,
    }


def test_provider_failure_does_not_erase_existing_paid_snapshot(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    expiry = NOW + timedelta(days=20)
    app_db.execute('''INSERT INTO revenuecat_billing_snapshots
        (user_id,environment,plan,expires_at,verified_at)
        VALUES (%s,'sandbox','pro',%s,%s)''', (USER_ONE, expiry, NOW))
    app_db.commit()

    def unavailable(_customer_id, _config):
        raise billing.ProviderError('provider request failed')

    with pytest.raises(billing.ProviderError):
        billing.sync_user(USER_ONE, fetcher=unavailable, now=NOW)
    assert billing.status(app_db, USER_ONE, now=NOW) == {
        'environment': 'sandbox', 'plan': 'pro', 'expires_at': expiry.isoformat(),
        'verified_at': NOW.isoformat(),
    }


def test_sync_with_no_revenuecat_customer_records_verified_free(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    app_db.commit()

    result = billing.sync_user(USER_ONE, fetcher=lambda _customer_id, _config: None, now=NOW)
    assert result == {
        'environment': 'sandbox', 'plan': 'free', 'expires_at': None,
        'verified_at': NOW.isoformat(),
    }
    assert billing.status(app_db, USER_ONE, now=NOW) == result


def test_api_distinguishes_verified_no_customer_from_provider_not_found(monkeypatch):
    _configure(monkeypatch)
    config = billing.load_config()
    customer_path = f'/v2/projects/{PROJECT_ID}/customers?search={USER_ONE}&limit=2'
    empty_customers = {
        'object': 'list', 'items': [], 'next_page': None,
        'url': f'/v2/projects/{PROJECT_ID}/customers',
    }

    def no_customer(path, *_args):
        if path != customer_path:
            pytest.fail(f'unexpected provider path: {path}')
        return 200, empty_customers

    assert billing.fetch_customer_snapshot(
        USER_ONE, config, http_get=no_customer, now=NOW) is None

    with pytest.raises(billing.ProviderError):
        billing.fetch_customer_snapshot(
            USER_ONE, config,
            http_get=lambda *_args: (404, None),
            now=NOW,
        )



def test_api_reads_only_validated_customer_and_subscription_resources(monkeypatch):
    _configure(monkeypatch)
    config = billing.load_config()
    customer_path = f'/v2/projects/{PROJECT_ID}/customers'
    customer_search = f'{customer_path}?search={USER_ONE}&limit=2'
    subscriptions_path = f'{customer_path}/{USER_ONE}/subscriptions'
    expiry_ms = int((NOW + timedelta(days=12)).timestamp() * 1000)
    subscription = _subscription(
        USER_ONE, [_entitlement('ultra_pro')], sub_id='api-sub', expires_at_ms=expiry_ms)
    products = subscription['entitlements']['items'][0].pop('products')
    customer = {
        'object': 'customer', 'id': USER_ONE, 'project_id': PROJECT_ID,
        'first_seen_at': int(NOW.timestamp() * 1000), 'last_seen_at': None,
        'last_seen_app_version': None, 'last_seen_country': None,
        'last_seen_platform': None, 'last_seen_platform_version': None,
    }
    customer_page = {
        'object': 'list', 'items': [customer], 'next_page': None,
        'url': 'https://api.revenuecat.com' + customer_path,
    }
    subscription_page = {
        'object': 'list', 'items': [subscription], 'next_page': None,
        'url': 'https://api.revenuecat.com' + subscriptions_path,
    }

    def http_get(path, _config, timeout):
        if path == customer_search:
            return 200, customer_page
        if path == subscriptions_path + '?environment=sandbox&limit=100':
            return 200, subscription_page
        if path == f'/v2/projects/{PROJECT_ID}/entitlements/entl-ultra_pro/products?limit=100':
            return 200, products
        pytest.fail(f'unexpected provider path: {path}')

    result = billing.fetch_customer_snapshot(USER_ONE, config, http_get=http_get, now=NOW)
    assert result == {
        'environment': 'sandbox', 'plan': 'ultra_pro',
        'expires_at': (NOW + timedelta(days=12)).isoformat(),
    }


def test_api_rejects_untrusted_pagination_before_following_it(monkeypatch):
    _configure(monkeypatch)
    config = billing.load_config()
    customer_path = f'/v2/projects/{PROJECT_ID}/customers'
    customer_search = f'{customer_path}?search={USER_ONE}&limit=2'
    subscriptions_path = f'{customer_path}/{USER_ONE}/subscriptions'
    customer = {
        'object': 'customer', 'id': USER_ONE, 'project_id': PROJECT_ID,
        'first_seen_at': int(NOW.timestamp() * 1000), 'last_seen_at': None,
        'last_seen_app_version': None, 'last_seen_country': None,
        'last_seen_platform': None, 'last_seen_platform_version': None,
    }
    customer_page = {
        'object': 'list', 'items': [customer], 'next_page': None, 'url': customer_path,
    }
    subscription = _subscription(
        USER_ONE, [_entitlement('pro')], sub_id='page-sub')
    subscription_page = {
        'object': 'list', 'items': [subscription],
        'next_page': 'https://attacker.test/v2/projects/elsewhere/subscriptions?starting_after=page-sub',
        'url': subscriptions_path,
    }
    paths = []

    def http_get(path, _config, _timeout):
        paths.append(path)
        if path == customer_search:
            return 200, customer_page
        if path == subscriptions_path + '?environment=sandbox&limit=100':
            return 200, subscription_page
        pytest.fail(f'untrusted continuation was followed: {path}')

    with pytest.raises(billing.ProviderError):
        billing.fetch_customer_snapshot(USER_ONE, config, http_get=http_get, now=NOW)
    assert paths == [customer_search, subscriptions_path + '?environment=sandbox&limit=100']

def test_sync_only_uses_gives_access_future_expiry_known_entitlement_and_configured_app(monkeypatch):
    _configure(monkeypatch)
    config = billing.load_config()
    expiry_ms = int((NOW + timedelta(days=10)).timestamp() * 1000)
    subscriptions = [
        _subscription(USER_ONE, [_entitlement('pro')], sub_id='pro-sub', expires_at_ms=expiry_ms),
        _subscription(USER_ONE, [_entitlement('max', product_app_id='another-app')],
                      sub_id='wrong-app', expires_at_ms=expiry_ms),
        _subscription(USER_ONE, [_entitlement('ultra_pro')], sub_id='no-access',
                      gives_access=False, expires_at_ms=expiry_ms),
        _subscription(USER_ONE, [_entitlement('max')], sub_id='expired',
                      expires_at_ms=int((NOW - timedelta(seconds=1)).timestamp() * 1000)),
    ]

    result = billing.snapshot_from_subscriptions(USER_ONE, subscriptions, config, now=NOW)
    assert result['plan'] == 'pro'
    assert result['expires_at'] == (NOW + timedelta(days=10)).isoformat()


def test_shared_entitlement_cannot_grant_access_for_another_apps_product(monkeypatch):
    _configure(monkeypatch)
    entitlement = _entitlement('max', product_app_id='another-app')
    foreign_product = entitlement['products']['items'][0]
    entitlement['products']['items'].append({
        **foreign_product, 'id': 'different-product', 'app_id': APP_ID,
    })
    subscription = _subscription(USER_ONE, [entitlement])
    result = billing.snapshot_from_subscriptions(USER_ONE, [subscription], billing.load_config(), now=NOW)
    assert result == {'environment': 'sandbox', 'plan': 'free', 'expires_at': None}


def test_webhook_replay_and_aliases_cannot_grant_another_account(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    _user(app_db, USER_TWO)
    app_db.commit()
    expiry = NOW + timedelta(days=15)

    def provider_state(customer_id, _config):
        assert customer_id == USER_ONE
        return {'environment': 'sandbox', 'plan': 'pro', 'expires_at': expiry}

    original = _webhook('evt-shared', aliases=(USER_TWO, 'owner@example.test'))
    assert billing.process_webhook(original, fetcher=provider_state, now=NOW) == 'processed'

    forged_alias_replay = _webhook('evt-shared', user_id=USER_TWO, aliases=(USER_ONE,))
    assert billing.process_webhook(forged_alias_replay, fetcher=provider_state, now=NOW) == 'duplicate'
    assert billing.status(app_db, USER_ONE, now=NOW)['plan'] == 'pro'
    assert billing.status(app_db, USER_TWO, now=NOW)['plan'] == 'free'


def test_transfer_reconciles_exact_user_ids_without_sharing_snapshot(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    _user(app_db, USER_TWO)
    old_expiry = NOW + timedelta(days=7)
    app_db.execute('''INSERT INTO revenuecat_billing_snapshots
        (user_id,environment,plan,expires_at,verified_at)
        VALUES (%s,'sandbox','max',%s,%s)''', (USER_ONE, old_expiry, NOW - timedelta(days=1)))
    app_db.commit()
    new_expiry = NOW + timedelta(days=25)
    looked_up = []

    def provider_state(customer_id, _config):
        looked_up.append(customer_id)
        if customer_id == USER_ONE:
            return None
        assert customer_id == USER_TWO
        return {'environment': 'sandbox', 'plan': 'ultra_pro', 'expires_at': new_expiry}

    transfer = _webhook(
        'evt-transfer', user_id=USER_TWO, event_type='TRANSFER',
        transferred_from=[USER_ONE], transferred_to=[USER_TWO],
    )
    assert billing.process_webhook(transfer, fetcher=provider_state, now=NOW) == 'processed'
    assert set(looked_up) == {USER_ONE, USER_TWO}
    assert billing.status(app_db, USER_ONE, now=NOW)['plan'] == 'free'
    assert billing.status(app_db, USER_TWO, now=NOW)['plan'] == 'ultra_pro'


def test_production_webhook_is_recorded_but_never_grants_sandbox_access(app_db, monkeypatch):
    _configure(monkeypatch)
    _user(app_db, USER_ONE)
    app_db.commit()
    calls = []
    payload = _webhook('evt-production', environment='PRODUCTION')

    result = billing.process_webhook(
        payload, fetcher=lambda *_args: calls.append('called'), now=NOW)
    assert result == 'ignored'
    assert calls == []
    assert billing.status(app_db, USER_ONE, now=NOW)['plan'] == 'free'
 
def test_production_webhook_rejects_malformed_lifecycle_identity_before_ignoring(app_db, monkeypatch):
    _configure(monkeypatch)
    payload = _webhook('evt-malformed-production', environment='PRODUCTION')
    del payload['event']['aliases']

    with pytest.raises(ValueError):
        billing.process_webhook(payload, fetcher=lambda *_args: None, now=NOW)
    assert app_db.execute('SELECT count(*) FROM revenuecat_webhook_events').fetchone()[0] == 0
