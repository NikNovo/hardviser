CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL UNIQUE CHECK (login = lower(login)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_expiry ON sessions (user_id, expires_at);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  brief jsonb NOT NULL DEFAULT '{"text":""}'::jsonb
    CHECK (jsonb_typeof(brief) = 'object'
           AND brief ? 'text'
           AND jsonb_typeof(brief->'text') = 'string'
           AND octet_length(brief->>'text') <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_updated ON projects (owner_id, updated_at DESC);

CREATE TABLE chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat' CHECK (length(title) BETWEEN 1 AND 200),
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'technical')),
  pinned uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chats_project_updated ON chats (project_id, updated_at DESC);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200
                             AND position('/' IN name) = 0
                             AND position(E'\\' IN name) = 0),
  mime text NOT NULL CHECK (mime IN ('text/plain', 'text/markdown', 'text/csv',
                                    'application/json', 'application/pdf')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 20971520),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX files_project_live ON files (project_id) WHERE deleted_at IS NULL;
CREATE INDEX files_sha256 ON files (sha256);

CREATE TABLE file_chunks (
  file_id uuid NOT NULL REFERENCES files ON DELETE CASCADE,
  idx int NOT NULL CHECK (idx >= 0),
  page int CHECK (page IS NULL OR page >= 1),
  text text NOT NULL,
  embedding vector(384),
  fts_ru tsvector GENERATED ALWAYS AS (to_tsvector('russian', text)) STORED,
  fts_en tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (file_id, idx)
);
CREATE INDEX file_chunks_embedding ON file_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX file_chunks_fts_ru ON file_chunks USING gin (fts_ru);
CREATE INDEX file_chunks_fts_en ON file_chunks USING gin (fts_en);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  mentions uuid[] NOT NULL DEFAULT '{}',
  route text CHECK (route IS NULL OR route IN ('general', 'technical')),
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'error')),
  payload jsonb,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_chat_created ON messages (chat_id, created_at, id);

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200
                             AND position('/' IN name) = 0
                             AND position(E'\\' IN name) = 0),
  mime text NOT NULL CHECK (mime IN ('text/plain', 'text/markdown', 'text/csv',
                                    'application/json', 'application/pdf')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 20971520),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
  next_index int NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX upload_sessions_user_expiry ON upload_sessions (user_id, expires_at);
CREATE INDEX upload_sessions_project_expiry ON upload_sessions (project_id, expires_at);

CREATE TABLE blob_gc (
  sha256 char(64) PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  queued_at timestamptz NOT NULL DEFAULT now()
);
