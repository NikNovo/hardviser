ALTER TABLE files
  ADD COLUMN kind text NOT NULL DEFAULT 'document',
  ADD COLUMN content_level text NOT NULL DEFAULT 'full'
    CHECK (content_level IN ('full', 'summary', 'stored'));

ALTER TABLE files
  DROP CONSTRAINT files_mime_check,
  DROP CONSTRAINT files_size_bytes_check,
  ADD CONSTRAINT files_mime_length_check CHECK (char_length(mime) <= 100),
  ADD CONSTRAINT files_size_bytes_check CHECK (size_bytes BETWEEN 0 AND 104857600);

ALTER TABLE upload_sessions
  DROP CONSTRAINT upload_sessions_mime_check,
  DROP CONSTRAINT upload_sessions_size_bytes_check,
  ADD CONSTRAINT upload_sessions_mime_length_check CHECK (char_length(mime) <= 100),
  ADD CONSTRAINT upload_sessions_size_bytes_check CHECK (size_bytes BETWEEN 0 AND 104857600);
