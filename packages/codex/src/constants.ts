// Wire constants for the ChatGPT/Codex subscription backend.
// Source: CODEX-SUBSCRIPTION-SPEC.md (verified against openai/codex codex-rs).

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // spec §1.1 (manager.rs:1444)
export const CODEX_AUTH_BASE = `${CODEX_ISSUER}/api/accounts`; // device endpoints (device_code_auth.rs:164)
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`; // exchange (form) + refresh (json)
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;

// Model requests: base already includes /codex; client appends /responses, /models.
export const CODEX_RESPONSES_BASE = "https://chatgpt.com/backend-api/codex";
// Usage lives on the WHAM base — NOT under /codex (verified, spec §1.8a).
export const CODEX_WHAM_BASE = "https://chatgpt.com/backend-api";

export const CODEX_ORIGINATOR = "codex_cli_rs"; // whitelisted originator (spec §1.2)
export const CODEX_ID_TOKEN_AUTH_CLAIM = "https://api.openai.com/auth";

// Synthetic registry-provider identity. The provider's baseURL is the bare
// /backend-api (NOT /codex) — codexSubscriptionFetch rewrites /responses ->
// /codex/responses. Codex model ids are namespaced `codex/<slug>` so they never
// collide with the built-in OpenAI provider's model ids; the fetch's resolveModel
// strips the prefix before the slug reaches the backend.
export const CODEX_PROVIDER_ID = "codex-subscription";
export const CODEX_PROVIDER_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_MODEL_ID_PREFIX = "codex/";

// Offline fallback catalog. The live catalog from GET /models supersedes this
// when wired; until then these are the selectable codex models and the
// longest-prefix resolution targets. Confirmed live (2026-06) against a pro plan:
// GET /codex/models returned exactly these (plus the internal codex-auto-review).
export const CODEX_FALLBACK_MODEL_SLUGS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const;

// Sent as the `version` header and inside the User-Agent. Confirmed live: the
// backend accepts the current codex CLI version; an older value risks /models
// min_client_version filtering. Keep in step with the codex CLI releases.
export const CODEX_CLIENT_VERSION = "0.142.4";

export const CODEX_REFRESH_WINDOW_MS = 5 * 60 * 1000; // proactive refresh when within 5 min of exp (spec §1.1)
export const CODEX_REFRESH_FALLBACK_MS = 8 * 24 * 60 * 60 * 1000; // 8 days when exp is unparseable
