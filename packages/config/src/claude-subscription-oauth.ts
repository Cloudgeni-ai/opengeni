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
