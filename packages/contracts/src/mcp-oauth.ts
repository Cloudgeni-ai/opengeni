import { z } from "zod";

export const MCP_OAUTH_SCOPE = "mcp:access" as const;
export const MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const MCP_OAUTH_CONSENT_TTL_SECONDS = 10 * 60;

const RedirectUri = z.string().url().max(2_048);

export const McpOAuthClientRegistrationRequest = z
  .object({
    redirect_uris: z.array(RedirectUri).min(1).max(16),
    client_name: z.string().trim().min(1).max(200).optional(),
    application_type: z.enum(["native", "web"]).optional(),
    token_endpoint_auth_method: z.literal("none").default("none"),
    scope: z.literal(MCP_OAUTH_SCOPE).optional(),
    grant_types: z
      .array(z.enum(["authorization_code", "refresh_token"]))
      .min(1)
      .max(2)
      .refine((grantTypes) => grantTypes.includes("authorization_code"), {
        message: "authorization_code grant is required",
      })
      .default(["authorization_code", "refresh_token"]),
    response_types: z.array(z.literal("code")).min(1).max(1).default(["code"]),
  })
  .strict();
export type McpOAuthClientRegistrationRequest = z.infer<typeof McpOAuthClientRegistrationRequest>;

export const McpOAuthClientRegistrationResponse = McpOAuthClientRegistrationRequest.extend({
  client_id: z.string().min(1).max(256),
  client_id_issued_at: z.number().int().nonnegative(),
});
export type McpOAuthClientRegistrationResponse = z.infer<typeof McpOAuthClientRegistrationResponse>;

export const McpOAuthTokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.literal(MCP_OAUTH_SCOPE),
});
export type McpOAuthTokenResponse = z.infer<typeof McpOAuthTokenResponse>;

export const McpOAuthProtectedResourceMetadata = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1).max(1),
  scopes_supported: z.array(z.literal(MCP_OAUTH_SCOPE)).length(1),
  bearer_methods_supported: z.array(z.literal("header")).length(1),
});
export type McpOAuthProtectedResourceMetadata = z.infer<typeof McpOAuthProtectedResourceMetadata>;

export const McpOAuthAuthorizationServerMetadata = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  response_types_supported: z.array(z.literal("code")).length(1),
  grant_types_supported: z.array(z.enum(["authorization_code", "refresh_token"])).length(2),
  code_challenge_methods_supported: z.array(z.literal("S256")).length(1),
  token_endpoint_auth_methods_supported: z.array(z.literal("none")).length(1),
  scopes_supported: z.array(z.literal(MCP_OAUTH_SCOPE)).length(1),
  authorization_response_iss_parameter_supported: z.literal(true),
});
export type McpOAuthAuthorizationServerMetadata = z.infer<
  typeof McpOAuthAuthorizationServerMetadata
>;
