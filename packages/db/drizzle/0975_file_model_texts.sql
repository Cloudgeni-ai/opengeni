-- deployment-mode: rolling
-- The text a model is shown for a document attachment (PDF with a text layer,
-- office documents, CSV and other text files), extracted once from the file's
-- verified bytes the first time a message carrying it is rendered for a model.
-- The first stored result is final, success or failure, so every later
-- request renders the same bytes and the provider's prompt cache holds. A row
-- grants no file access: it is read only for files the file-authority lookup
-- already returned, like the file's bytes in object storage. It goes with its
-- file. The table is new, so the previous release never reads it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE file_model_texts (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- What produced the row, for example anydoc@0.1.8 or utf8.
  extractor text NOT NULL CHECK (char_length(extractor) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN (
    'extracted', 'unsupported', 'encrypted', 'malformed', 'too_large', 'failed', 'timeout',
    'unavailable'
  )),
  format text NOT NULL CHECK (format IN ('markdown', 'text')),
  -- The start of the extracted text; total_chars is the length of all of it.
  text text NOT NULL DEFAULT '' CHECK (char_length(text) <= 200000),
  total_chars integer NOT NULL CHECK (total_chars >= char_length(text)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, file_id),
  CHECK (status = 'extracted' OR (text = '' AND total_chars = 0))
);

ALTER TABLE file_model_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_model_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON file_model_texts
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON TABLE file_model_texts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON file_model_texts TO opengeni_app;
  END IF;
END $$;
