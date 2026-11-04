ALTER TABLE users
  ADD COLUMN email text;

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized_check CHECK (
    email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 254)
  );

CREATE UNIQUE INDEX users_verified_email_unique
  ON users (email) WHERE email IS NOT NULL;

CREATE TABLE email_auth_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  client_bucket char(64) NOT NULL CHECK (client_bucket ~ '^[a-f0-9]{64}$'),
  return_to text NOT NULL CHECK (length(return_to) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (invalidated_at IS NULL OR consumed_at IS NULL)
);
CREATE INDEX email_auth_links_email_created ON email_auth_links (email, created_at DESC);
CREATE INDEX email_auth_links_client_created ON email_auth_links (client_bucket, created_at DESC);
CREATE INDEX email_auth_links_created ON email_auth_links (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_auth_links TO app_runtime;
