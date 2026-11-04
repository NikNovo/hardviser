ALTER TABLE projects
  ADD COLUMN brief_fields jsonb NOT NULL DEFAULT
    '{"description":"","audience":"","markets":"","team":"","goal":"","notes":""}'::jsonb;

UPDATE projects
SET brief_fields = jsonb_build_object(
  'description', '',
  'audience', '',
  'markets', '',
  'team', '',
  'goal', '',
  'notes', brief->>'text'
);

ALTER TABLE projects
  ADD CONSTRAINT projects_brief_fields_check CHECK (
    jsonb_typeof(brief_fields) = 'object'
    AND brief_fields ?& ARRAY['description','audience','markets','team','goal','notes']
    AND brief_fields - ARRAY['description','audience','markets','team','goal','notes'] = '{}'::jsonb
    AND jsonb_typeof(brief_fields->'description') = 'string'
    AND jsonb_typeof(brief_fields->'audience') = 'string'
    AND jsonb_typeof(brief_fields->'markets') = 'string'
    AND jsonb_typeof(brief_fields->'team') = 'string'
    AND jsonb_typeof(brief_fields->'goal') = 'string'
    AND jsonb_typeof(brief_fields->'notes') = 'string'
    AND octet_length(brief_fields->>'description') <= 8192
    AND octet_length(brief_fields->>'audience') <= 8192
    AND octet_length(brief_fields->>'markets') <= 8192
    AND octet_length(brief_fields->>'team') <= 8192
    AND octet_length(brief_fields->>'goal') <= 8192
    AND octet_length(brief_fields->>'notes') <= 8192
  );

CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000 AND octet_length(text) <= 8000),
  completed boolean NOT NULL DEFAULT false,
  source_message_id uuid REFERENCES messages ON DELETE SET NULL,
  source_chat_id uuid REFERENCES chats ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todos_project_created ON todos (project_id, created_at, id);
CREATE INDEX todos_source_message ON todos (source_message_id) WHERE source_message_id IS NOT NULL;

CREATE TABLE file_imports (
  target_project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  source_file_id uuid NOT NULL,
  target_file_id uuid NOT NULL UNIQUE REFERENCES files ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_project_id, source_file_id)
);
COMMENT ON COLUMN file_imports.source_file_id IS
  'Historical source identity; intentionally not a foreign key so imported copies survive source deletion.';
