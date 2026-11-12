import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
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

/**
 * A GitHub user or organization login, as a repository owner. Enterprise
 * managed users' logins carry an underscore suffix (`handle_shortcode`).
 */
export const GITHUB_OWNER_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/u;

/**
 * The in-chat setup card for the person's own GitHub identity ("Your GitHub").
 * Distinct from the workspace GitHub App card (`api:github-app`): this one
 * connects the signed-in person's account, which only they can do.
 */
export const PERSONAL_GITHUB_CAPABILITY_ID = "api:github-personal" as const;

/**
 * Query value that opens the GitHub integration page on the "Your GitHub"
 * section: its Connect action, or the repository chooser once connected.
 */
export const PERSONAL_GITHUB_SETUP_QUERY_VALUE = "personal" as const;

/**
 * Console path that lands on the personal GitHub connect action. A link
 * target only: it grants nothing, and the person still confirms on GitHub.
 */
export function personalGitHubSetupPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins?open=${encodeURIComponent(
    "integration:github",
  )}&github=${PERSONAL_GITHUB_SETUP_QUERY_VALUE}`;
}

export const PersonalGitHubRepositoryId = /* @__PURE__ */ defineSchema(() =>
  primitives.string.regex(/^[1-9]\d*$/u),
);
export type PersonalGitHubRepositoryId = z.infer<typeof PersonalGitHubRepositoryId>;

export const PersonalGitHubRepositoryAccess = /* @__PURE__ */ defineSchema(() =>
  z.enum(["read", "write"]),
);
export type PersonalGitHubRepositoryAccess = z.infer<typeof PersonalGitHubRepositoryAccess>;

/** Whether `granted` access includes `requested` (write includes read). */
export function personalGitHubAccessCovers(
  granted: PersonalGitHubRepositoryAccess | null | undefined,
  requested: PersonalGitHubRepositoryAccess,
): boolean {
  return granted === "write" || (granted === "read" && requested === "read");
}

export const PersonalGitHubRepositoryPermissions = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      pull: primitives.boolean,
      push: primitives.boolean,
      admin: primitives.boolean,
      maintain: primitives.boolean,
      triage: primitives.boolean,
    })
    .strict(),
);
export type PersonalGitHubRepositoryPermissions = z.infer<
  typeof PersonalGitHubRepositoryPermissions
>;

export const PersonalGitHubRepositoryVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["public", "private", "internal"]),
);
export type PersonalGitHubRepositoryVisibility = z.infer<typeof PersonalGitHubRepositoryVisibility>;

/**
 * The access "All my repositories" gives one repository: the chosen default,
 * lowered to what GitHub allows the person there. Null when GitHub allows no
 * use at all (no read permission, or a disabled repository); an archived
 * repository stays readable.
 */
export function personalGitHubAllRepositoriesEffectiveAccess(
  allRepositoriesAccess: PersonalGitHubRepositoryAccess,
  repository: {
    permissions: PersonalGitHubRepositoryPermissions;
    archived: boolean;
    disabled: boolean;
  },
): PersonalGitHubRepositoryAccess | null {
  const permissions = repository.permissions;
  if (repository.disabled) return null;
  const canRead =
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin;
  if (!canRead) return null;
  const canWrite =
    !repository.archived && (permissions.push || permissions.maintain || permissions.admin);
  return allRepositoriesAccess === "write" && canWrite ? "write" : "read";
}

const PersonalGitHubRepositoryFullName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(3)
    .max(140)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u),
);

export function canonicalPersonalGitHubRepositoryUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/** A bounded, credential-free projection verified directly against GitHub. */
export const PersonalGitHubRepository = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      repositoryId: PersonalGitHubRepositoryId,
      fullName: PersonalGitHubRepositoryFullName,
      canonicalUrl: z.string().url().max(512),
      defaultBranch: z.string().min(1).max(255),
      visibility: PersonalGitHubRepositoryVisibility,
      private: primitives.boolean,
      archived: primitives.boolean,
      disabled: primitives.boolean,
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
    }),
);
export type PersonalGitHubRepository = z.infer<typeof PersonalGitHubRepository>;

export const PersonalGitHubSelectedRepository = /* @__PURE__ */ defineSchema(() =>
  PersonalGitHubRepository.safeExtend({
    selectedAccess: PersonalGitHubRepositoryAccess,
    selectionGeneration: primitives.positiveInteger,
    selectedAt: primitives.string.datetime({ offset: true }),
    lastVerifiedAt: primitives.string.datetime({ offset: true }),
  }).strict(),
);
export type PersonalGitHubSelectedRepository = z.infer<typeof PersonalGitHubSelectedRepository>;

export const PersonalGitHubRepositorySelectionState = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connectionAuthorityGeneration: primitives.positiveInteger,
      credentialBindingId: primitives.uuid,
      providerPrincipalId: PersonalGitHubRepositoryId,
      selectionGeneration: primitives.nonnegativeInteger,
      /**
       * "All my repositories": every repository the person can access on
       * GitHub, up to this access, checked live with GitHub on every use.
       * Null (or absent from older servers) means only `repositories`.
       * The per-repository list is kept while this is on, so turning it off
       * restores the earlier choice.
       */
      allRepositoriesAccess: PersonalGitHubRepositoryAccess.nullable().optional(),
      repositories: z
        .array(PersonalGitHubSelectedRepository)
        .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
    })
    .strict(),
);
export type PersonalGitHubRepositorySelectionState = z.infer<
  typeof PersonalGitHubRepositorySelectionState
>;

export const ListPersonalGitHubRepositoriesQuery = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      cursor: z.coerce.number().int().positive().max(10_000).default(1),
      limit: z.coerce.number().int().min(1).max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX).default(50),
      /**
       * Find repositories by name across everything the person can access,
       * not only the listed page. Matches `owner/name` substrings; an exact
       * `owner/name` is also looked up directly. Results are not paged.
       */
      query: z.string().trim().min(1).max(140).optional(),
    })
    .strict(),
);
export type ListPersonalGitHubRepositoriesQuery = z.infer<
  typeof ListPersonalGitHubRepositoriesQuery
>;

export const PersonalGitHubRepositoryCatalogItem = /* @__PURE__ */ defineSchema(() =>
  PersonalGitHubRepository.safeExtend({
    /** The person's saved choice for this repository; null when not chosen. */
    selectedAccess: PersonalGitHubRepositoryAccess.nullable(),
    /**
     * The access work gets now: the saved choice, or in All my repositories
     * that mode's access lowered to GitHub's permission. Null when unusable.
     * Absent from older servers, where `selectedAccess` is the answer.
     */
    effectiveAccess: PersonalGitHubRepositoryAccess.nullable().optional(),
  }).strict(),
);
export type PersonalGitHubRepositoryCatalogItem = z.infer<
  typeof PersonalGitHubRepositoryCatalogItem
>;

export const ListPersonalGitHubRepositoriesResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      repositories: z
        .array(PersonalGitHubRepositoryCatalogItem)
        .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
      nextCursor: z.number().int().positive().nullable(),
      selection: PersonalGitHubRepositorySelectionState,
    })
    .strict(),
);
export type ListPersonalGitHubRepositoriesResponse = z.infer<
  typeof ListPersonalGitHubRepositoriesResponse
>;

export const PersonalGitHubRepositorySelectionInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      repositoryId: PersonalGitHubRepositoryId,
      fullName: PersonalGitHubRepositoryFullName,
      access: PersonalGitHubRepositoryAccess,
    })
    .strict(),
);
export type PersonalGitHubRepositorySelectionInput = z.infer<
  typeof PersonalGitHubRepositorySelectionInput
>;

export const ReplacePersonalGitHubRepositorySelectionsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedConnectionAuthorityGeneration: primitives.positiveInteger,
      expectedSelectionGeneration: primitives.nonnegativeInteger,
      idempotencyKey: primitives.string.trim().min(1).max(200),
      repositories: z
        .array(PersonalGitHubRepositorySelectionInput)
        .max(PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX),
      /**
       * Turn "All my repositories" on with this access, or off with null.
       * Omitted keeps the current mode. `repositories` is saved either way,
       * so the per-repository choice returns when the mode is turned off.
       */
      allRepositoriesAccess: PersonalGitHubRepositoryAccess.nullable().optional(),
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
    }),
);
export type ReplacePersonalGitHubRepositorySelectionsRequest = z.infer<
  typeof ReplacePersonalGitHubRepositorySelectionsRequest
>;

export const VerifyPersonalGitHubRepositorySelectionsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedConnectionAuthorityGeneration: primitives.positiveInteger,
      expectedSelectionGeneration: primitives.nonnegativeInteger,
      idempotencyKey: primitives.string.trim().min(1).max(200),
    })
    .strict(),
);
export type VerifyPersonalGitHubRepositorySelectionsRequest = z.infer<
  typeof VerifyPersonalGitHubRepositorySelectionsRequest
>;

/**
 * Owner-visible, credential-free metadata for one dedicated personal GitHub
 * OAuth connection. Repository selections are a separate authority and never
 * live in this credential record.
 */
export const PersonalGitHubConnectionMetadata = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      credentialRole: z.literal(PERSONAL_GITHUB_CREDENTIAL_ROLE),
      providerFamily: z.literal(PERSONAL_GITHUB_PROVIDER_FAMILY),
      providerPrincipalId: primitives.string.regex(/^\d+$/u),
      githubUserId: primitives.string.regex(/^\d+$/u),
      githubLogin: z.string().min(1).max(100),
      oauthEnvironment: z.string().min(1).max(128),
      oauthClientMarker: primitives.string.regex(/^[a-f0-9]{32}$/u),
      credentialBindingId: primitives.uuid,
      connectedAt: primitives.string.datetime({ offset: true }),
      lastVerifiedAt: primitives.string.datetime({ offset: true }),
      disconnectedAt: primitives.string.datetime({ offset: true }).nullable().optional(),
      refreshTokenExpiresAt: primitives.string.datetime({ offset: true }).nullable().optional(),
    })
    .passthrough(),
);
export type PersonalGitHubConnectionMetadata = z.infer<typeof PersonalGitHubConnectionMetadata>;

export const PersonalGitHubOAuthStartRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Existing exact connection generation to re-authorize in place. */
      connectionId: primitives.optionalUuid,
      /** Same-workspace UI path restored after the callback. */
      returnPath: z.string().min(1).max(2048).optional(),
    })
    .strict(),
);
export type PersonalGitHubOAuthStartRequest = z.infer<typeof PersonalGitHubOAuthStartRequest>;

export const PersonalGitHubOAuthStartResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      authorizationUrl: z.string().url(),
      expiresAt: primitives.string.datetime({ offset: true }),
    })
    .strict(),
);
export type PersonalGitHubOAuthStartResponse = z.infer<typeof PersonalGitHubOAuthStartResponse>;

export const PersonalGitHubConnectionStatusResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      enabled: primitives.boolean,
      /** People may choose "All my repositories" on this deployment. */
      allRepositoriesAvailable: primitives.boolean.optional(),
      connection: ConnectionMetadata.nullable(),
      reviewUrl: z.string().url().nullable(),
    })
    .strict(),
);
export type PersonalGitHubConnectionStatusResponse = z.infer<
  typeof PersonalGitHubConnectionStatusResponse
>;

export const PersonalGitHubDisconnectRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedVersion: primitives.positiveInteger,
      idempotencyKey: primitives.string.trim().min(1).max(200),
    })
    .strict(),
);
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

/** What agents and Git see when GitHub stopped accepting the person's stored grant. */
export const PERSONAL_GITHUB_RECONNECT_MESSAGE =
  "GitHub no longer accepts this person's connection. They need to reconnect it in Opengeni (GitHub settings, Your GitHub, Reconnect).";

/**
 * A personal GitHub connection whose grant GitHub refused (a failed token
 * refresh): it stays the person's, but only reconnecting makes it work again.
 * Nothing sets `error` on personal GitHub today; it is included so a future
 * failure state also asks for a reconnect instead of failing silently.
 */
export function personalGitHubConnectionNeedsReconnect(
  connection: Pick<
    z.infer<typeof ConnectionMetadata>,
    "providerDomain" | "kind" | "metadata" | "status"
  >,
): boolean {
  return (
    (connection.status === "needs_reauth" || connection.status === "error") &&
    isPersonalGitHubConnection(connection)
  );
}

export function hasReservedPersonalGitHubMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.credentialRole === PERSONAL_GITHUB_CREDENTIAL_ROLE;
}
