import { z } from "zod";

import { ConnectionMetadata } from "./index";

export const PERSONAL_GITHUB_PROVIDER_DOMAIN = "github.com" as const;
export const PERSONAL_GITHUB_PROVIDER_FAMILY = "github" as const;
export const PERSONAL_GITHUB_CREDENTIAL_ROLE = "opengeni_github_personal" as const;
export const PERSONAL_GITHUB_REQUESTED_SCOPES = ["repo"] as const;
export const PERSONAL_GITHUB_AUTHORIZATION_URL =
  "https://github.com/login/oauth/authorize" as const;
export const PERSONAL_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token" as const;
export const PERSONAL_GITHUB_USER_URL = "https://api.github.com/user" as const;

/**
 * Owner-visible, credential-free metadata for one dedicated personal GitHub
 * OAuth connection. Repository selections are a separate authority and never
 * live in this credential record.
 */
export const PersonalGitHubConnectionMetadata = z
  .object({
    credentialRole: z.literal(PERSONAL_GITHUB_CREDENTIAL_ROLE),
    providerFamily: z.literal(PERSONAL_GITHUB_PROVIDER_FAMILY),
    providerPrincipalId: z.string().regex(/^\d+$/u),
    githubUserId: z.string().regex(/^\d+$/u),
    githubLogin: z.string().min(1).max(100),
    oauthEnvironment: z.string().min(1).max(128),
    oauthClientMarker: z.string().regex(/^[a-f0-9]{32}$/u),
    credentialBindingId: z.string().uuid(),
    connectedAt: z.string().datetime({ offset: true }),
    lastVerifiedAt: z.string().datetime({ offset: true }),
    disconnectedAt: z.string().datetime({ offset: true }).nullable().optional(),
    refreshTokenExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .passthrough();
export type PersonalGitHubConnectionMetadata = z.infer<typeof PersonalGitHubConnectionMetadata>;

export const PersonalGitHubOAuthStartRequest = z
  .object({
    /** Existing exact connection generation to re-authorize in place. */
    connectionId: z.string().uuid().optional(),
    /** Same-workspace UI path restored after the callback. */
    returnPath: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type PersonalGitHubOAuthStartRequest = z.infer<typeof PersonalGitHubOAuthStartRequest>;

export const PersonalGitHubOAuthStartResponse = z
  .object({
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PersonalGitHubOAuthStartResponse = z.infer<typeof PersonalGitHubOAuthStartResponse>;

export const PersonalGitHubConnectionStatusResponse = z
  .object({
    enabled: z.boolean(),
    connection: ConnectionMetadata.nullable(),
    reviewUrl: z.string().url().nullable(),
  })
  .strict();
export type PersonalGitHubConnectionStatusResponse = z.infer<
  typeof PersonalGitHubConnectionStatusResponse
>;

export const PersonalGitHubDisconnectRequest = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type PersonalGitHubDisconnectRequest = z.infer<typeof PersonalGitHubDisconnectRequest>;

export function isPersonalGitHubConnection(
  connection: Pick<z.infer<typeof ConnectionMetadata>, "providerDomain" | "kind" | "metadata">,
): boolean {
  return (
    connection.providerDomain.toLowerCase() === PERSONAL_GITHUB_PROVIDER_DOMAIN &&
    connection.kind === "oauth2" &&
    PersonalGitHubConnectionMetadata.safeParse(connection.metadata).success
  );
}

export function hasReservedPersonalGitHubMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.credentialRole === PERSONAL_GITHUB_CREDENTIAL_ROLE;
}
