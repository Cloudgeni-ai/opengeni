-- deployment-mode: rolling
-- First-party social connectors (X / Reddit): OAuth token storage.
-- credential_encrypted holds the AES-256-GCM envelope (environment-crypto v1
-- format) with the provider token bundle {access_token, refresh_token, ...}.
-- It is deliberately separate from credential_ref (a free-text external
-- reference) and never surfaced by the SocialConnection contract mapper.

ALTER TABLE "social_connections" ADD COLUMN IF NOT EXISTS "credential_encrypted" text;
