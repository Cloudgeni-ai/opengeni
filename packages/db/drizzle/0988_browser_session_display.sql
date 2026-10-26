-- deployment-mode: rolling
-- How a headed managed browser was actually shown on its machine, as its
-- controller reports at launch: in a native window, or offscreen with none
-- (a managed browser on a person's Mac, or on a Linux host without a
-- display). The requested mode stays in headless; this records what the
-- launch did, so a browser is never reported as having a window it lacks.
-- A nullable column without default or check is a catalog-only change; the
-- previous release never writes it and existing rows stay null (unknown).
ALTER TABLE browser_sessions
  ADD COLUMN IF NOT EXISTS display text;
COMMENT ON COLUMN browser_sessions.display IS
  'How the controller last launched this headed browser: window or offscreen. NULL when unknown, headless, remote or attached.';
