-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: event_sources and event_triggers hold a few rows per workspace, so checking the new, empty columns is instant.
-- Event sources and triggers say why they are not active as a code clients
-- word in their own language, and what the app or server said, next to the
-- English sentence in status_reason. Clients read the code only while the
-- row is not active. Older binaries write neither column, so the checks do
-- not tie them to status_reason: an older binary that clears or rewrites the
-- sentence during a rolling deploy must not fail, and the next newer write
-- sets all three again.
ALTER TABLE event_sources
  ADD COLUMN status_reason_code text,
  ADD COLUMN status_reason_detail text,
  ADD CONSTRAINT event_sources_status_reason_code_chk CHECK (
    (status_reason_code IS NULL OR status_reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (status_reason_detail IS NULL OR (status_reason_code IS NOT NULL
      AND char_length(status_reason_detail) BETWEEN 1 AND 500))
  );

ALTER TABLE event_triggers
  ADD COLUMN status_reason_code text,
  ADD COLUMN status_reason_detail text,
  ADD CONSTRAINT event_triggers_status_reason_code_chk CHECK (
    (status_reason_code IS NULL OR status_reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (status_reason_detail IS NULL OR (status_reason_code IS NOT NULL
      AND char_length(status_reason_detail) BETWEEN 1 AND 500))
  );
