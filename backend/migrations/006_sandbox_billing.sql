CREATE TABLE revenuecat_billing_snapshots (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment = 'sandbox'),
  plan text NOT NULL CHECK (plan IN ('free', 'pro', 'ultra_pro', 'max')),
  expires_at timestamptz,
  verified_at timestamptz NOT NULL,
  CHECK ((plan = 'free' AND expires_at IS NULL)
         OR (plan <> 'free' AND expires_at IS NOT NULL))
);
CREATE INDEX revenuecat_billing_snapshots_expiry
  ON revenuecat_billing_snapshots (expires_at) WHERE plan <> 'free';

CREATE TABLE revenuecat_webhook_events (
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production', 'unknown')),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  app_id text CHECK (app_id IS NULL OR length(app_id) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'ignored')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text CHECK (last_error IS NULL OR last_error IN (
    'configuration', 'provider', 'provider_schema', 'database')),
  received_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (environment, event_id),
  CHECK ((status = 'pending' AND completed_at IS NULL)
         OR (status <> 'pending' AND completed_at IS NOT NULL))
);
CREATE INDEX revenuecat_webhook_events_pending
  ON revenuecat_webhook_events (received_at, environment, event_id)
  WHERE status = 'pending';

CREATE TABLE revenuecat_webhook_event_users (
  environment text NOT NULL,
  event_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (environment, event_id, user_id),
  FOREIGN KEY (environment, event_id)
    REFERENCES revenuecat_webhook_events(environment, event_id) ON DELETE CASCADE
);
CREATE INDEX revenuecat_webhook_event_users_user
  ON revenuecat_webhook_event_users (user_id, environment);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  revenuecat_billing_snapshots,
  revenuecat_webhook_events,
  revenuecat_webhook_event_users
TO app_runtime;
