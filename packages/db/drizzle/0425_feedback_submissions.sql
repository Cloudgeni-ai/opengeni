-- deployment-mode: maintenance
-- Stop old API/control/turn workers before migration and start the feedback-aware
-- runtime afterward: this adds to the exact table/privilege posture contract.
-- Feedback is separate from agent context and session activity. Only the author
-- can read it through the runtime; operator analysis uses its separate DB access.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
CREATE TABLE feedback_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (length(btrim(subject_id)) > 0),
  principal_kind text,
  idempotency_key uuid NOT NULL,
  session_id uuid,
  turn_id uuid,
  sentiment text CHECK (sentiment IN ('positive', 'negative')),
  comment text,
  comment_codec_version integer CHECK (comment_codec_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (turn_id IS NULL OR session_id IS NOT NULL),
  CHECK (sentiment IS NULL OR session_id IS NOT NULL),
  CHECK (sentiment IS NOT NULL OR (comment IS NOT NULL AND length(btrim(comment)) > 0)),
  CHECK ((comment IS NULL) = (comment_codec_version IS NULL)),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX feedback_submissions_request_idx ON feedback_submissions(workspace_id, subject_id, idempotency_key);
CREATE INDEX feedback_submissions_author_idx ON feedback_submissions(workspace_id, subject_id, created_at DESC, id DESC);
CREATE INDEX feedback_submissions_session_idx ON feedback_submissions(workspace_id, session_id, created_at DESC, id DESC);
ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_author ON feedback_submissions
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
    AND (session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id = feedback_submissions.workspace_id AND s.id = feedback_submissions.session_id))
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
    AND (session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id = feedback_submissions.workspace_id AND s.id = feedback_submissions.session_id))
    AND (turn_id IS NULL OR EXISTS (SELECT 1 FROM session_turns t WHERE t.workspace_id = feedback_submissions.workspace_id AND t.session_id = feedback_submissions.session_id AND t.id = feedback_submissions.turn_id))
  );
CREATE POLICY session_visibility_isolation ON feedback_submissions AS RESTRICTIVE
  FOR ALL
  USING (session_id IS NULL OR session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_id IS NULL OR session_reference_visible(account_id, workspace_id, session_id));
REVOKE ALL ON feedback_submissions FROM PUBLIC;
RESET statement_timeout;
RESET lock_timeout;
