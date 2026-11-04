ALTER TABLE users
  ADD COLUMN display_name text,
  ADD COLUMN admin_revision bigint NOT NULL DEFAULT 0 CHECK (admin_revision >= 0),
  ADD CONSTRAINT users_display_name_check CHECK (
    display_name IS NULL OR (
      char_length(display_name) BETWEEN 1 AND 80
      AND display_name = btrim(display_name)
      AND display_name !~ '[[:cntrl:]]'
    )
  );

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'expert')),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX user_roles_role_user ON user_roles (role, user_id);

CREATE TABLE admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'operator')),
  actor_id uuid REFERENCES users,
  actor_label text,
  operation text NOT NULL CHECK (operation IN (
    'admin.users.roles.set', 'admin.users.status.set', 'admin.bootstrap'
  )),
  target_user_id uuid NOT NULL REFERENCES users,
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CHECK (
    (actor_kind = 'user' AND actor_id IS NOT NULL AND actor_label IS NULL)
    OR (actor_kind = 'operator' AND actor_id IS NULL
        AND actor_label IS NOT NULL AND char_length(actor_label) BETWEEN 1 AND 128)
  )
);
CREATE INDEX admin_audit_created ON admin_audit (created_at DESC, id DESC);
CREATE INDEX admin_audit_target_created ON admin_audit (target_user_id, created_at DESC, id DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO app_runtime;
REVOKE ALL ON admin_audit FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit FROM app_runtime;
GRANT SELECT, INSERT ON admin_audit TO app_runtime;
