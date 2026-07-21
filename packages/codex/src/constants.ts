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

// The only Codex subscription models OpenGeni exposes. The live GET /models
// catalog must contain every exact slug; older or internal models never broaden
// this product allowlist.
export const CODEX_FALLBACK_MODEL_SLUGS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

// Live Codex model-catalog values for every exposed gpt-5.6 subscription slug.
// Verified 2026-07-18 against Codex CLI 0.144.6's freshly fetched
// ~/.codex/models_cache.json and the matching openai/codex core derivations:
//   raw context window                = 272,000
//   effective input window (95%)      = 258,400
//   automatic compaction limit (90%)  = 244,800
// Keep all three explicit: the effective ceiling is a hard input guard while
// the lower auto-compact limit is the proactive checkpoint trigger.
export const CODEX_MODEL_CONTEXT_WINDOW_TOKENS = 272_000;
export const CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
export const CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS = Math.floor(
  (CODEX_MODEL_CONTEXT_WINDOW_TOKENS * CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100,
);
export const CODEX_AUTO_COMPACTION_PERCENT = 90;
export const CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT = Math.floor(
  (CODEX_MODEL_CONTEXT_WINDOW_TOKENS * CODEX_AUTO_COMPACTION_PERCENT) / 100,
);

// Sent as the `version` header and inside the User-Agent. Staging-proven on
// 2026-07-09: 0.142.4 filtered every GPT-5.6 slug out of GET /models, while the
// official Codex 0.144.0+ releases return all three exact slugs above. Keep
// this pinned to the latest stable Codex release we have verified end-to-end.
export const CODEX_CLIENT_VERSION = "0.144.6";

export const CODEX_REFRESH_WINDOW_MS = 5 * 60 * 1000; // proactive refresh when within 5 min of exp (spec §1.1)
export const CODEX_REFRESH_FALLBACK_MS = 8 * 24 * 60 * 60 * 1000; // 8 days when exp is unparseable

// Codex Responses transport deadlines. The OpenAI SDK's own timeout only covers
// the wait for response headers and erases the underlying timeout class into the
// bare `Request timed out.` error. Keep the provider-specific budgets here so
// the transport can enforce and durably report them without enabling the SDK's
// blind request replay.
export const CODEX_RESPONSE_HEADERS_TIMEOUT_MS = 4 * 60_000;
export const CODEX_RESPONSE_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
export const CODEX_RESPONSE_WHOLE_TIMEOUT_MS = 30 * 60_000;
export const CODEX_RESPONSE_NO_BYTE_RETRIES = 1;
export const CODEX_RESPONSE_RETRY_BACKOFF_MS = 1_000;
// Must exceed the transport-owned whole-response deadline. This SDK guard is a
// last-resort envelope; the inner transport emits the typed/durable failure.
export const CODEX_RESPONSE_SDK_OUTER_TIMEOUT_MS = 35 * 60_000;

// ── Apps / connectors MCP (spec §1.10, §E) ───────────────────────────────────
// One server-side MCP exposes ALL the user's ChatGPT/Codex connectors
// (gmail/github/linear/slack/sentry/drive/calendar/…). Streamable HTTP, always.
export const CODEX_APPS_MCP_SERVER_ID = "codex_apps"; // tools surface as mcp__codex_apps__<tool>
export const CODEX_APPS_MCP_SERVER_NAME = "codex_apps"; // MCP `name` — MUST equal the id so the SDK namespaces tools as mcp__codex_apps__*
export const CODEX_APPS_MCP_URL = "https://chatgpt.com/backend-api/ps/mcp"; // live URL (NOT /codex, NOT the legacy /wham/apps)
export const CODEX_APPS_STARTUP_TIMEOUT_MS = 30_000; // startup_timeout 30s (spec §1.10) — maps to timeoutMs on this server only
// Connector scopes that the apps MCP requires. Present ONLY when granted at
// browser-authorize time; the device-code path CANNOT be confirmed to grant
// them, so treat connector availability as runtime-discovered (spec §1.10 / §E).
export const CODEX_APPS_REQUIRED_SCOPES = ["api.connectors.read", "api.connectors.invoke"] as const;
