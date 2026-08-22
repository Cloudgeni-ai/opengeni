import { z } from "zod";

import { ConnectionMetadata } from "./index";

export const PERSONAL_GITHUB_PROVIDER_DOMAIN = "github.com" as const;
export const PERSONAL_GITHUB_PROVIDER_FAMILY = "github" as const;
export const PERSONAL_GITHUB_CREDENTIAL_ROLE = "opengeni_github_personal" as const;
export const PERSONAL_GITHUB_CONNECTION_SURFACE_ID = "github:personal" as const;
export const PERSONAL_GITHUB_REQUESTED_SCOPES = ["repo"] as const;
export const PERSONAL_GITHUB_AUTHORIZATION_URL =
  "https://github.com/login/oauth/authorize" as const;
export const PERSONAL_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token" as const;
export const PERSONAL_GITHUB_USER_URL = "https://api.github.com/user" as const;
export const PERSONAL_GITHUB_API_ORIGIN = "https://api.github.com" as const;
export const PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX = 100 as const;

export const PersonalGitHubRepositoryId = z.string().regex(/^[1-9]\d*$/u);
export type PersonalGitHubRepositoryId = z.infer<typeof PersonalGitHubRepositoryId>;

export const PersonalGitHubRepositoryAccess = z.enum(["read", "write"]);
export type PersonalGitHubRepositoryAccess = z.infer<typeof PersonalGitHubRepositoryAccess>;

export const PersonalGitHubRepositoryPermissions = z
  .object({
    pull: z.boolean(),
    push: z.boolean(),
    admin: z.boolean(),
    maintain: z.boolean(),
    triage: z.boolean(),
  })
  .strict();
export type PersonalGitHubRepositoryPermissions = z.infer<
  typeof PersonalGitHubRepositoryPermissions
>;

export const PersonalGitHubRepositoryVisibility = z.enum(["public", "private", "internal"]);
export type PersonalGitHubRepositoryVisibility = z.infer<typeof PersonalGitHubRepositoryVisibility>;

const PersonalGitHubRepositoryFullName = z
  .string()
  .min(3)
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u);

export function canonicalPersonalGitHubRepositoryUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/** A bounded, credential-free projection verified directly against GitHub. */
export const PersonalGitHubRepository = z
  .object({
    repositoryId: PersonalGitHubRepositoryId,
    fullName: PersonalGitHubRepositoryFullName,
    canonicalUrl: z.string().url().max(512),
    defaultBranch: z.string().min(1).max(255),
    visibility: PersonalGitHubRepositoryVisibility,
    private: z.boolean(),
    archived: z.boolean(),
    disabled: z.boolean(),
    permissions: PersonalGitHubRepositoryPermissions,
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.canonicalUrl !== canonicalPersonalGitHubRepositoryUrl(repository.fullName)) {
      context.addIssue({
        code: "custom",
        path: ["canonicalUrl"],
        message: "canonicalUrl must be derived from fullName",
      });
    }
    if (repository.private !== (repository.visibility === "private")) {
      context.addIssue({
        code: "custom",
        path: ["private"],
        message: "private must agree with visibility",
      });
    }
  });
export type PersonalGitHubRepository = z.infer<typeof PersonalGitHubRepository>;

export const PersonalGitHubSelectedRepository = PersonalGitHubRepository.safeExtend({
  selectedAccess: PersonalGitHubRepositoryAccess,
  selectionGeneration: z.number().int().positive(),
  selectedAt: z.string().datetime({ offset: true }),
  lastVerifiedAt: z.string().datetime({ offset: true }),
}).strict();
export type PersonalGitHubSelectedRepository = z.infer<typeof PersonalGitHubSelectedRepository>;

export const PersonalGitHubRepositorySelectionState = z
  .object({
    connectionAuthorityGeneration: z.number().int().positive(),
    credentialBindingId: z.string().uuid(),
    providerPrincipalId: PersonalGitHubRepositoryId,
    selectionGeneration: z.number().int().nonnegative(),
    repositories: z
      .array(PersonalGitHubSelectedRepository)
      .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
  })
  .strict();
export type PersonalGitHubRepositorySelectionState = z.infer<
  typeof PersonalGitHubRepositorySelectionState
>;

export const ListPersonalGitHubRepositoriesQuery = z
  .object({
    cursor: z.coerce.number().int().positive().max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX).default(50),
  })
  .strict();
export type ListPersonalGitHubRepositoriesQuery = z.infer<
  typeof ListPersonalGitHubRepositoriesQuery
>;

export const PersonalGitHubRepositoryCatalogItem = PersonalGitHubRepository.safeExtend({
  selectedAccess: PersonalGitHubRepositoryAccess.nullable(),
}).strict();
export type PersonalGitHubRepositoryCatalogItem = z.infer<
  typeof PersonalGitHubRepositoryCatalogItem
>;

export const ListPersonalGitHubRepositoriesResponse = z
  .object({
    repositories: z
      .array(PersonalGitHubRepositoryCatalogItem)
      .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
    nextCursor: z.number().int().positive().nullable(),
    selection: PersonalGitHubRepositorySelectionState,
  })
  .strict();
export type ListPersonalGitHubRepositoriesResponse = z.infer<
  typeof ListPersonalGitHubRepositoriesResponse
>;

export const PersonalGitHubRepositorySelectionInput = z
  .object({
    repositoryId: PersonalGitHubRepositoryId,
    fullName: PersonalGitHubRepositoryFullName,
    access: PersonalGitHubRepositoryAccess,
  })
  .strict();
export type PersonalGitHubRepositorySelectionInput = z.infer<
  typeof PersonalGitHubRepositorySelectionInput
>;

export const ReplacePersonalGitHubRepositorySelectionsRequest = z
  .object({
    expectedConnectionAuthorityGeneration: z.number().int().positive(),
    expectedSelectionGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(200),
    repositories: z
      .array(PersonalGitHubRepositorySelectionInput)
      .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
  })
  .strict()
  .superRefine((request, context) => {
    const repositoryIds = new Set<string>();
    const fullNames = new Set<string>();
    request.repositories.forEach((repository, index) => {
      const normalizedFullName = repository.fullName.toLowerCase();
      if (repositoryIds.has(repository.repositoryId)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "repositoryId"],
          message: "repositoryId must be unique",
        });
      }
      if (fullNames.has(normalizedFullName)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "fullName"],
          message: "fullName must be unique",
        });
      }
      repositoryIds.add(repository.repositoryId);
      fullNames.add(normalizedFullName);
    });
  });
export type ReplacePersonalGitHubRepositorySelectionsRequest = z.infer<
  typeof ReplacePersonalGitHubRepositorySelectionsRequest
>;

export const VerifyPersonalGitHubRepositorySelectionsRequest = z
  .object({
    expectedConnectionAuthorityGeneration: z.number().int().positive(),
    expectedSelectionGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type VerifyPersonalGitHubRepositorySelectionsRequest = z.infer<
  typeof VerifyPersonalGitHubRepositorySelectionsRequest
>;

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
