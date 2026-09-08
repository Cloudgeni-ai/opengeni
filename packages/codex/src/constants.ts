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

// The only Codex subscription models OpenGeni exposes. Astra is deliberately
// pre-advertised before an account receives provider rollout access so the
// picker becomes runnable without another OpenGeni release once access arrives.
// Older or internal live models never broaden this product allowlist.
export const CODEX_FALLBACK_MODEL_SLUGS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
] as const;

// Live Codex model-catalog values for every exposed subscription slug.
// Verified 2026-09-04 against Codex CLI 0.153.2's bundled model catalog:
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
// 2026-07-09: 0.142.4 filtered every GPT-5.6 slug out of GET /models. Keep this
// pinned to the latest stable Codex release whose bundled catalog and transport
// contract have been reviewed here.
export const CODEX_CLIENT_VERSION = "0.153.2";

// Public OpenGeni selector for native ChatGPT/Codex subscription WebRTC. This
// remains stable for persisted sessions; the provider's remotely configured
// model is resolved separately before call creation.
export const CODEX_REALTIME_MODEL = "gpt-live-1-boulder-alpha";
export const CODEX_REALTIME_VERSION = "v3";
export const CODEX_REALTIME_DEFAULT_VOICE = "cove";
export const CODEX_REALTIME_CALL_TIMEOUT_MS = 15_000;
export const CODEX_REALTIME_CONFIG_TIMEOUT_MS = 5_000;
export const CODEX_REALTIME_CONFIG_ID = "3566525122";
// Verified live on 2026-08-23. Used only when the authenticated remote config
// is transiently unavailable or malformed; it is not the persisted model id.
export const CODEX_REALTIME_PROVIDER_MODEL_FALLBACK = "gpt-live-1-codex";
export const CODEX_REALTIME_PROVIDER_ARCHITECTURE_FALLBACK = "avas";

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
// Kept as a compatibility-shaped policy field, but automatic replay is disabled
// until a provider-specific operation receipt can prove non-acceptance or resume
// the same operation identity. An absent response does not prove that the
// provider never accepted the request.
export const CODEX_RESPONSE_NO_BYTE_RETRIES = 0;
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
