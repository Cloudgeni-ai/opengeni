import { z } from "zod";

/** Claude Code 2.1.285's installed OAuth flow; model calls and profile reads only. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = ["user:inference", "user:profile"] as const;

export const ClaudeOAuthTokenResponse = z
  .object({
    access_token: z
      .string()
      .max(16384)
      .regex(/^sk-ant-oat[0-9]+-\S+$/),
    refresh_token: z.string().min(1).max(16384).optional(),
    expires_in: z.number().int().positive().max(31536000),
    scope: z.string().min(1).max(8192),
  })
  .passthrough();

export function claudeAuthorizationUrl(input: { challenge: string; state: string }) {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URL);
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** The Claude profile endpoint (`user:profile` scope). */
export const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/**
 * The plan id a Claude profile reports. `claude_max` covers both Max tiers
 * (Max 5x was renamed Max, Max 20x Ultra, in Oct 2026); the organization's
 * `rate_limit_tier` ("default_claude_max_20x") tells them apart as
 * `claude_max_20x` or `claude_max_5x`. Without a known tier the id stays
 * `claude_max`, shown as "Max or Ultra".
 */
export function claudeSubscriptionPlanId(input: {
  organizationType?: string | null | undefined;
  rateLimitTier?: unknown;
  hasClaudeMax?: boolean | null | undefined;
  hasClaudePro?: boolean | null | undefined;
}): string | null {
  const plan =
    input.organizationType?.trim() ||
    (input.hasClaudeMax === true
      ? "claude_max"
      : input.hasClaudePro === true
        ? "claude_pro"
        : null);
  if (plan !== "claude_max" || typeof input.rateLimitTier !== "string") return plan;
  const tier = /max_?(5|20)x$/i.exec(input.rateLimitTier.trim());
  return tier ? `claude_max_${tier[1]}x` : plan;
}

/** The plan id of a profile body; null for any shape it can't read (never throws). */
export function claudeSubscriptionProfilePlan(value: unknown): string | null {
  const record = (item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : null;
  try {
    const account = record(record(value)?.account);
    const organization = record(record(value)?.organization);
    const type = organization?.organization_type;
    return claudeSubscriptionPlanId({
      organizationType: typeof type === "string" && type.length <= 128 ? type : null,
      rateLimitTier: organization?.rate_limit_tier,
      hasClaudeMax: account?.has_claude_max === true,
      hasClaudePro: account?.has_claude_pro === true,
    });
  } catch {
    return null;
  }
}
