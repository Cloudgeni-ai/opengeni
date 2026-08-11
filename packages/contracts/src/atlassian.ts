import { z } from "zod";
import { ConnectionMetadata } from "./index";
import { ConnectorDocumentDestination } from "./connector-destinations";

export const ATLASSIAN_PROVIDER_DOMAIN = "api.atlassian.com" as const;
export const ATLASSIAN_CREDENTIAL_ROLE = "atlassian_knowledge" as const;
export const ATLASSIAN_CREDENTIAL_LABEL = "Atlassian read-only knowledge sync" as const;

export const ATLASSIAN_REQUIRED_SCOPES = [
  "offline_access",
  "read:me",
  "read:jira-work",
  "read:jira-user",
  "read:confluence-content.all",
  "read:confluence-space.summary",
  "search:confluence",
  "read:space:confluence",
  "read:page:confluence",
  "read:comment:confluence",
] as const;

export const AtlassianSourceKind = z.enum(["jira_project", "confluence_space"]);
export type AtlassianSourceKind = z.infer<typeof AtlassianSourceKind>;

export const AtlassianSyncCadence = z.enum(["manual", "hourly", "daily"]);
export type AtlassianSyncCadence = z.infer<typeof AtlassianSyncCadence>;

export const AtlassianReadPolicy = z.enum(["allow", "ask", "block"]);
export type AtlassianReadPolicy = z.infer<typeof AtlassianReadPolicy>;

export const AtlassianConnectionLifecycle = z.object({
  state: z.enum([
    "active",
    "paused",
    "token_revoked",
    "app_removed",
    "disconnected",
    "reconnect_required",
    "reconsent_required",
  ]),
  recoverable: z.boolean(),
  observedAt: z.string().datetime(),
});
export type AtlassianConnectionLifecycle = z.infer<typeof AtlassianConnectionLifecycle>;

export const AtlassianSelectedSource = z.object({
  id: z.string().min(1).max(300),
  cloudId: z.string().min(1).max(256),
  siteName: z.string().min(1).max(512),
  siteUrl: z.string().url(),
  resourceId: z.string().min(1).max(256),
  key: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  kind: AtlassianSourceKind,
  destination: ConnectorDocumentDestination.optional(),
  syncCadence: AtlassianSyncCadence,
  syncEnabled: z.boolean(),
  configGeneration: z.number().int().positive(),
  readPolicy: AtlassianReadPolicy,
  selectedAt: z.string().datetime(),
});
export type AtlassianSelectedSource = z.infer<typeof AtlassianSelectedSource>;

export const AtlassianConnectionMetadata = z.object({
  credentialRole: z.literal(ATLASSIAN_CREDENTIAL_ROLE),
  credentialLabel: z.literal(ATLASSIAN_CREDENTIAL_LABEL),
  atlassianAccountId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(512),
  email: z.string().email().nullable().optional(),
  sites: z
    .array(
      z.object({
        cloudId: z.string().min(1).max(256),
        name: z.string().min(1).max(512),
        url: z.string().url(),
        products: z.array(z.enum(["jira", "confluence"])).max(2),
      }),
    )
    .min(1)
    .max(50),
  verifiedAt: z.string().datetime(),
  accessMode: z.literal("readonly"),
  lifecycle: AtlassianConnectionLifecycle.optional(),
  documentDestination: ConnectorDocumentDestination.optional(),
  selectedSources: z.array(AtlassianSelectedSource).max(100).default([]),
});
export type AtlassianConnectionMetadata = z.infer<typeof AtlassianConnectionMetadata>;

export const AtlassianOAuthStartRequest = z.object({
  connectionId: z.string().uuid().optional(),
});
export type AtlassianOAuthStartRequest = z.infer<typeof AtlassianOAuthStartRequest>;

export const AtlassianOAuthStartResponse = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type AtlassianOAuthStartResponse = z.infer<typeof AtlassianOAuthStartResponse>;

export const AtlassianBrowseItem = z.object({
  id: z.string().min(1).max(300),
  cloudId: z.string().min(1).max(256),
  siteName: z.string().min(1).max(512),
  siteUrl: z.string().url(),
  resourceId: z.string().min(1).max(256),
  key: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  kind: AtlassianSourceKind,
  description: z.string().max(2_000).nullable(),
  webUrl: z.string().url(),
});
export type AtlassianBrowseItem = z.infer<typeof AtlassianBrowseItem>;

export const AtlassianBrowseResponse = z.object({
  connection: z.lazy(() => ConnectionMetadata),
  items: z.array(AtlassianBrowseItem).max(200),
});
export type AtlassianBrowseResponse = z.infer<typeof AtlassianBrowseResponse>;

export const SaveAtlassianSourcesRequest = z.object({
  sources: z
    .array(
      AtlassianBrowseItem.pick({
        id: true,
        cloudId: true,
        siteName: true,
        siteUrl: true,
        resourceId: true,
        key: true,
        name: true,
        kind: true,
      }),
    )
    .max(100),
  destination: z.object({
    authorityKind: z.enum(["organization", "workspace", "personal"]),
    collectionId: z.string().uuid().nullable().default(null),
  }),
  syncCadence: AtlassianSyncCadence,
  syncEnabled: z.boolean(),
  readPolicy: AtlassianReadPolicy.default("allow"),
});
export type SaveAtlassianSourcesRequest = z.infer<typeof SaveAtlassianSourcesRequest>;

export const AtlassianLifecycleActionRequest = z.object({
  action: z.enum(["pause", "resume"]),
  expectedVersion: z.number().int().positive(),
});
export type AtlassianLifecycleActionRequest = z.infer<typeof AtlassianLifecycleActionRequest>;

export const AtlassianDisconnectRequest = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});
export type AtlassianDisconnectRequest = z.infer<typeof AtlassianDisconnectRequest>;

export function atlassianScopesAllowRead(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return ATLASSIAN_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}
