import { z } from "zod";

export const SITE_SCHEMA_VERSION = 1 as const;

const Uuid = z.string().uuid();
const IsoTimestamp = z.string().datetime();
const Sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const BoundedId = z.string().trim().min(1).max(128);

/**
 * Secret-free, immutable authority requested by one published Site release.
 * The API intersects every requested capability with the current human grant;
 * this manifest is never an authority source by itself.
 */
export const SiteCapabilityManifest = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    ai: z
      .object({
        enabled: z.boolean(),
        defaultModel: z.string().trim().min(1).max(256).nullable(),
        allowedModels: z.array(z.string().trim().min(1).max(256)).max(32),
        reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
        instructions: z.string().trim().min(1).max(32_768),
        monthlyBudgetMicros: z.number().int().positive().safe().nullable(),
      })
      .strict(),
    integrations: z
      .object({
        firstPartyPermissions: z.array(BoundedId).max(128),
        firstPartyTools: z.array(BoundedId).max(256),
        mcpServers: z
          .array(
            z
              .object({
                kind: z.literal("mcp"),
                id: BoundedId,
                eager: z.boolean().optional(),
                optional: z.boolean().optional(),
              })
              .strict(),
          )
          .max(32),
        allowedPersonalConnectionServerIds: z.array(BoundedId).max(32),
      })
      .strict(),
    approvals: z
      .object({
        writeActions: z.enum(["platform_prompt", "deny"]),
      })
      .strict(),
    access: z
      .object({
        audience: z.literal("workspace"),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.ai.enabled) return;
    if (value.ai.allowedModels.length > 0 && value.ai.defaultModel === null) {
      context.addIssue({
        code: "custom",
        path: ["ai", "defaultModel"],
        message: "AI-enabled Sites with an allowlist require a default model",
      });
    }
    if (
      value.ai.defaultModel !== null &&
      value.ai.allowedModels.length > 0 &&
      !value.ai.allowedModels.includes(value.ai.defaultModel)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ai", "defaultModel"],
        message: "default model must be included in allowed models",
      });
    }
  });
export type SiteCapabilityManifest = z.infer<typeof SiteCapabilityManifest>;

export const Site = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    runtimeKind: z.literal("static_spa"),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    artifactId: Uuid,
    slug: z.string().min(1).max(128),
    title: z.string().min(1).max(512),
    description: z.string().max(2_048).nullable(),
    status: z.enum(["active", "archived"]),
    currentReleaseId: Uuid.nullable(),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict();
export type Site = z.infer<typeof Site>;

export const SiteRelease = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    siteId: Uuid,
    artifactVersionId: Uuid,
    revision: z.number().int().positive().safe(),
    manifestHash: Sha256Digest,
    manifest: SiteCapabilityManifest,
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
  })
  .strict();
export type SiteRelease = z.infer<typeof SiteRelease>;

export const SiteEvent = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    siteId: Uuid,
    releaseId: Uuid.nullable(),
    type: z.enum(["published", "rolled_back", "archived", "runtime_session_started"]),
    actorSubjectId: z.string().min(1).max(1_024),
    facts: z.record(z.string(), z.unknown()),
    createdAt: IsoTimestamp,
  })
  .strict();
export type SiteEvent = z.infer<typeof SiteEvent>;

export const SiteRuntimeSession = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    siteId: Uuid,
    releaseId: Uuid,
    sessionId: Uuid,
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
  })
  .strict();
export type SiteRuntimeSession = z.infer<typeof SiteRuntimeSession>;

export const PublishSiteRequest = z
  .object({
    operationId: Uuid,
    expectedCurrentReleaseId: Uuid.nullable(),
    artifactVersionId: Uuid,
    manifest: SiteCapabilityManifest,
    reason: z.string().trim().min(1).max(2_048),
  })
  .strict();
export type PublishSiteRequest = z.infer<typeof PublishSiteRequest>;

export const RollbackSiteRequest = z
  .object({
    operationId: Uuid,
    expectedCurrentReleaseId: Uuid,
    releaseId: Uuid,
    reason: z.string().trim().min(1).max(2_048),
  })
  .strict();
export type RollbackSiteRequest = z.infer<typeof RollbackSiteRequest>;

export const ArchiveSiteRequest = z
  .object({
    operationId: Uuid,
    expectedCurrentReleaseId: Uuid,
    reason: z.string().trim().min(1).max(2_048),
  })
  .strict();
export type ArchiveSiteRequest = z.infer<typeof ArchiveSiteRequest>;

export const SiteConnectionAuthoritySelection = z
  .object({
    serverId: BoundedId,
    connectionId: Uuid,
    userDelegation: z
      .object({
        authorityId: Uuid,
        grantId: Uuid,
        organizationId: Uuid,
        workspaceId: Uuid,
        sessionId: Uuid.nullable(),
        action: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/u),
        mode: z.enum(["once", "session", "always"]),
        context: z.enum(["user_private", "workspace_shared"]),
        authorityEpoch: z.number().int().positive().nullable(),
        authorityGeneration: z.number().int().positive(),
        grantGeneration: z.number().int().positive(),
        resourceVersionId: Uuid.nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const CreateSiteRuntimeSessionRequest = z
  .object({
    operationId: Uuid,
    initialMessage: z.string().trim().min(1).max(1_000_000),
    model: z.string().trim().min(1).max(256).nullable().optional(),
    modelContext: z.string().max(64_000).nullable().optional(),
    connectionAuthorities: z.array(SiteConnectionAuthoritySelection).max(32).optional(),
  })
  .strict();
export type CreateSiteRuntimeSessionRequest = z.infer<typeof CreateSiteRuntimeSessionRequest>;

export const SendSiteRuntimeMessageRequest = z
  .object({
    text: z.string().trim().min(1).max(1_000_000),
    clientEventId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type SendSiteRuntimeMessageRequest = z.infer<typeof SendSiteRuntimeMessageRequest>;

export const SiteDetailResponse = z
  .object({
    site: Site,
    currentRelease: SiteRelease.nullable(),
    releases: z.array(SiteRelease),
    events: z.array(SiteEvent),
  })
  .strict();
export type SiteDetailResponse = z.infer<typeof SiteDetailResponse>;

export const SiteListResponse = z.object({ sites: z.array(Site) }).strict();
export type SiteListResponse = z.infer<typeof SiteListResponse>;

export const SiteMutationResponse = z.object({ site: Site, release: SiteRelease }).strict();
export type SiteMutationResponse = z.infer<typeof SiteMutationResponse>;

export const SiteRuntimeSessionReceipt = z
  .object({
    runtimeSession: SiteRuntimeSession,
    sessionId: Uuid,
    eventsPath: z.string().min(1),
  })
  .strict();
export type SiteRuntimeSessionReceipt = z.infer<typeof SiteRuntimeSessionReceipt>;

export const SiteUsageResponse = z
  .object({
    periodStart: IsoTimestamp,
    periodEnd: IsoTimestamp,
    modelCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    budgetMicros: z.number().int().positive().safe().nullable(),
  })
  .strict();
export type SiteUsageResponse = z.infer<typeof SiteUsageResponse>;
