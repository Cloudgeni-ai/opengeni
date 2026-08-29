import { z } from "zod";

export const INTERNAL_APPLICATIONS_SCHEMA_VERSION = 1 as const;

const Uuid = z.string().uuid();
const IsoTimestamp = z.string().datetime();
const ShortText = z.string().trim().min(1).max(256);
const LongText = z.string().trim().min(1).max(16_384);
const Slug = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const Sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const KubernetesName = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/u);
const KubernetesSecretPrefix = KubernetesName.refine(
  (value) => value.length <= 180,
  "secret prefix must leave room for a data-binding name",
);
const Ipv4Cidr = z
  .string()
  .trim()
  .max(18)
  .refine((value) => {
    const [address, prefix, extra] = value.split("/");
    if (extra !== undefined || !address || !prefix || !/^\d{1,2}$/u.test(prefix)) return false;
    const prefixNumber = Number(prefix);
    return (
      prefixNumber >= 0 &&
      prefixNumber <= 32 &&
      address.split(".").length === 4 &&
      address.split(".").every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    );
  }, "must be an IPv4 CIDR");
const SecretFreeMetadata = z
  .record(z.string().min(1).max(128), z.union([z.string().max(2_048), z.number(), z.boolean()]))
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (/(?:secret|token|password|credential|private[_-]?key|api[_-]?key)/iu.test(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "metadata keys must not describe secret material",
        });
      }
    }
  });

function safeHttpUrl(maxLength = 2_048) {
  return z
    .string()
    .url()
    .max(maxLength)
    .refine((value) => {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username.length === 0 &&
        parsed.password.length === 0
      );
    }, "URL must use http(s) and must not contain credentials");
}

function safeHttpsUrl(maxLength = 2_048) {
  return safeHttpUrl(maxLength).refine(
    (value) => new URL(value).protocol === "https:",
    "URL must use https",
  );
}

export const InternalApplicationStatus = z.enum(["draft", "active", "archived"]);
export type InternalApplicationStatus = z.infer<typeof InternalApplicationStatus>;

export const InternalApplicationSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prompt"),
      prompt: LongText,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      repositoryUri: z.string().trim().min(1).max(2_048),
      ref: z.string().trim().min(1).max(512).nullable(),
      subpath: z.string().trim().min(1).max(1_024).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bundle"),
      bundleId: Uuid,
    })
    .strict(),
]);
export type InternalApplicationSource = z.infer<typeof InternalApplicationSource>;

export const InternalApplicationDataSourceKind = z.enum([
  "postgres",
  "s3",
  "documents",
  "vector",
  "http_api",
  "custom",
]);
export type InternalApplicationDataSourceKind = z.infer<typeof InternalApplicationDataSourceKind>;

export const InternalApplicationDataAccessMode = z.enum(["attach", "clone", "provision"]);
export type InternalApplicationDataAccessMode = z.infer<typeof InternalApplicationDataAccessMode>;

export const InternalApplicationDataClassification = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type InternalApplicationDataClassification = z.infer<
  typeof InternalApplicationDataClassification
>;

export const InternalApplicationDataSourceLocator = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("postgres"),
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65_535).default(5432),
      database: z.string().trim().min(1).max(128),
      schemas: z.array(z.string().trim().min(1).max(128)).min(1).max(64),
      sslMode: z.enum(["disable", "prefer", "require", "verify-full"]),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("s3"),
      endpoint: safeHttpUrl(),
      region: z.string().trim().min(1).max(128).nullable(),
      bucket: z.string().trim().min(1).max(255),
      prefix: z.string().max(1_024),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("documents"),
      scope: z.enum(["workspace", "organization"]),
      sourceKind: z.string().trim().min(1).max(128).nullable(),
      aclTags: z.array(z.string().trim().min(1).max(128)).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vector"),
      endpoint: safeHttpUrl(),
      collection: z.string().trim().min(1).max(256),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http_api"),
      baseUrl: safeHttpUrl(),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      provider: z.string().trim().min(1).max(128),
      locator: z.string().trim().min(1).max(2_048),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
]);
export type InternalApplicationDataSourceLocator = z.infer<
  typeof InternalApplicationDataSourceLocator
>;

export const InternalApplicationDataGovernance = z
  .object({
    classification: InternalApplicationDataClassification,
    residencySite: z.string().trim().min(1).max(256),
    residencyRegion: z.string().trim().min(1).max(128).nullable(),
    externalEgressAllowed: z.boolean(),
    retentionDays: z.number().int().positive().max(36_500).nullable(),
    owner: z.string().trim().min(1).max(256),
    purpose: z.string().trim().min(1).max(1_024),
  })
  .strict();
export type InternalApplicationDataGovernance = z.infer<typeof InternalApplicationDataGovernance>;

export const InternalApplicationDataSource = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    name: ShortText,
    description: z.string().trim().max(2_048),
    kind: InternalApplicationDataSourceKind,
    allowedAccessModes: z.array(InternalApplicationDataAccessMode).min(1).max(3),
    locator: InternalApplicationDataSourceLocator,
    schemaDefinition: z.record(z.string(), z.unknown()),
    governance: InternalApplicationDataGovernance,
    metadata: SecretFreeMetadata,
    status: z.enum(["active", "disabled"]),
    revision: z.number().int().positive().safe(),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.locator.kind) {
      context.addIssue({
        code: "custom",
        path: ["locator", "kind"],
        message: "data-source kind must match locator kind",
      });
    }
  });
export type InternalApplicationDataSource = z.infer<typeof InternalApplicationDataSource>;

export const UpsertInternalApplicationDataSourceRequest = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    name: ShortText,
    description: z.string().trim().max(2_048).default(""),
    kind: InternalApplicationDataSourceKind,
    allowedAccessModes: z.array(InternalApplicationDataAccessMode).min(1).max(3),
    locator: InternalApplicationDataSourceLocator,
    schemaDefinition: z.record(z.string(), z.unknown()).default({}),
    governance: InternalApplicationDataGovernance,
    metadata: SecretFreeMetadata.default({}),
    status: z.enum(["active", "disabled"]).default("active"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.locator.kind) {
      context.addIssue({
        code: "custom",
        path: ["locator", "kind"],
        message: "data-source kind must match locator kind",
      });
    }
  });
export type UpsertInternalApplicationDataSourceRequest = z.infer<
  typeof UpsertInternalApplicationDataSourceRequest
>;

export const InternalApplicationDeploymentTargetKind = z.enum([
  "kubernetes",
  "connected_machine",
  "managed",
]);
export type InternalApplicationDeploymentTargetKind = z.infer<
  typeof InternalApplicationDeploymentTargetKind
>;

export const InternalApplicationDeploymentTargetConfig = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("kubernetes"),
      apiServer: safeHttpsUrl(),
      namespace: z.string().trim().min(1).max(63),
      serviceAccount: z.string().trim().min(1).max(253),
      ingressClass: z.string().trim().min(1).max(253).nullable(),
      ingressNamespace: z.string().trim().min(1).max(63).nullable(),
      internalDomain: z.string().trim().min(1).max(253),
      registry: z.string().trim().min(1).max(512),
      storageClasses: z.array(z.string().trim().min(1).max(253)).max(32),
      runtimeApiUrl: safeHttpUrl(),
      runtimeCredentialSecretPrefix: KubernetesSecretPrefix.nullable(),
      dataCredentialSecretPrefix: KubernetesSecretPrefix.nullable(),
      dataLifecycleBroker: z
        .object({
          endpoint: safeHttpsUrl(),
          credentialConnectionId: Uuid,
          supportedModes: z
            .array(z.enum(["clone", "provision"]))
            .min(1)
            .max(2),
        })
        .strict()
        .optional(),
      allowedEgressCidrs: z.array(Ipv4Cidr).max(64),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connected_machine"),
      enrollmentId: Uuid,
      workingDirectory: z.string().trim().min(1).max(2_048),
      internalDomain: z.string().trim().min(1).max(253).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("managed"),
      provider: z.enum(["azure", "aws", "gcp", "other"]),
      region: z.string().trim().min(1).max(128),
      clusterId: z.string().trim().min(1).max(512),
      internalDomain: z.string().trim().min(1).max(253),
      registry: z.string().trim().min(1).max(512),
      credentialConnectionId: Uuid.nullable(),
    })
    .strict(),
]);
export type InternalApplicationDeploymentTargetConfig = z.infer<
  typeof InternalApplicationDeploymentTargetConfig
>;

export const InternalApplicationTargetCapabilities = z
  .object({
    architectures: z
      .array(z.enum(["amd64", "arm64"]))
      .min(1)
      .max(2),
    cpuMillicoresMax: z.number().int().positive(),
    memoryMiBMax: z.number().int().positive(),
    storageMiBMax: z.number().int().positive(),
    gpuTypes: z.array(z.string().trim().min(1).max(128)).max(32),
    supportsNetworkPolicy: z.boolean(),
    supportsPersistentVolumes: z.boolean(),
    supportsInternalIngress: z.boolean(),
    supportsLocalModelRoute: z.boolean(),
  })
  .strict();
export type InternalApplicationTargetCapabilities = z.infer<
  typeof InternalApplicationTargetCapabilities
>;

export const InternalApplicationDeploymentTarget = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    name: ShortText,
    description: z.string().trim().max(2_048),
    kind: InternalApplicationDeploymentTargetKind,
    environment: z.enum(["development", "staging", "production"]),
    site: z.string().trim().min(1).max(256),
    config: InternalApplicationDeploymentTargetConfig,
    capabilities: InternalApplicationTargetCapabilities,
    metadata: SecretFreeMetadata,
    status: z.enum(["active", "degraded", "disabled"]),
    revision: z.number().int().positive().safe(),
    lastObservedAt: IsoTimestamp.nullable(),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.config.kind) {
      context.addIssue({
        code: "custom",
        path: ["config", "kind"],
        message: "deployment-target kind must match config kind",
      });
    }
  });
export type InternalApplicationDeploymentTarget = z.infer<
  typeof InternalApplicationDeploymentTarget
>;

export const UpsertInternalApplicationDeploymentTargetRequest = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    name: ShortText,
    description: z.string().trim().max(2_048).default(""),
    kind: InternalApplicationDeploymentTargetKind,
    environment: z.enum(["development", "staging", "production"]),
    site: z.string().trim().min(1).max(256),
    config: InternalApplicationDeploymentTargetConfig,
    capabilities: InternalApplicationTargetCapabilities,
    metadata: SecretFreeMetadata.default({}),
    status: z.enum(["active", "degraded", "disabled"]).default("active"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.config.kind) {
      context.addIssue({
        code: "custom",
        path: ["config", "kind"],
        message: "deployment-target kind must match config kind",
      });
    }
  });
export type UpsertInternalApplicationDeploymentTargetRequest = z.infer<
  typeof UpsertInternalApplicationDeploymentTargetRequest
>;

export const InternalApplicationComputeProfile = z
  .object({
    architecture: z.enum(["amd64", "arm64"]),
    cpuMillicores: z.number().int().positive().max(1_000_000),
    memoryMiB: z.number().int().positive().max(10_000_000),
    storageMiB: z.number().int().positive().max(100_000_000),
    gpu: z
      .object({
        type: z.string().trim().min(1).max(128),
        count: z.number().int().positive().max(64),
      })
      .strict()
      .nullable(),
    minReplicas: z.number().int().nonnegative().max(10_000),
    maxReplicas: z.number().int().positive().max(10_000),
  })
  .strict()
  .refine((value) => value.maxReplicas >= value.minReplicas, {
    path: ["maxReplicas"],
    message: "maxReplicas must be greater than or equal to minReplicas",
  });
export type InternalApplicationComputeProfile = z.infer<typeof InternalApplicationComputeProfile>;

export const InternalApplicationAiPolicy = z
  .object({
    enabled: z.boolean(),
    route: z.enum(["local", "opengeni_managed", "workspace_provider"]),
    defaultModel: z.string().trim().min(1).max(256).nullable(),
    allowedModels: z.array(z.string().trim().min(1).max(256)).max(64),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(64),
    monthlyBudgetMicros: z.number().int().nonnegative().safe().nullable(),
    requireHumanApprovalForWrites: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.enabled && (value.defaultModel !== null || value.allowedModels.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "disabled AI policy cannot select models",
      });
    }
    if (
      value.enabled &&
      (value.defaultModel === null || !value.allowedModels.includes(value.defaultModel))
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "enabled AI policy requires an allowed default model",
      });
    }
  });
export type InternalApplicationAiPolicy = z.infer<typeof InternalApplicationAiPolicy>;

export const InternalApplicationDataBinding = z
  .object({
    dataSourceId: Uuid,
    expectedRevision: z.number().int().positive().safe(),
    accessMode: InternalApplicationDataAccessMode,
    permissions: z
      .array(z.enum(["read", "write", "admin"]))
      .min(1)
      .max(3),
    mountName: Slug,
  })
  .strict();
export type InternalApplicationDataBinding = z.infer<typeof InternalApplicationDataBinding>;

export const InternalApplicationRoute = z
  .object({
    name: Slug,
    path: z.string().min(1).max(1_024).regex(/^\//u),
    port: z.number().int().min(1).max(65_535),
    visibility: z.enum(["workspace", "organization", "private"]),
  })
  .strict();
export type InternalApplicationRoute = z.infer<typeof InternalApplicationRoute>;

export const InternalApplicationDefinition = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    source: InternalApplicationSource,
    dataBindings: z.array(InternalApplicationDataBinding).max(64),
    compute: InternalApplicationComputeProfile,
    ai: InternalApplicationAiPolicy,
    routes: z.array(InternalApplicationRoute).min(1).max(32),
    variableSetIds: z.array(Uuid).max(32),
    metadata: SecretFreeMetadata,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [path, values] of [
      ["dataBindings", value.dataBindings.map((entry) => entry.dataSourceId)],
      ["routes", value.routes.map((entry) => entry.name)],
      ["variableSetIds", value.variableSetIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must be unique`,
        });
      }
    }
  });
export type InternalApplicationDefinition = z.infer<typeof InternalApplicationDefinition>;

export const InternalApplicationSummary = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    runtimeKind: z.literal("external_deployment"),
    id: Uuid,
    accountId: Uuid,
    workspaceId: Uuid,
    slug: Slug,
    name: ShortText,
    description: z.string().max(2_048),
    status: InternalApplicationStatus,
    headRevisionId: Uuid,
    headRevision: z.number().int().positive().safe(),
    definitionHash: Sha256Digest,
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationSummary = z.infer<typeof InternalApplicationSummary>;

export const InternalApplicationRevision = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    runtimeKind: z.literal("external_deployment"),
    id: Uuid,
    applicationId: Uuid,
    revision: z.number().int().positive().safe(),
    definitionHash: Sha256Digest,
    definition: InternalApplicationDefinition,
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationRevision = z.infer<typeof InternalApplicationRevision>;

export const InternalApplicationDetail = z
  .object({
    application: InternalApplicationSummary,
    headRevision: InternalApplicationRevision,
  })
  .strict();
export type InternalApplicationDetail = z.infer<typeof InternalApplicationDetail>;

export const CreateInternalApplicationRequest = z
  .object({
    operationId: Uuid,
    slug: Slug,
    name: ShortText,
    description: z.string().trim().max(2_048).default(""),
    definition: InternalApplicationDefinition,
  })
  .strict();
export type CreateInternalApplicationRequest = z.infer<typeof CreateInternalApplicationRequest>;

export const UpdateInternalApplicationRequest = z
  .object({
    operationId: Uuid,
    expectedHeadRevision: z.number().int().positive().safe(),
    name: ShortText,
    description: z.string().trim().max(2_048),
    status: InternalApplicationStatus,
    definition: InternalApplicationDefinition,
  })
  .strict();
export type UpdateInternalApplicationRequest = z.infer<typeof UpdateInternalApplicationRequest>;

export const InternalApplicationBundleManifest = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    image: z
      .object({
        reference: z.string().trim().min(1).max(1_024),
        digest: Sha256Digest,
        architecture: z.enum(["amd64", "arm64"]),
      })
      .strict(),
    staticAssetsDigest: Sha256Digest.nullable(),
    migrationsDigest: Sha256Digest.nullable(),
    runtime: z
      .object({
        command: z.array(z.string().max(4_096)).min(1).max(64),
        workingDirectory: z.string().max(1_024),
      })
      .strict(),
    health: z
      .object({
        path: z.string().min(1).max(1_024).regex(/^\//u),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    configurationKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u)).max(256),
    sbomDigest: Sha256Digest,
    provenanceDigest: Sha256Digest,
  })
  .strict();
export type InternalApplicationBundleManifest = z.infer<typeof InternalApplicationBundleManifest>;

export const InternalApplicationBundle = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    applicationId: Uuid,
    applicationRevisionId: Uuid,
    digest: Sha256Digest,
    manifest: InternalApplicationBundleManifest,
    status: z.enum(["ready", "revoked"]),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationBundle = z.infer<typeof InternalApplicationBundle>;

export const RegisterInternalApplicationBundleRequest = z
  .object({
    operationId: Uuid,
    applicationRevisionId: Uuid,
    digest: Sha256Digest,
    manifest: InternalApplicationBundleManifest,
  })
  .strict();
export type RegisterInternalApplicationBundleRequest = z.infer<
  typeof RegisterInternalApplicationBundleRequest
>;

export const CreateInternalApplicationBuildSessionRequest = z
  .object({
    operationId: Uuid,
    expectedApplicationRevision: z.number().int().positive().safe(),
    targetId: Uuid.nullable().default(null),
    model: z.string().trim().min(1).max(256).optional(),
    reasoningEffort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    additionalInstructions: z.string().trim().min(1).max(16_384).optional(),
  })
  .strict();
export type CreateInternalApplicationBuildSessionRequest = z.infer<
  typeof CreateInternalApplicationBuildSessionRequest
>;

export const InternalApplicationBuildSessionReceipt = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    applicationId: Uuid,
    applicationRevision: z.number().int().positive().safe(),
    sessionId: Uuid,
    initialTurnId: Uuid.nullable(),
    model: z.string().trim().min(1).max(256),
    eventsPath: z.string().startsWith("/v1/workspaces/").max(2_048),
  })
  .strict();
export type InternalApplicationBuildSessionReceipt = z.infer<
  typeof InternalApplicationBuildSessionReceipt
>;

export const InternalApplicationDeploymentStatus = z.enum([
  "not_deployed",
  "plan_ready",
  "awaiting_approval",
  "deploying",
  "running",
  "degraded",
  "failed",
  "rolling_back",
  "rolled_back",
  "retired",
]);
export type InternalApplicationDeploymentStatus = z.infer<
  typeof InternalApplicationDeploymentStatus
>;

export const InternalApplicationDeployment = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    applicationId: Uuid,
    environment: z.enum(["development", "staging", "production"]),
    targetId: Uuid,
    targetRevision: z.number().int().positive().safe(),
    activeBundleId: Uuid.nullable(),
    desiredBundleId: Uuid.nullable(),
    status: InternalApplicationDeploymentStatus,
    internalUrl: safeHttpUrl().nullable(),
    revision: z.number().int().positive().safe(),
    lastObservedAt: IsoTimestamp.nullable(),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationDeployment = z.infer<typeof InternalApplicationDeployment>;

export const InternalApplicationPlanAction = z
  .object({
    id: Slug,
    kind: z.enum(["create", "update", "delete", "migrate", "verify"]),
    resourceType: z.string().trim().min(1).max(128),
    resourceName: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(2_048),
    risk: z.enum(["low", "medium", "high"]),
    irreversible: z.boolean(),
  })
  .strict();
export type InternalApplicationPlanAction = z.infer<typeof InternalApplicationPlanAction>;

export const InternalApplicationDataFlow = z
  .object({
    dataSourceId: Uuid,
    sourceSite: z.string().trim().min(1).max(256),
    destinationSite: z.string().trim().min(1).max(256),
    accessMode: InternalApplicationDataAccessMode,
    externalEgress: z.boolean(),
    credentialDelivery: z.enum(["brokered", "short_lived", "none"]),
  })
  .strict();
export type InternalApplicationDataFlow = z.infer<typeof InternalApplicationDataFlow>;

export const InternalApplicationDeploymentPlan = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    digest: Sha256Digest,
    applicationId: Uuid,
    applicationRevisionId: Uuid,
    applicationRevision: z.number().int().positive().safe(),
    bundleId: Uuid,
    bundleDigest: Sha256Digest,
    targetId: Uuid,
    targetRevision: z.number().int().positive().safe(),
    environment: z.enum(["development", "staging", "production"]),
    actions: z.array(InternalApplicationPlanAction).max(256),
    dataFlows: z.array(InternalApplicationDataFlow).max(64),
    runtimeIdentity: z.string().trim().min(1).max(512),
    secretReferences: z.array(KubernetesName).max(128),
    network: z
      .object({
        policyEnforced: z.boolean(),
        allowedEgressCidrs: z.array(Ipv4Cidr).max(64),
      })
      .strict(),
    modelRoute: z.enum(["disabled", "local", "opengeni_managed", "workspace_provider"]),
    estimatedMonthlyCostMicros: z.number().int().nonnegative().safe().nullable(),
    policyChecks: z
      .array(
        z
          .object({
            id: Slug,
            status: z.enum(["pass", "warn", "fail"]),
            message: z.string().max(2_048),
          })
          .strict(),
      )
      .max(128),
    destructive: z.boolean(),
    createdAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationDeploymentPlan = z.infer<typeof InternalApplicationDeploymentPlan>;

export const InternalApplicationDeploymentOperation = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    deploymentId: Uuid,
    kind: z.enum(["plan", "apply", "observe", "rollback", "retire"]),
    status: z.enum([
      "planned",
      "awaiting_approval",
      "approved",
      "provider_started",
      "outcome_unknown",
      "observing",
      "completed",
      "failed",
      "superseded",
    ]),
    requestHash: Sha256Digest,
    plan: InternalApplicationDeploymentPlan.nullable(),
    approvedBySubjectId: z.string().min(1).max(1_024).nullable(),
    approvedAt: IsoTimestamp.nullable(),
    result: SecretFreeMetadata.nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    errorMessage: z.string().min(1).max(2_048).nullable(),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationDeploymentOperation = z.infer<
  typeof InternalApplicationDeploymentOperation
>;

export const PlanInternalApplicationDeploymentRequest = z
  .object({
    operationId: Uuid,
    applicationId: Uuid,
    expectedApplicationRevision: z.number().int().positive().safe(),
    bundleId: Uuid,
    targetId: Uuid,
    expectedTargetRevision: z.number().int().positive().safe(),
    environment: z.enum(["development", "staging", "production"]),
  })
  .strict();
export type PlanInternalApplicationDeploymentRequest = z.infer<
  typeof PlanInternalApplicationDeploymentRequest
>;

export const ApproveInternalApplicationDeploymentRequest = z
  .object({
    expectedPlanDigest: Sha256Digest,
  })
  .strict();
export type ApproveInternalApplicationDeploymentRequest = z.infer<
  typeof ApproveInternalApplicationDeploymentRequest
>;

export const ApplyInternalApplicationDeploymentRequest = z
  .object({
    operationId: Uuid,
    planOperationId: Uuid,
    expectedPlanDigest: Sha256Digest,
  })
  .strict();
export type ApplyInternalApplicationDeploymentRequest = z.infer<
  typeof ApplyInternalApplicationDeploymentRequest
>;

export const ObserveInternalApplicationDeploymentRequest = z
  .object({
    operationId: Uuid,
  })
  .strict();
export type ObserveInternalApplicationDeploymentRequest = z.infer<
  typeof ObserveInternalApplicationDeploymentRequest
>;

export const RollbackInternalApplicationDeploymentRequest = z
  .object({
    operationId: Uuid,
    expectedDeploymentRevision: z.number().int().positive().safe(),
  })
  .strict();
export type RollbackInternalApplicationDeploymentRequest = z.infer<
  typeof RollbackInternalApplicationDeploymentRequest
>;

export const RetireInternalApplicationDeploymentRequest = z
  .object({
    operationId: Uuid,
    expectedDeploymentRevision: z.number().int().positive().safe(),
  })
  .strict();
export type RetireInternalApplicationDeploymentRequest = z.infer<
  typeof RetireInternalApplicationDeploymentRequest
>;

export const ReconcileInternalApplicationDeploymentOperationRequest = z
  .object({
    operationId: Uuid,
    expectedDeploymentRevision: z.number().int().positive().safe(),
  })
  .strict();
export type ReconcileInternalApplicationDeploymentOperationRequest = z.infer<
  typeof ReconcileInternalApplicationDeploymentOperationRequest
>;

export const InternalApplicationEvent = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    id: Uuid,
    applicationId: Uuid.nullable(),
    deploymentId: Uuid.nullable(),
    operationId: Uuid.nullable(),
    type: z.string().trim().min(1).max(128),
    actorSubjectId: z.string().min(1).max(1_024),
    facts: z.record(
      z.string().min(1).max(128),
      z.union([z.string().max(2_048), z.number(), z.boolean(), z.null()]),
    ),
    createdAt: IsoTimestamp,
  })
  .strict();
export type InternalApplicationEvent = z.infer<typeof InternalApplicationEvent>;

/**
 * Starts one policy-bound OpenGeni session for a deployed application. The
 * application service authenticates with an ordinary least-privilege workspace
 * API key; this request never carries provider credentials.
 */
export const CreateInternalApplicationAiSessionRequest = z
  .object({
    operationId: Uuid,
    initialMessage: z.string().trim().min(1).max(65_536),
    modelContext: z.string().trim().min(1).max(32_768).optional(),
    instructions: z.string().trim().min(1).max(60_000).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    reasoningEffort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    metadata: SecretFreeMetadata.default({}),
  })
  .strict();
export type CreateInternalApplicationAiSessionRequest = z.infer<
  typeof CreateInternalApplicationAiSessionRequest
>;

export const InternalApplicationAiSessionReceipt = z
  .object({
    schemaVersion: z.literal(INTERNAL_APPLICATIONS_SCHEMA_VERSION),
    applicationId: Uuid,
    applicationRevision: z.number().int().positive().safe(),
    sessionId: Uuid,
    initialTurnId: Uuid.nullable(),
    model: z.string().trim().min(1).max(256),
    eventsPath: z.string().startsWith("/v1/workspaces/").max(2_048),
  })
  .strict();
export type InternalApplicationAiSessionReceipt = z.infer<
  typeof InternalApplicationAiSessionReceipt
>;

export const InternalApplicationDeploymentActionResponse = z
  .object({
    deployment: InternalApplicationDeployment,
    operation: InternalApplicationDeploymentOperation,
  })
  .strict();
export type InternalApplicationDeploymentActionResponse = z.infer<
  typeof InternalApplicationDeploymentActionResponse
>;

export const InternalApplicationsListResponse = z
  .object({ applications: z.array(InternalApplicationSummary).max(500) })
  .strict();
export type InternalApplicationsListResponse = z.infer<typeof InternalApplicationsListResponse>;

export const InternalApplicationDataSourcesResponse = z
  .object({ dataSources: z.array(InternalApplicationDataSource).max(500) })
  .strict();
export type InternalApplicationDataSourcesResponse = z.infer<
  typeof InternalApplicationDataSourcesResponse
>;

export const InternalApplicationDeploymentTargetsResponse = z
  .object({ targets: z.array(InternalApplicationDeploymentTarget).max(500) })
  .strict();
export type InternalApplicationDeploymentTargetsResponse = z.infer<
  typeof InternalApplicationDeploymentTargetsResponse
>;

export const InternalApplicationBundlesResponse = z
  .object({ bundles: z.array(InternalApplicationBundle).max(500) })
  .strict();
export type InternalApplicationBundlesResponse = z.infer<typeof InternalApplicationBundlesResponse>;

export const InternalApplicationDeploymentsResponse = z
  .object({ deployments: z.array(InternalApplicationDeployment).max(100) })
  .strict();
export type InternalApplicationDeploymentsResponse = z.infer<
  typeof InternalApplicationDeploymentsResponse
>;

export const InternalApplicationDeploymentOperationsResponse = z
  .object({
    operations: z.array(InternalApplicationDeploymentOperation).max(500),
  })
  .strict();
export type InternalApplicationDeploymentOperationsResponse = z.infer<
  typeof InternalApplicationDeploymentOperationsResponse
>;

export const InternalApplicationEventsResponse = z
  .object({ events: z.array(InternalApplicationEvent).max(500) })
  .strict();
export type InternalApplicationEventsResponse = z.infer<typeof InternalApplicationEventsResponse>;
