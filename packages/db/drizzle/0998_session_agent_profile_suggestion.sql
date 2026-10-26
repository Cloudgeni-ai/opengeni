-- deployment-mode: rolling
-- The newest agent-profile suggestion an agent made in a chat
-- (`agent_profile_suggest`): { id, kind, profileId, name, role, avatar,
-- instructions, reason, createdAt }. The chat shows it as a card until the
-- person accepts or dismisses it. A suggestion is display state only: it never
-- creates or applies a profile. NULL means no suggestion. Older binaries ignore
-- the column. Metadata-only nullable column addition; no scan, no index.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "sessions"
  ADD COLUMN "agent_profile_suggestion" jsonb;
