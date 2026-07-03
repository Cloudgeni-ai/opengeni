-- Server-visible "display present but capture not granted" state.
--
-- A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not
-- granted). The agent's connect Hello now reports has_display=false AND a human,
-- actionable reason for that case; persist the reason alongside has_display so the
-- Machines dashboard / VM picker can surface "display: capture not granted" instead
-- of a bare display_unavailable — the state must be VISIBLE server-side, not just in
-- a local agent log. NULL means capture is permitted OR the machine is genuinely
-- headless, so every existing row keeps its historical semantics with no backfill.
ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "desktop_unavailable_reason" text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
