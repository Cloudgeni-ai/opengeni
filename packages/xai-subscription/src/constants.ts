// Verified against xAI's public OIDC discovery document and Grok Build 1.0.1.

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
] as const;
export const XAI_DEVICE_AUTHORIZATION_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_USERINFO_URL = `${XAI_OAUTH_ISSUER}/oauth2/userinfo`;
export const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// Subscription inference goes through the Grok CLI session proxy. The existing
// xai/* API-key provider continues to use api.x.ai and remains a distinct rail.
export const XAI_SUBSCRIPTION_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_PUBLIC_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_TOKEN_AUTH_HEADER_VALUE = "xai-grok-cli";
export const XAI_CLIENT_VERSION = "1.0.1";
export const XAI_CLIENT_MODE = "opengeni";

export const XAI_SUBSCRIPTION_PROVIDER_ID = "supergrok-subscription";
export const XAI_SUBSCRIPTION_MODEL_ID_PREFIX = "supergrok/";
export const XAI_SUBSCRIPTION_FALLBACK_MODEL_SLUGS = ["grok-4.5"] as const;

// Grok Build's explicit fallback when live /models-v2 metadata is unavailable.
export const XAI_SUBSCRIPTION_MODEL_CONTEXT_WINDOW_TOKENS = 256_000;
export const XAI_SUBSCRIPTION_EFFECTIVE_CONTEXT_PERCENT = 95;
export const XAI_SUBSCRIPTION_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS = Math.floor(
  (XAI_SUBSCRIPTION_MODEL_CONTEXT_WINDOW_TOKENS * XAI_SUBSCRIPTION_EFFECTIVE_CONTEXT_PERCENT) / 100,
);
export const XAI_SUBSCRIPTION_AUTO_COMPACTION_PERCENT = 85;
export const XAI_SUBSCRIPTION_MODEL_AUTO_COMPACT_TOKEN_LIMIT = Math.floor(
  (XAI_SUBSCRIPTION_MODEL_CONTEXT_WINDOW_TOKENS * XAI_SUBSCRIPTION_AUTO_COMPACTION_PERCENT) / 100,
);

export const XAI_IMAGE_MODEL = "grok-imagine-image-quality";
export const XAI_VIDEO_MODEL = "grok-imagine-video-1.5";

export const XAI_OAUTH_OPERATION_TIMEOUT_MS = 15_000;
export const XAI_REFRESH_WINDOW_MS = 2 * 60_000;
export const XAI_REFRESH_FALLBACK_MS = 60 * 60_000;
export const XAI_RESPONSE_SDK_OUTER_TIMEOUT_MS = 35 * 60_000;
export const XAI_IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const XAI_VIDEO_START_TIMEOUT_MS = 60_000;
export const XAI_VIDEO_POLL_REQUEST_TIMEOUT_MS = 30_000;
export const XAI_VIDEO_POLL_INTERVAL_MS = 5_000;
export const XAI_VIDEO_GENERATION_TIMEOUT_MS = 5 * 60_000;
export const XAI_VIDEO_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
