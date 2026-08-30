import { z } from "zod";

export const DeploymentProfileId = z.enum([
  "local-compose",
  "local-kubernetes",
  "single-node-kubernetes",
  "kubernetes-external",
  "azure-managed",
  "azure-existing-services",
  "aws-managed",
  "aws-existing-services",
  "gcp-managed",
  "gcp-existing-services",
  "preview-pr",
  "preview-branch",
  "self-contained-kubernetes",
]);
export type DeploymentProfileId = z.infer<typeof DeploymentProfileId>;

export const ProductOverlayId = z.enum(["none", "managed-saas-staging", "managed-saas-production"]);
export type ProductOverlayId = z.infer<typeof ProductOverlayId>;

export const CloudProvider = z.enum(["local", "generic", "azure", "aws", "gcp"]);
export type CloudProvider = z.infer<typeof CloudProvider>;

export const RuntimePlatform = z.enum(["docker-compose", "kubernetes"]);
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;

export const DependencyMode = z.enum(["managed", "external", "inCluster", "disabled"]);
export type DependencyMode = z.infer<typeof DependencyMode>;

export const StorageApi = z.enum(["s3-compatible", "aws-s3", "azure-blob", "gcs"]);
export type StorageApi = z.infer<typeof StorageApi>;

// Mirror of `@opengeni/contracts` SandboxBackend (12 values; every member is
// additive at the end). 3-way enum parity is pinned by the SDK contract-parity
// test.
export const SandboxBackend = z.enum([
  "docker",
  "modal",
  "local",
  "none",
  "daytona",
  "runloop",
  "e2b",
  "blaxel",
  "cloudflare",
  "vercel",
  "selfhosted",
  "opensandbox",
]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

// Backend-gated sandbox env table — the deployment mirror of @opengeni/config's
// SANDBOX_REQUIRED_ENV. Each backend declares ONLY its own env vars: `required`
// vars are emitted as requiredEnv (and surface in requiredRuntimeEnvVars), and
// `optional` vars (operator-tunable passthroughs that may be unset) are emitted
// as valueEnv. This replaces the single hardcoded modal-if at both the
// required-env-manifest site and the runtime-env-render site (one table, two
// consumers — kept in lockstep with config's required-cred set; the parity of
// `required` here vs config's SANDBOX_REQUIRED_ENV is asserted in the tests).
export type SandboxEnvBackendSpec = {
  required: readonly string[];
  optional: readonly string[];
};

export const SANDBOX_REQUIRED_ENV: Record<SandboxBackend, SandboxEnvBackendSpec> = {
  docker: { required: [], optional: [] },
  local: { required: [], optional: [] },
  none: { required: [], optional: [] },
  modal: {
    required: [
      "OPENGENI_MODAL_APP_NAME",
      "OPENGENI_MODAL_TOKEN_ID",
      "OPENGENI_MODAL_TOKEN_SECRET",
      "OPENGENI_MODAL_TIMEOUT_SECONDS",
    ],
    optional: [
      "OPENGENI_MODAL_ENVIRONMENT",
      "OPENGENI_MODAL_IMAGE_REF",
      "OPENGENI_MODAL_IMAGE_REGISTRY_SECRET",
      "OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS",
      "OPENGENI_MODAL_SANDBOX_CPU",
      "OPENGENI_MODAL_SANDBOX_MEMORY_MIB",
      "OPENGENI_MODAL_WORKSPACE_PERSISTENCE",
      "OPENGENI_SANDBOX_ROTATION_BATCH_SIZE",
      "OPENGENI_SANDBOX_ROTATION_LEAD_MS",
    ],
  },
  daytona: {
    required: ["OPENGENI_DAYTONA_API_KEY"],
    optional: [
      "OPENGENI_DAYTONA_API_URL",
      "OPENGENI_DAYTONA_TARGET",
      "OPENGENI_DAYTONA_IMAGE",
      "OPENGENI_DAYTONA_SNAPSHOT_NAME",
    ],
  },
  runloop: {
    required: ["OPENGENI_RUNLOOP_API_KEY"],
    optional: [
      "OPENGENI_RUNLOOP_BASE_URL",
      "OPENGENI_RUNLOOP_BLUEPRINT_NAME",
      "OPENGENI_RUNLOOP_BLUEPRINT_ID",
    ],
  },
  e2b: {
    required: ["OPENGENI_E2B_API_KEY"],
    optional: ["OPENGENI_E2B_TEMPLATE"],
  },
  blaxel: {
    required: ["OPENGENI_BLAXEL_API_KEY"],
    optional: ["OPENGENI_BLAXEL_IMAGE", "OPENGENI_BLAXEL_REGION"],
  },
  cloudflare: {
    required: ["OPENGENI_CLOUDFLARE_WORKER_URL"],
    optional: ["OPENGENI_CLOUDFLARE_API_KEY"],
  },
  vercel: {
    required: ["OPENGENI_VERCEL_TOKEN", "OPENGENI_VERCEL_PROJECT_ID"],
    optional: ["OPENGENI_VERCEL_TEAM_ID", "OPENGENI_VERCEL_RUNTIME"],
  },
  opensandbox: {
    required: [
      "OPENGENI_OPENSANDBOX_BASE_URL",
      "OPENGENI_OPENSANDBOX_API_KEY",
      "OPENGENI_OPENSANDBOX_IMAGE",
    ],
    optional: [
      "OPENGENI_OPENSANDBOX_TTL_SECONDS",
      "OPENGENI_OPENSANDBOX_USE_SERVER_PROXY",
      "OPENGENI_OPENSANDBOX_SIGNED_ENDPOINTS",
      "OPENGENI_OPENSANDBOX_SIGNED_ENDPOINT_TTL_SECONDS",
      "OPENGENI_OPENSANDBOX_CHANNEL_B_PUBLIC_BASE_URL",
      "OPENGENI_OPENSANDBOX_INTERACTION_FRAME_PROXY",
      "OPENGENI_OPENSANDBOX_POOL_REF",
    ],
  },
  // selfhosted carries NO per-backend creds — the user's own machine is reached
  // over the agent's enrollment; the enrollment-signing + relay-token secrets are
  // deployment-level (a runtime secret), not per-active-backend required creds.
  selfhosted: { required: [], optional: [] },
};

// sandbox workspace runtime env (the desktop/Channel-A feature rollout). These are
// recognized by the runtime-artifacts generator so a surfacing-enabled
// deployment (e.g. preview) carries them into the opengeni-runtime secret, but
// they are all passthroughs (emitted only when set) — none are required, so
// they never enter missingEnvVars:
//   - OPENGENI_STREAM_TOKEN_SECRET: HMAC secret minting scoped desktop stream
//     tokens; falls back to OPENGENI_DELEGATION_SECRET when unset.
//   - rollout flags default off in @opengeni/config. Generated deployment
//     artifacts carry explicit operator values in the runtime Secret; the
//     Secret is the authoritative managed-production source because it is the
//     final envFrom source for API and worker workloads.
//   - OPENGENI_MODAL_IMAGE_REF is also a modal-backend optional passthrough; Helm
//     desktop.imageRef is the digest pin that overwrites it for Modal Computer/Browser.
export const SANDBOX_SURFACING_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_STREAM_TOKEN_SECRET",
  "OPENGENI_STREAM_CONTROL_ENABLED",
  "OPENGENI_SANDBOX_OWNERSHIP_ENABLED",
  "OPENGENI_SANDBOX_LAZY_PROVISION",
  "OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED",
  "OPENGENI_SANDBOX_DESKTOP_ENABLED",
];

/** Provider-neutral lease/snapshot lifecycle knobs. These must render for every
 * backend rather than being accidentally gated behind the Modal credential
 * table. */
export const SANDBOX_LIFECYCLE_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_SANDBOX_IDLE_GRACE_MS",
  "OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS",
  "OPENGENI_SANDBOX_LEASE_TTL_MS",
  "OPENGENI_SANDBOX_LEASE_WARMING_TTL_MS",
  "OPENGENI_SANDBOX_SNAPSHOT_INTERVAL_MS",
  "OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS",
  "OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS",
  "OPENGENI_SANDBOX_INTERACTION_HOLDER_TTL_MS",
  "OPENGENI_SANDBOX_WARMING_TIMEOUT_MS",
];

/** Optional request-admission tuning for the API. The workspace control-prefix
 * budget bounds how long one HTTP-originated session/workspace mutation waits
 * to enter `workspace_inference_controls` before the retryable 503; it is
 * validated at boot by @opengeni/config (positive integer ms, default 20000)
 * and is a valueEnv passthrough, emitted only when set. */
export const WORKSPACE_CONTROL_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS",
];

/** Child lifecycle notices rollout flag (API + both workers). Default off in
 * @opengeni/config; a valueEnv passthrough emitted only when set. Enable only
 * once the whole fleet runs an image that understands the new
 * `session_system_updates` kinds (an old worker throws on an unknown kind). */
export const CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED",
];

/** Per-channel and per-DM Slack workspace routing. Default ON in
 * @opengeni/config; a valueEnv passthrough emitted only when set, so an unset
 * key leaves that default alone rather than forcing it off. Turning it OFF is
 * now the deployment decision: with `false` the routing resolver
 * short-circuits to the installation's own workspace before any routing
 * read. */
export const SLACK_WORKSPACE_ROUTING_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED",
];

/** Independent advisory-work rollout switches. These are optional valueEnv
 * passthroughs: config defaults keep read/mutation/human stages on and
 * automatic nudges off, while an operator can stop any stage without removing
 * durable evidence or rolling back migrations. */
export const WORK_DISCOVERY_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_WORK_DISCOVERY_ENABLED",
  "OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED",
  "OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED",
  "OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED",
];

/** Optional remote-browser authorities and launch policy. These remain API
 * runtime secrets/settings; browserd receives only a per-session private
 * transport envelope over its placement-local control channel. */
export const EXTERNAL_BROWSER_PROVIDER_PASSTHROUGH_ENV: readonly string[] = [
  "OPENGENI_BROWSERBASE_API_KEY",
  "OPENGENI_KERNEL_API_KEY",
  "OPENGENI_KERNEL_ENDPOINT",
  "OPENGENI_KERNEL_BROWSER_TIMEOUT_SECONDS",
  "OPENGENI_KERNEL_BROWSER_STEALTH",
];

/** Control-plane secrets needed for a complete Connected Machine deployment.
 * The config layer permits graceful degradation when these are absent; a
 * deployment whose primary backend is selfhosted cannot. */
export const SELFHOSTED_CONTROL_PLANE_REQUIRED_ENV: readonly string[] = [
  "OPENGENI_ENROLLMENT_SIGNING_SECRET",
  "OPENGENI_STREAM_TOKEN_SECRET",
  "OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED",
  "OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY",
  "OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD",
  "OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD",
];

export const SecretDeliveryMode = z.enum([
  "envFile",
  "kubernetesSecret",
  "externalSecrets",
  "vault",
  "azureKeyVault",
  "awsSecretsManager",
  "gcpSecretManager",
]);
export type SecretDeliveryMode = z.infer<typeof SecretDeliveryMode>;

export const ObservabilityBackend = z.enum([
  "none",
  "otel",
  "grafanaLgtm",
  "azureMonitor",
  "awsManaged",
  "gcpManaged",
  "prometheusGrafana",
  "datadog",
  "honeycomb",
  "customerProvided",
]);
export type ObservabilityBackend = z.infer<typeof ObservabilityBackend>;

export const AccessMode = z.enum(["disabled", "sharedKey", "externalGateway"]);
export type AccessMode = z.infer<typeof AccessMode>;

export const ProductAccessMode = z.enum(["local", "configured", "managed"]);
export type ProductAccessMode = z.infer<typeof ProductAccessMode>;

export const ProductBillingMode = z.enum(["disabled", "stripe"]);
export type ProductBillingMode = z.infer<typeof ProductBillingMode>;

export const ProductEntitlementsMode = z.enum(["none", "static", "managed"]);
export type ProductEntitlementsMode = z.infer<typeof ProductEntitlementsMode>;

export const ProductUsageLimitsMode = z.enum(["none", "static", "managed"]);
export type ProductUsageLimitsMode = z.infer<typeof ProductUsageLimitsMode>;

export const SecretRef = z.object({
  name: z.string().min(1),
  key: z.string().min(1).optional(),
});
export type SecretRef = z.infer<typeof SecretRef>;

export const ExternalServiceRef = z.object({
  endpoint: z.string().min(1).optional(),
  secretRef: SecretRef.optional(),
  tlsSecretRef: SecretRef.optional(),
  notes: z.string().min(1).optional(),
});
export type ExternalServiceRef = z.infer<typeof ExternalServiceRef>;

export const ManagedServiceRef = z.object({
  provider: CloudProvider.exclude(["local"]),
  resourceGroup: z.string().min(1).optional(),
  resourceName: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});
export type ManagedServiceRef = z.infer<typeof ManagedServiceRef>;

export const RuntimeSpec = z.object({
  platform: RuntimePlatform,
  cloud: CloudProvider,
  namespace: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  imageRegistry: z.string().min(1).optional(),
  releaseName: z.string().min(1).default("opengeni"),
});
export type RuntimeSpec = z.infer<typeof RuntimeSpec>;

export const DatabaseSpec = z.object({
  mode: DependencyMode.exclude(["disabled"]),
  engine: z.literal("postgres"),
  pgvectorRequired: z.boolean().default(true),
  external: ExternalServiceRef.optional(),
  managed: ManagedServiceRef.optional(),
});
export type DatabaseSpec = z.infer<typeof DatabaseSpec>;

export const TemporalSpec = z.object({
  mode: DependencyMode.exclude(["disabled"]),
  namespace: z.string().min(1).default("default"),
  taskQueue: z.string().min(1).default("opengeni-runs-ts"),
  external: ExternalServiceRef.optional(),
  managed: ManagedServiceRef.optional(),
});
export type TemporalSpec = z.infer<typeof TemporalSpec>;

export const NatsSpec = z.object({
  mode: DependencyMode.exclude(["managed", "disabled"]),
  external: ExternalServiceRef.optional(),
});
export type NatsSpec = z.infer<typeof NatsSpec>;

export const ObjectStorageSpec = z.object({
  mode: DependencyMode.exclude(["disabled"]),
  api: StorageApi,
  bucket: z.string().min(1),
  external: ExternalServiceRef.optional(),
  managed: ManagedServiceRef.optional(),
});
export type ObjectStorageSpec = z.infer<typeof ObjectStorageSpec>;

export const SecretsSpec = z.object({
  mode: SecretDeliveryMode,
  external: ExternalServiceRef.optional(),
});
export type SecretsSpec = z.infer<typeof SecretsSpec>;

export const IngressSpec = z.object({
  enabled: z.boolean().default(true),
  tls: z.boolean().default(true),
  sseTimeoutSeconds: z.number().int().positive().default(3600),
  external: ExternalServiceRef.optional(),
});
export type IngressSpec = z.infer<typeof IngressSpec>;

export const ObservabilitySpec = z.object({
  backend: ObservabilityBackend,
  requireTraces: z.boolean().default(true),
  requireMetrics: z.boolean().default(true),
  requireStructuredLogs: z.boolean().default(true),
  external: ExternalServiceRef.optional(),
});
export type ObservabilitySpec = z.infer<typeof ObservabilitySpec>;

export const AccessSpec = z.object({
  mode: AccessMode,
  allowUnauthenticatedHealth: z.boolean().default(true),
  allowUnauthenticatedMetrics: z.boolean().default(false),
  external: ExternalServiceRef.optional(),
});
export type AccessSpec = z.infer<typeof AccessSpec>;

export const ProductPostureSpec = z.object({
  accessMode: ProductAccessMode,
  billingMode: ProductBillingMode.default("disabled"),
  entitlementsMode: ProductEntitlementsMode.default("none"),
  usageLimitsMode: ProductUsageLimitsMode.default("none"),
  publicBaseUrl: z.string().url().optional(),
});
export type ProductPostureSpec = z.infer<typeof ProductPostureSpec>;

export const SandboxSpec = z.object({
  backend: SandboxBackend,
  preparationProfiles: z.array(z.enum(["none", "azure", "github"])).default(["none"]),
  envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
});
export type SandboxSpec = z.infer<typeof SandboxSpec>;

export const BackupSpec = z.object({
  postgresRequired: z.boolean().default(true),
  objectStorageRequired: z.boolean().default(true),
  restoreDrillRequired: z.boolean().default(true),
});
export type BackupSpec = z.infer<typeof BackupSpec>;

export const DeploymentContract = z
  .object({
    profile: DeploymentProfileId,
    runtime: RuntimeSpec,
    database: DatabaseSpec,
    temporal: TemporalSpec,
    nats: NatsSpec,
    objectStorage: ObjectStorageSpec,
    secrets: SecretsSpec,
    ingress: IngressSpec,
    access: AccessSpec,
    product: ProductPostureSpec,
    observability: ObservabilitySpec,
    sandbox: SandboxSpec,
    backups: BackupSpec.default({
      postgresRequired: true,
      objectStorageRequired: true,
      restoreDrillRequired: true,
    }),
  })
  .superRefine((contract, ctx) => {
    if (contract.runtime.platform === "kubernetes" && !contract.runtime.namespace) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "namespace"],
        message: "Kubernetes deployments require runtime.namespace",
      });
    }
    if (contract.runtime.platform === "docker-compose" && contract.runtime.cloud !== "local") {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "cloud"],
        message: "docker-compose deployments must use the local cloud target",
      });
    }
    if (contract.profile.startsWith("azure") && contract.runtime.cloud !== "azure") {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "cloud"],
        message: "Azure profiles require runtime.cloud=azure",
      });
    }
    if (contract.profile.startsWith("aws") && contract.runtime.cloud !== "aws") {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "cloud"],
        message: "AWS profiles require runtime.cloud=aws",
      });
    }
    if (contract.profile.startsWith("gcp") && contract.runtime.cloud !== "gcp") {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "cloud"],
        message: "GCP profiles require runtime.cloud=gcp",
      });
    }
    if (contract.profile.startsWith("preview") && contract.runtime.platform !== "kubernetes") {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "platform"],
        message: "Preview profiles require Kubernetes runtime",
      });
    }
    if (contract.ingress.enabled && contract.access.mode === "disabled") {
      ctx.addIssue({
        code: "custom",
        path: ["access", "mode"],
        message: "ingress-enabled deployments require shared-key auth or an external gateway",
      });
    }
    if (contract.product.billingMode === "stripe" && contract.product.accessMode !== "managed") {
      ctx.addIssue({
        code: "custom",
        path: ["product", "billingMode"],
        message: "Stripe billing requires product.accessMode=managed",
      });
    }
    if (contract.product.accessMode === "managed" && !contract.product.publicBaseUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["product", "publicBaseUrl"],
        message: "managed product access requires product.publicBaseUrl",
      });
    }
    requireModeReference(
      ctx,
      ["database"],
      contract.database.mode,
      contract.database.external,
      contract.database.managed,
    );
    requireModeReference(
      ctx,
      ["temporal"],
      contract.temporal.mode,
      contract.temporal.external,
      contract.temporal.managed,
    );
    requireModeReference(
      ctx,
      ["objectStorage"],
      contract.objectStorage.mode,
      contract.objectStorage.external,
      contract.objectStorage.managed,
    );
    if (contract.nats.mode === "external" && !contract.nats.external) {
      ctx.addIssue({
        code: "custom",
        path: ["nats", "external"],
        message: "external NATS requires an external service reference",
      });
    }
    if (
      contract.objectStorage.api === "azure-blob" &&
      contract.objectStorage.mode !== "managed" &&
      contract.runtime.cloud !== "azure"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["objectStorage", "api"],
        message: "azure-blob storage is only valid for Azure managed/reference deployments",
      });
    }
    if (
      contract.objectStorage.api === "aws-s3" &&
      !["aws", "generic"].includes(contract.runtime.cloud)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["objectStorage", "api"],
        message: "aws-s3 storage is only valid for AWS or generic Kubernetes deployments",
      });
    }
    if (
      contract.objectStorage.api === "gcs" &&
      !["gcp", "generic"].includes(contract.runtime.cloud)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["objectStorage", "api"],
        message: "gcs storage is only valid for GCP or generic Kubernetes deployments",
      });
    }
  });
export type DeploymentContract = z.infer<typeof DeploymentContract>;

export function contractForProfile(
  profile: DeploymentProfileId,
  overlay: ProductOverlayId = "none",
  env: Record<string, string | undefined> = process.env,
): DeploymentContract {
  return applyProductOverlay(deploymentProfiles[profile], overlay, env);
}

export function applyProductOverlay(
  contract: DeploymentContract,
  overlay: ProductOverlayId,
  env: Record<string, string | undefined> = process.env,
): DeploymentContract {
  if (overlay === "none") {
    return parseDeploymentContract(contract);
  }
  const publicBaseUrl =
    overlay === "managed-saas-staging"
      ? (firstNonEmpty(
          env.OPENGENI_STAGING_PUBLIC_BASE_URL,
          env.OPENGENI_STAGING_FINAL_BASE_URL,
          env.OPENGENI_PUBLIC_BASE_URL,
        ) ?? "https://staging.app.opengeni.ai")
      : (firstNonEmpty(env.OPENGENI_PRODUCTION_FINAL_BASE_URL, env.OPENGENI_PUBLIC_BASE_URL) ??
        "https://app.opengeni.ai");
  return parseDeploymentContract({
    ...contract,
    access: {
      mode: "externalGateway",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "managed",
      billingMode: "stripe",
      entitlementsMode: "managed",
      usageLimitsMode: "managed",
      publicBaseUrl,
    },
    sandbox: { backend: "modal", preparationProfiles: ["none"], envAllowlist: [] },
  });
}

export type PreflightCheckId =
  | "kubernetes-context"
  | "container-registry"
  | "postgres-connectivity"
  | "postgres-pgvector"
  | "postgres-migrations"
  | "temporal-connectivity"
  | "temporal-worker-task-queue"
  | "nats-pubsub"
  | "object-storage-read-write"
  | "secret-delivery"
  | "access-boundary"
  | "product-access-resolver"
  | "managed-auth-email"
  | "billing-stripe-webhook"
  | "usage-limits"
  | "ingress-sse"
  | "otel-export"
  | "sandbox-readiness"
  | "backup-policy"
  | "conformance-session";

export interface PreflightCheck {
  id: PreflightCheckId;
  required: boolean;
  description: string;
}

export interface DeploymentStackPlan {
  profile: DeploymentProfileId;
  terraformRoot: string | null;
  helmValuesFile: string | null;
  platformDependencies: PlatformDependencyPlan[];
  creates: string[];
  externalDependencies: string[];
  requiredSecretKeys: string[];
  deployCommands: string[];
  verifyCommands: string[];
  destroyCommands: string[];
  notes: string[];
}

export interface PlatformDependencyPlan {
  id: "nats" | "temporal" | "opensandbox";
  lifecycle: "officialChart" | "external";
  namespace: string;
  releaseName: string;
  chartRepoName: string | null;
  chartRepoUrl: string | null;
  chartName: string | null;
  valuesFile: string | null;
  runtimeEnv: Record<string, string>;
  requiredEnvVars: string[];
  requiredSecretKeys: string[];
  installCommands: string[];
  verifyCommands: string[];
  destroyCommands: string[];
  notes: string[];
}

export interface TerraformOutputValue {
  sensitive?: boolean;
  type?: unknown;
  value: unknown;
}

export type TerraformOutputs = Record<string, TerraformOutputValue>;

export interface DeploymentRuntimeArtifacts {
  profile: DeploymentProfileId;
  helmValuesYaml: string;
  runtimeEnv: string;
  requiredEnvVars: string[];
  missingEnvVars: string[];
  sensitiveTerraformOutputsUsed: string[];
  summary: {
    helmValueKeys: string[];
    runtimeEnvKeys: string[];
    secretNames: string[];
  };
}

export const deploymentProfiles: Record<DeploymentProfileId, DeploymentContract> = {
  "local-compose": parseDeploymentContract({
    profile: "local-compose",
    runtime: { platform: "docker-compose", cloud: "local", releaseName: "opengeni" },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "envFile" },
    ingress: { enabled: false, tls: false, sseTimeoutSeconds: 3600 },
    access: {
      mode: "disabled",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: true,
    },
    product: {
      accessMode: "local",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "none",
      requireTraces: false,
      requireMetrics: false,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "docker", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "local-kubernetes": parseDeploymentContract({
    profile: "local-kubernetes",
    runtime: {
      platform: "kubernetes",
      cloud: "local",
      namespace: "opengeni-local",
      releaseName: "opengeni-local",
    },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "kubernetesSecret" },
    ingress: { enabled: false, tls: false, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "local",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "none",
      requireTraces: false,
      requireMetrics: false,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "single-node-kubernetes": parseDeploymentContract({
    profile: "single-node-kubernetes",
    runtime: {
      platform: "kubernetes",
      cloud: "generic",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "kubernetesSecret" },
    ingress: { enabled: false, tls: false, sseTimeoutSeconds: 3600 },
    access: {
      mode: "disabled",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "local",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "none",
      requireTraces: false,
      requireMetrics: false,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "selfhosted", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "kubernetes-external": parseDeploymentContract({
    profile: "kubernetes-external",
    runtime: {
      platform: "kubernetes",
      cloud: "generic",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "external",
      engine: "postgres",
      pgvectorRequired: true,
      external: { secretRef: { name: "opengeni-database", key: "OPENGENI_DATABASE_URL" } },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: { secretRef: { name: "opengeni-temporal" } },
    },
    nats: {
      mode: "external",
      external: { secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" } },
    },
    objectStorage: {
      mode: "external",
      api: "s3-compatible",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "externalSecrets" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "otel",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "azure-managed": parseDeploymentContract({
    profile: "azure-managed",
    runtime: {
      platform: "kubernetes",
      cloud: "azure",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "managed",
      engine: "postgres",
      pgvectorRequired: true,
      managed: {
        provider: "azure",
        notes: "Azure Database for PostgreSQL Flexible Server with pgvector enabled.",
      },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: {
        secretRef: { name: "opengeni-temporal", key: "OPENGENI_TEMPORAL_HOST" },
        notes:
          "Temporal Cloud, customer-provided Temporal, or the official Temporal chart managed outside the OpenGeni chart.",
      },
    },
    nats: {
      mode: "external",
      external: {
        secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" },
        notes:
          "Customer-provided NATS or the official NATS chart managed outside the OpenGeni chart.",
      },
    },
    objectStorage: {
      mode: "managed",
      api: "azure-blob",
      bucket: "opengeni-files",
      managed: {
        provider: "azure",
        notes: "Azure Storage account Blob container for production file storage.",
      },
    },
    secrets: { mode: "azureKeyVault" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "azureMonitor",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "azure-existing-services": parseDeploymentContract({
    profile: "azure-existing-services",
    runtime: {
      platform: "kubernetes",
      cloud: "azure",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "external",
      engine: "postgres",
      pgvectorRequired: true,
      external: { secretRef: { name: "opengeni-database", key: "OPENGENI_DATABASE_URL" } },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: { secretRef: { name: "opengeni-temporal" } },
    },
    nats: {
      mode: "external",
      external: { secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" } },
    },
    objectStorage: {
      mode: "external",
      api: "azure-blob",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "azureKeyVault" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "azureMonitor",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "aws-managed": parseDeploymentContract({
    profile: "aws-managed",
    runtime: {
      platform: "kubernetes",
      cloud: "aws",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "managed",
      engine: "postgres",
      pgvectorRequired: true,
      managed: {
        provider: "aws",
        notes: "Amazon RDS PostgreSQL with pgvector compatibility verified.",
      },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: {
        secretRef: { name: "opengeni-temporal", key: "OPENGENI_TEMPORAL_HOST" },
        notes:
          "Temporal Cloud, customer-provided Temporal, or the official Temporal chart managed outside the OpenGeni chart.",
      },
    },
    nats: {
      mode: "external",
      external: {
        secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" },
        notes:
          "Customer-provided NATS or the official NATS chart managed outside the OpenGeni chart.",
      },
    },
    objectStorage: {
      mode: "managed",
      api: "aws-s3",
      bucket: "opengeni-files",
      managed: { provider: "aws", notes: "Amazon S3 bucket for production file storage." },
    },
    secrets: { mode: "awsSecretsManager" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "awsManaged",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "aws-existing-services": parseDeploymentContract({
    profile: "aws-existing-services",
    runtime: {
      platform: "kubernetes",
      cloud: "aws",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "external",
      engine: "postgres",
      pgvectorRequired: true,
      external: { secretRef: { name: "opengeni-database", key: "OPENGENI_DATABASE_URL" } },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: { secretRef: { name: "opengeni-temporal" } },
    },
    nats: {
      mode: "external",
      external: { secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" } },
    },
    objectStorage: {
      mode: "external",
      api: "aws-s3",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "awsSecretsManager" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "awsManaged",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "gcp-managed": parseDeploymentContract({
    profile: "gcp-managed",
    runtime: {
      platform: "kubernetes",
      cloud: "gcp",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "managed",
      engine: "postgres",
      pgvectorRequired: true,
      managed: {
        provider: "gcp",
        notes: "Cloud SQL for PostgreSQL with pgvector compatibility verified.",
      },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: {
        secretRef: { name: "opengeni-temporal", key: "OPENGENI_TEMPORAL_HOST" },
        notes:
          "Temporal Cloud, customer-provided Temporal, or the official Temporal chart managed outside the OpenGeni chart.",
      },
    },
    nats: {
      mode: "external",
      external: {
        secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" },
        notes:
          "Customer-provided NATS or the official NATS chart managed outside the OpenGeni chart.",
      },
    },
    objectStorage: {
      mode: "managed",
      api: "gcs",
      bucket: "opengeni-files",
      managed: {
        provider: "gcp",
        notes: "Google Cloud Storage bucket for production file storage.",
      },
    },
    secrets: { mode: "gcpSecretManager" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "gcpManaged",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "gcp-existing-services": parseDeploymentContract({
    profile: "gcp-existing-services",
    runtime: {
      platform: "kubernetes",
      cloud: "gcp",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: {
      mode: "external",
      engine: "postgres",
      pgvectorRequired: true,
      external: { secretRef: { name: "opengeni-database", key: "OPENGENI_DATABASE_URL" } },
    },
    temporal: {
      mode: "external",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
      external: { secretRef: { name: "opengeni-temporal" } },
    },
    nats: {
      mode: "external",
      external: { secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" } },
    },
    objectStorage: {
      mode: "external",
      api: "gcs",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "gcpSecretManager" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "gcpManaged",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "preview-pr": parseDeploymentContract({
    profile: "preview-pr",
    runtime: {
      platform: "kubernetes",
      cloud: "generic",
      namespace: "opengeni-preview-pr",
      releaseName: "opengeni-preview",
    },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "externalSecrets" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "externalGateway",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "managed",
      billingMode: "stripe",
      entitlementsMode: "managed",
      usageLimitsMode: "managed",
      publicBaseUrl: "https://preview.opengeni.example.com",
    },
    observability: {
      backend: "otel",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "modal", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "preview-branch": parseDeploymentContract({
    profile: "preview-branch",
    runtime: {
      platform: "kubernetes",
      cloud: "generic",
      namespace: "opengeni-preview-branch",
      releaseName: "opengeni-preview",
    },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "externalSecrets" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "externalGateway",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "managed",
      billingMode: "stripe",
      entitlementsMode: "managed",
      usageLimitsMode: "managed",
      publicBaseUrl: "https://preview.opengeni.example.com",
    },
    observability: {
      backend: "otel",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "modal", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "self-contained-kubernetes": parseDeploymentContract({
    profile: "self-contained-kubernetes",
    runtime: {
      platform: "kubernetes",
      cloud: "generic",
      namespace: "opengeni",
      releaseName: "opengeni",
    },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "kubernetesSecret" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    access: {
      mode: "sharedKey",
      allowUnauthenticatedHealth: true,
      allowUnauthenticatedMetrics: false,
    },
    product: {
      accessMode: "configured",
      billingMode: "disabled",
      entitlementsMode: "none",
      usageLimitsMode: "none",
    },
    observability: {
      backend: "otel",
      requireTraces: true,
      requireMetrics: true,
      requireStructuredLogs: true,
    },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
};

export function parseDeploymentContract(input: unknown): DeploymentContract {
  return DeploymentContract.parse(input);
}

export function preflightChecksFor(contract: DeploymentContract): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (contract.runtime.platform === "kubernetes") {
    checks.push(
      check(
        "kubernetes-context",
        true,
        "Verify Kubernetes context, namespace, service accounts, and API access.",
      ),
    );
    checks.push(
      check(
        "container-registry",
        true,
        "Verify immutable OpenGeni images can be pulled by the workload plane.",
      ),
    );
  }
  checks.push(
    check("postgres-connectivity", true, "Verify API and migration jobs can connect to Postgres."),
  );
  if (contract.database.pgvectorRequired) {
    checks.push(
      check(
        "postgres-pgvector",
        true,
        "Verify the pgvector extension is installed or can be enabled.",
      ),
    );
  }
  checks.push(
    check("postgres-migrations", true, "Verify migrations can run safely and idempotently."),
  );
  checks.push(
    check(
      "temporal-connectivity",
      true,
      "Verify API and workers can reach the configured Temporal endpoint.",
    ),
  );
  checks.push(
    check(
      "temporal-worker-task-queue",
      true,
      "Verify workers can poll the configured namespace and task queue.",
    ),
  );
  checks.push(
    check("nats-pubsub", true, "Verify API and workers can publish and subscribe through NATS."),
  );
  checks.push(
    check(
      "object-storage-read-write",
      true,
      "Verify object storage write, read, and URL or mount behavior.",
    ),
  );
  checks.push(
    check(
      "secret-delivery",
      true,
      "Verify required runtime secrets are delivered without leaking unintended values.",
    ),
  );
  checks.push(
    check(
      "access-boundary",
      contract.access.mode !== "disabled",
      "Verify user-facing API, MCP, files, sessions, schedules, and SSE are behind the configured access boundary.",
    ),
  );
  checks.push(
    check(
      "product-access-resolver",
      true,
      `Verify product access mode ${contract.product.accessMode} resolves account/workspace grants.`,
    ),
  );
  if (contract.product.accessMode === "managed") {
    checks.push(
      check(
        "managed-auth-email",
        true,
        "Verify Better Auth email/password signup, email delivery, verification, session cookies, and API-key creation.",
      ),
    );
  }
  if (contract.product.billingMode === "stripe") {
    checks.push(
      check(
        "billing-stripe-webhook",
        true,
        "Verify Stripe Checkout test-mode top-up, webhook signature handling, duplicate handling, local credit grant, refund/dispute adjustment, and low-balance blocking.",
      ),
    );
  }
  if (contract.product.usageLimitsMode !== "none") {
    checks.push(
      check(
        "usage-limits",
        true,
        "Verify the selected usage limit provider blocks capped costly writes and records usage.",
      ),
    );
  }
  if (contract.ingress.enabled) {
    checks.push(
      check(
        "ingress-sse",
        true,
        "Verify ingress supports long-lived SSE streams and reconnect replay.",
      ),
    );
  }
  if (contract.observability.backend !== "none") {
    checks.push(
      check(
        "otel-export",
        true,
        "Verify logs, metrics, and traces reach the configured observability path.",
      ),
    );
  }
  checks.push(
    check(
      "sandbox-readiness",
      contract.sandbox.backend !== "none",
      "Verify the selected sandbox backend can start and run a command.",
    ),
  );
  checks.push(
    check(
      "backup-policy",
      true,
      "Verify backup, retention, and restore drill expectations for durable data.",
    ),
  );
  checks.push(
    check(
      "conformance-session",
      true,
      "Verify a scripted OpenGeni session can create, stream, replay, run, and complete.",
    ),
  );
  return checks;
}

export function requiredRuntimeEnvVars(
  contract: DeploymentContract,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const vars = [
    "OPENGENI_PRODUCT_ACCESS_MODE",
    "OPENGENI_BILLING_MODE",
    "OPENGENI_ENTITLEMENTS_MODE",
    "OPENGENI_USAGE_LIMITS_MODE",
    "OPENGENI_TEMPORAL_NAMESPACE",
    "OPENGENI_TEMPORAL_TASK_QUEUE",
    "OPENGENI_SANDBOX_BACKEND",
    "OPENGENI_OPENAI_PROVIDER",
    "OPENGENI_OPENAI_MODEL",
    "OPENGENI_OPENAI_ALLOWED_MODELS",
  ];
  if (inferredOpenAiProvider(env) === "azure") {
    vars.push(
      env.OPENGENI_AZURE_OPENAI_BASE_URL
        ? "OPENGENI_AZURE_OPENAI_BASE_URL"
        : "OPENGENI_AZURE_OPENAI_ENDPOINT",
      "OPENGENI_AZURE_OPENAI_DEPLOYMENT",
      "OPENGENI_AZURE_OPENAI_API_KEY",
    );
    if (azureOpenAIApiVersionRequired(env)) {
      vars.push("OPENGENI_AZURE_OPENAI_API_VERSION");
    }
  } else {
    vars.push("OPENGENI_OPENAI_API_KEY");
  }
  if (env.OPENGENI_VERCEL_AI_GATEWAY_API_KEY) {
    vars.push("OPENGENI_VERCEL_AI_GATEWAY_API_KEY");
  }
  for (const key of [
    "OPENGENI_MODEL_CATALOG_SOURCE",
    "OPENGENI_MODEL_COST_POLICY_JSON",
    "OPENGENI_MODEL_NOTES_JSON",
    "OPENGENI_OPENROUTER_API_KEY",
  ] as const) {
    if (env[key]) vars.push(key);
  }
  if (runtimeDatabaseUrlRequired(contract)) {
    vars.push("OPENGENI_DATABASE_URL");
  }
  if (contract.temporal.mode !== "inCluster") {
    vars.push("OPENGENI_TEMPORAL_HOST");
  }
  if (contract.nats.mode !== "inCluster") {
    vars.push("OPENGENI_NATS_URL");
  }
  if (contract.objectStorage.mode !== "inCluster") {
    vars.push("OPENGENI_OBJECT_STORAGE_BACKEND", "OPENGENI_OBJECT_STORAGE_BUCKET");
    if (contract.objectStorage.api === "s3-compatible") {
      vars.push(
        "OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID",
        "OPENGENI_OBJECT_STORAGE_ENDPOINT",
        "OPENGENI_OBJECT_STORAGE_REGION",
        "OPENGENI_OBJECT_STORAGE_S3_PROVIDER",
        "OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY",
      );
      if (env.OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT) {
        vars.push("OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT");
      }
    } else if (contract.objectStorage.api === "aws-s3") {
      vars.push("OPENGENI_OBJECT_STORAGE_REGION");
    } else if (contract.objectStorage.api === "azure-blob") {
      vars.push("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
    } else {
      vars.push("OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID");
    }
  }
  if (contract.runtime.platform === "kubernetes") {
    vars.push("OPENGENI_API_HOST", "OPENGENI_API_PORT");
  }
  if (contract.access.mode === "sharedKey") {
    vars.push("OPENGENI_AUTH_REQUIRED", "OPENGENI_ACCESS_KEY");
  }
  if (contract.product.accessMode === "managed") {
    vars.push(
      "OPENGENI_PUBLIC_BASE_URL",
      "OPENGENI_DELEGATION_SECRET",
      "OPENGENI_BETTER_AUTH_SECRET",
      "OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS",
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
      "OPENGENI_RESEND_API_KEY",
      "OPENGENI_EMAIL_FROM",
      "OPENGENI_GITHUB_APP_ID",
      "OPENGENI_GITHUB_CLIENT_ID",
      "OPENGENI_GITHUB_CLIENT_SECRET",
      "OPENGENI_GITHUB_REST_MCP_ENABLED",
      "OPENGENI_GITHUB_APP_SLUG",
      "OPENGENI_GITHUB_APP_PRIVATE_KEY",
      "OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET",
    );
    if (env.OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED === "true") {
      vars.push(
        "OPENGENI_INTEGRATIONS_ENABLED",
        "OPENGENI_INTEGRATIONS_STATE_SECRET",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET",
      );
    }
    for (const key of [
      "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID",
      "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET",
      "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID",
      "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET",
    ] as const) {
      if (env[key]) vars.push(key);
    }
  } else if (contract.product.accessMode === "configured" && contract.access.mode !== "sharedKey") {
    vars.push("OPENGENI_DELEGATION_SECRET");
  }
  for (const key of [
    "OPENGENI_PR_REVIEW_GITHUB_APP_ID",
    "OPENGENI_PR_REVIEW_GITHUB_CLIENT_ID",
    "OPENGENI_PR_REVIEW_GITHUB_CLIENT_SECRET",
    "OPENGENI_PR_REVIEW_GITHUB_APP_SLUG",
    "OPENGENI_PR_REVIEW_GITHUB_WEBHOOK_SECRET",
    "OPENGENI_PR_REVIEW_GITHUB_APP_PRIVATE_KEY",
  ] as const) {
    if (env[key]) vars.push(key);
  }
  if (contract.product.accessMode !== "managed" && env.OPENGENI_PR_REVIEW_GITHUB_APP_ID) {
    vars.push("OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET", "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  if (env.OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS) {
    vars.push("OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS");
  }
  if (env.OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS) {
    vars.push("OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS");
  }
  if (contract.product.billingMode === "stripe") {
    vars.push(
      "OPENGENI_STRIPE_SECRET_KEY",
      "OPENGENI_STRIPE_PUBLISHABLE_KEY",
      "OPENGENI_STRIPE_WEBHOOK_SECRET",
      "OPENGENI_STRIPE_CREDITS_PRODUCT_ID",
      "OPENGENI_MODEL_PRICING_JSON",
    );
  }
  if (contract.product.entitlementsMode === "static") {
    vars.push("OPENGENI_STATIC_ENTITLEMENTS_JSON");
  }
  if (contract.product.usageLimitsMode === "static") {
    vars.push("OPENGENI_STATIC_USAGE_LIMITS_JSON");
  }
  // Backend-gated: only the active backend's required creds enter the manifest.
  vars.push(...SANDBOX_REQUIRED_ENV[contract.sandbox.backend].required);
  if (contract.sandbox.backend === "selfhosted") {
    vars.push(...SELFHOSTED_CONTROL_PLANE_REQUIRED_ENV);
  }
  return [...new Set(vars)].sort();
}

export function missingRuntimeEnvVars(
  contract: DeploymentContract,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return runtimeEnvValues(contract, {}, env)
    .filter((entry) => entry.required && !entry.value)
    .map((entry) => entry.key);
}

export function stackPlanFor(
  contract: DeploymentContract,
  productOverlay: ProductOverlayId = "none",
  env: Record<string, string | undefined> = process.env,
): DeploymentStackPlan {
  const terraformRoot = terraformRootFor(contract);
  const helmValuesFile = helmValuesFileFor(contract);
  const platformDependencies = platformDependencyPlans(contract);
  const requiredSecretKeys = [
    ...requiredRuntimeEnvVars(contract, env).filter((name) => secretLikeRuntimeEnv(name)),
    ...platformDependencies.flatMap((dependency) => dependency.requiredSecretKeys),
    ...profileRequiredSecretKeys(contract),
  ];
  return {
    profile: contract.profile,
    terraformRoot,
    helmValuesFile,
    platformDependencies,
    creates: createdResourceClasses(contract),
    externalDependencies: externalDependencies(contract),
    requiredSecretKeys,
    deployCommands: deployCommands(
      contract,
      terraformRoot,
      helmValuesFile,
      platformDependencies,
      productOverlay,
      env,
    ),
    verifyCommands: verifyCommands(contract, platformDependencies, productOverlay),
    destroyCommands: destroyCommands(contract, terraformRoot, platformDependencies),
    notes: planNotes(contract, env),
  };
}

export function generateRuntimeArtifacts(
  contract: DeploymentContract,
  terraformOutputs: TerraformOutputs,
  env: Record<string, string | undefined> = process.env,
): DeploymentRuntimeArtifacts {
  const helmSetValues = terraformOutputObject(terraformOutputs, "helm_set_values");
  addGeneratedImageValues(helmSetValues, env.OPENGENI_IMAGE_TAG ?? "latest", env);
  addRuntimeConfigHelmValues(helmSetValues, contract, env);
  const helmValues = nestedObjectFromHelmSetValues(helmSetValues);
  const runtimeValues = runtimeEnvValues(contract, terraformOutputs, env);
  const immutableImageDigestInputs =
    contract.runtime.platform === "kubernetes" && contract.runtime.cloud !== "local"
      ? [
          "OPENGENI_API_IMAGE_DIGEST",
          "OPENGENI_WORKER_IMAGE_DIGEST",
          "OPENGENI_WEB_IMAGE_DIGEST",
          "OPENGENI_MIGRATIONS_IMAGE_DIGEST",
        ]
      : [];
  const exactSha256Digest = /^sha256:[a-f0-9]{64}$/u;
  const missingEnvVars = [
    ...runtimeValues.filter((entry) => entry.required && !entry.value).map((entry) => entry.key),
    ...immutableImageDigestInputs.filter((name) => !exactSha256Digest.test(env[name] ?? "")),
  ];
  const requiredEnvVars = [
    ...runtimeValues.filter((entry) => entry.required).map((entry) => entry.key),
    ...immutableImageDigestInputs,
  ];
  const emittedRuntimeValues = runtimeValues.filter(
    (entry) => entry.required || entry.value !== undefined,
  );
  const envLines = emittedRuntimeValues.map(
    (entry) => `${entry.key}=${runtimeEnvFileValue(entry.value)}`,
  );
  const sensitiveTerraformOutputsUsed = runtimeValues
    .filter((entry) => entry.fromSensitiveTerraformOutput)
    .map((entry) => entry.fromSensitiveTerraformOutput as string);

  return {
    profile: contract.profile,
    helmValuesYaml: [
      "# Generated by OpenGeni deployment runtime artifacts. Do not commit generated copies.",
      renderYaml(helmValues).trimEnd(),
      "",
    ].join("\n"),
    runtimeEnv: [
      "# Generated by OpenGeni deployment runtime artifacts. Do not commit generated copies.",
      "# Values in this file are intended for a private Kubernetes Secret.",
      ...envLines,
      "",
    ].join("\n"),
    requiredEnvVars,
    missingEnvVars,
    sensitiveTerraformOutputsUsed,
    summary: {
      helmValueKeys: Object.keys(helmSetValues).sort(),
      runtimeEnvKeys: emittedRuntimeValues.map((entry) => entry.key),
      secretNames: ["opengeni-runtime"],
    },
  };
}

function terraformRootFor(contract: DeploymentContract): string | null {
  if (
    contract.profile.endsWith("existing-services") ||
    !["azure", "aws", "gcp"].includes(contract.runtime.cloud)
  ) {
    return null;
  }
  return `deploy/terraform/${contract.runtime.cloud}`;
}

function helmValuesFileFor(contract: DeploymentContract): string | null {
  if (contract.profile === "local-kubernetes")
    return "deploy/helm/opengeni/values.local-kubernetes.example.yaml";
  if (contract.profile === "single-node-kubernetes")
    return "deploy/helm/opengeni/values.single-node.example.yaml";
  if (contract.profile === "preview-pr" || contract.profile === "preview-branch")
    return "deploy/helm/opengeni/values.preview-managed.example.yaml";
  if (contract.profile === "azure-managed")
    return "deploy/helm/opengeni/values.azure-managed.example.yaml";
  if (contract.profile === "azure-existing-services")
    return "deploy/helm/opengeni/values.azure-existing-services.example.yaml";
  if (contract.profile === "aws-managed")
    return "deploy/helm/opengeni/values.aws-managed.example.yaml";
  if (contract.profile === "gcp-managed")
    return "deploy/helm/opengeni/values.gcp-managed.example.yaml";
  return null;
}

function createdResourceClasses(contract: DeploymentContract): string[] {
  const out = [
    "OpenGeni Kubernetes namespace",
    "OpenGeni Helm release",
    "runtime secret or external secret reference",
  ];
  if (contract.runtime.cloud === "azure" && contract.profile === "azure-managed") {
    out.unshift(
      "Azure resource group",
      "AKS cluster",
      "Azure Container Registry",
      "Azure Key Vault",
      "Azure Blob container",
      "optional Azure Database for PostgreSQL",
    );
  } else if (contract.runtime.cloud === "aws" && contract.profile === "aws-managed") {
    out.unshift(
      "EKS cluster",
      "ECR repositories",
      "S3 bucket",
      "AWS Secrets Manager secret",
      "IAM roles and policies",
      "optional RDS PostgreSQL",
    );
  } else if (contract.runtime.cloud === "gcp" && contract.profile === "gcp-managed") {
    out.unshift(
      "GKE cluster",
      "Artifact Registry repository",
      "GCS bucket",
      "Secret Manager secret",
      "IAM service accounts and bindings",
      "optional Cloud SQL PostgreSQL",
    );
  } else if (contract.profile === "single-node-kubernetes") {
    out.push("persistent single-node Postgres/Temporal/NATS/Garage services and local volumes");
  } else if (
    contract.database.mode === "inCluster" ||
    contract.temporal.mode === "inCluster" ||
    contract.nats.mode === "inCluster" ||
    contract.objectStorage.mode === "inCluster"
  ) {
    out.push("disposable in-cluster Postgres/Temporal/NATS/Garage fixtures");
  }
  if (usesOfficialPlatformChart(contract, "nats")) {
    out.push("official NATS Helm release in opengeni-platform namespace");
  }
  if (usesOfficialPlatformChart(contract, "temporal")) {
    out.push("official Temporal Helm release in opengeni-platform namespace");
  }
  return out;
}

function externalDependencies(contract: DeploymentContract): string[] {
  const out: string[] = [];
  if (contract.database.mode === "external")
    out.push("Postgres with pgvector reachable through OPENGENI_DATABASE_URL");
  if (contract.temporal.mode === "external" && !usesOfficialPlatformChart(contract, "temporal")) {
    out.push("Temporal Cloud, existing Temporal, or official Temporal Helm chart endpoint");
  }
  if (contract.nats.mode === "external" && !usesOfficialPlatformChart(contract, "nats")) {
    out.push("Existing NATS endpoint or official NATS Helm chart endpoint");
  }
  if (contract.objectStorage.mode === "external")
    out.push(`${contract.objectStorage.api} object storage credentials and bucket/container`);
  if (contract.ingress.enabled)
    out.push("Ingress/TLS stack with SSE buffering disabled and 3600s timeouts");
  if (contract.access.mode === "externalGateway")
    out.push("Gateway-managed authentication and authorization");
  return out;
}

const HELM_APPLICATION_DRAIN_ARGS = [
  "--set api.enabled=false",
  "--set worker.enabled=false",
  "--set web.enabled=false",
  "--set relay.enabled=false",
  "--set artifactMaterializer.enabled=false",
  "--set artifactOutboxDispatcher.enabled=false",
  "--set terraformMcp.enabled=false",
  "--set migrations.enabled=false",
].join(" ");

export const MODEL_CATALOG_MAINTENANCE_CUTOVER = "0383_model_catalog_and_gateway_custom_models";

const MAINTENANCE_IMAGE_DIGEST_ENV = {
  api: "OPENGENI_API_IMAGE_DIGEST",
  worker: "OPENGENI_WORKER_IMAGE_DIGEST",
  web: "OPENGENI_WEB_IMAGE_DIGEST",
  migrations: "OPENGENI_MIGRATIONS_IMAGE_DIGEST",
} as const;

function maintenanceImageDigestHelmArgs(
  contract: DeploymentContract,
  terraformRoot: string | null,
  env: Record<string, string | undefined>,
): string {
  if (!requestedMaintenanceCutover(env)) return "";
  // Managed plans resolve registry digests after publishing the exact images
  // and inject them through helm-values.generated.yaml.
  if (terraformRoot) return "";
  if (contract.runtime.platform !== "kubernetes") {
    throw new Error(
      `${MODEL_CATALOG_MAINTENANCE_CUTOVER} requires a non-local Kubernetes deployment with immutable image artifacts`,
    );
  }
  // Local Kubernetes derives one content identity from the freshly built
  // Docker image IDs and binds both Helm revisions to that persisted tag.
  if (contract.runtime.cloud === "local") return "";
  const exactSha256Digest = /^sha256:[a-f0-9]{64}$/u;
  const digests = Object.fromEntries(
    Object.entries(MAINTENANCE_IMAGE_DIGEST_ENV).map(([component, name]) => {
      const digest = env[name]?.trim() ?? "";
      if (!exactSha256Digest.test(digest)) {
        throw new Error(`${name} must be an exact sha256 digest for a maintenance cutover`);
      }
      return [component, digest];
    }),
  ) as Record<keyof typeof MAINTENANCE_IMAGE_DIGEST_ENV, string>;
  if (digests.migrations !== digests.api) {
    throw new Error(
      "OPENGENI_MIGRATIONS_IMAGE_DIGEST must equal OPENGENI_API_IMAGE_DIGEST because migrations run from the API image",
    );
  }
  return Object.entries(digests)
    .map(([component, digest]) => ` --set-string ${component}.image.digest=${digest}`)
    .join("");
}

function requestedMaintenanceCutover(
  env: Record<string, string | undefined>,
): typeof MODEL_CATALOG_MAINTENANCE_CUTOVER | null {
  const requested = env.OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER?.trim();
  if (!requested) return null;
  if (requested !== MODEL_CATALOG_MAINTENANCE_CUTOVER) {
    throw new Error(`unsupported OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: ${requested}`);
  }
  if (env.OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED !== "true") {
    throw new Error(
      "OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED=true is required for a maintenance cutover",
    );
  }
  return requested;
}

function helmApplicationDrainWaitCommand(namespace: string, release: string): string {
  const selector =
    `app.kubernetes.io/instance=${release},` +
    "app.kubernetes.io/component in (api,worker-control,worker-turns,artifact-materializer,artifact-outbox-dispatcher,relay,web,terraform-mcp)";
  return `if kubectl -n ${namespace} get pods -l '${selector}' -o name | grep -q .; then kubectl -n ${namespace} wait --for=delete pod -l '${selector}' --timeout=10m; fi`;
}

function helmApplicationDrainCommands(input: {
  contract: DeploymentContract;
  namespace: string;
  release: string;
  drainUpgradeCommand: string;
  env: Record<string, string | undefined>;
}): string[] {
  const wait = helmApplicationDrainWaitCommand(input.namespace, input.release);
  if (requestedMaintenanceCutover(input.env)) {
    return [input.drainUpgradeCommand, wait];
  }
  const needsBootstrapRevision =
    input.contract.database.mode === "inCluster" ||
    input.contract.temporal.mode === "inCluster" ||
    input.contract.nats.mode === "inCluster" ||
    input.contract.objectStorage.mode === "inCluster";
  if (!needsBootstrapRevision) return [];
  return [
    `if ! helm status ${input.release} --namespace ${input.namespace} >/dev/null 2>&1; then ${input.drainUpgradeCommand} && ${wait}; fi`,
  ];
}

function deployCommands(
  contract: DeploymentContract,
  terraformRoot: string | null,
  helmValuesFile: string | null,
  platformDependencies: PlatformDependencyPlan[],
  productOverlay: ProductOverlayId,
  env: Record<string, string | undefined>,
): string[] {
  if (contract.profile === "local-compose") {
    return ["bun run dev"];
  }
  if (contract.profile === "single-node-kubernetes") {
    const namespace = contract.runtime.namespace ?? "opengeni";
    const release = contract.runtime.releaseName;
    const values = helmValuesFile ?? "deploy/helm/opengeni/values.single-node.example.yaml";
    const opensandbox = platformDependencies.find((dependency) => dependency.id === "opensandbox");
    const sandboxSecretArgs = opensandbox
      ? ' --from-literal=OPENGENI_OPENSANDBOX_API_KEY="$OPENGENI_OPENSANDBOX_API_KEY" --from-literal=OPENGENI_OPENSANDBOX_IMAGE="$OPENGENI_OPENSANDBOX_IMAGE"'
      : "";
    const sandboxValueArgs = opensandbox
      ? " --set-string config.OPENGENI_SANDBOX_BACKEND=opensandbox --set-string config.OPENGENI_OPENSANDBOX_BASE_URL=http://opensandbox-server.opensandbox-system.svc.cluster.local"
      : "";
    const drainUpgradeCommand =
      `helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace} --values ${values} ` +
      `${HELM_APPLICATION_DRAIN_ARGS} --wait --timeout 10m`;
    return [
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      "bun run deployment:single-node-secrets -- --out-dir .agent/generated/single-node/secrets",
      `kubectl -n ${namespace} create secret generic opengeni-postgres --from-env-file=.agent/generated/single-node/secrets/postgres.env --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl -n ${namespace} create secret generic opengeni-garage --from-env-file=.agent/generated/single-node/secrets/garage.env --from-file=garage.toml=.agent/generated/single-node/secrets/garage.toml --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl -n ${namespace} create secret generic opengeni-runtime --from-env-file=.agent/generated/single-node/secrets/runtime.env${sandboxSecretArgs} --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl -n ${namespace} create secret generic opengeni-migrations --from-env-file=.agent/generated/single-node/secrets/migrations.env --dry-run=client -o yaml | kubectl apply -f -`,
      ...platformDependencies.flatMap((dependency) => dependency.installCommands),
      ...helmApplicationDrainCommands({
        contract,
        namespace,
        release,
        drainUpgradeCommand,
        env,
      }),
      `helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace} --values ${values}${sandboxValueArgs} --wait --timeout 15m`,
    ];
  }
  if (contract.profile === "local-kubernetes") {
    const maintenanceCutover = requestedMaintenanceCutover(env) !== null;
    const opensandbox = platformDependencies.find((dependency) => dependency.id === "opensandbox");
    const sandboxSecretArgs = opensandbox
      ? ' --from-literal=OPENGENI_OPENSANDBOX_API_KEY="$OPENGENI_OPENSANDBOX_API_KEY" --from-literal=OPENGENI_OPENSANDBOX_IMAGE="$OPENGENI_OPENSANDBOX_IMAGE"'
      : "";
    const sandboxValueArgs = opensandbox
      ? " --set-string config.OPENGENI_SANDBOX_BACKEND=opensandbox --set-string config.OPENGENI_OPENSANDBOX_BASE_URL=http://opensandbox-server.opensandbox-system.svc.cluster.local"
      : "";
    const namespace = contract.runtime.namespace ?? "opengeni-local";
    const release = contract.runtime.releaseName;
    const values = helmValuesFile ?? "deploy/helm/opengeni/values.local-kubernetes.example.yaml";
    const maintenanceImageEnvFile = ".agent/generated/local-kubernetes/maintenance-image-tag.env";
    const maintenanceImageEnvPrefix = maintenanceCutover
      ? `set -a && . ${maintenanceImageEnvFile} && set +a && `
      : "";
    const localImageTag = maintenanceCutover ? "$OPENGENI_LOCAL_K8S_IMAGE_TAG" : "local-k8s";
    const maintenanceImageTagHelmArgs = maintenanceCutover
      ? ["api", "worker", "web", "migrations"]
          .map(
            (component) => ` --set-string ${component}.image.tag="$OPENGENI_LOCAL_K8S_IMAGE_TAG"`,
          )
          .join("")
      : "";
    const drainUpgradeCommand =
      `${maintenanceImageEnvPrefix}helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace} --values ${values}${sandboxValueArgs} ` +
      `${HELM_APPLICATION_DRAIN_ARGS}${maintenanceImageTagHelmArgs} --wait --timeout 10m`;
    const localImageCommands = maintenanceCutover
      ? [
          "docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target api -t opengeni-api:local-k8s-maintenance-candidate .",
          "docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target worker -t opengeni-worker:local-k8s-maintenance-candidate .",
          "OPENGENI_DEPLOYMENT_REVISION=${OPENGENI_DEPLOYMENT_REVISION:-$(git rev-parse HEAD)} docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target web --build-arg OPENGENI_DEPLOYMENT_REVISION -t opengeni-web:local-k8s-maintenance-candidate .",
          `mkdir -p .agent/generated/local-kubernetes && OPENGENI_LOCAL_K8S_IMAGE_TAG="maintenance-$(printf '%s\\n' "$(docker image inspect --format '{{.Id}}' opengeni-api:local-k8s-maintenance-candidate)" "$(docker image inspect --format '{{.Id}}' opengeni-worker:local-k8s-maintenance-candidate)" "$(docker image inspect --format '{{.Id}}' opengeni-web:local-k8s-maintenance-candidate)" | git hash-object --stdin)" && printf 'OPENGENI_LOCAL_K8S_IMAGE_TAG=%s\\n' "$OPENGENI_LOCAL_K8S_IMAGE_TAG" > ${maintenanceImageEnvFile} && docker tag opengeni-api:local-k8s-maintenance-candidate "opengeni-api:$OPENGENI_LOCAL_K8S_IMAGE_TAG" && docker tag opengeni-worker:local-k8s-maintenance-candidate "opengeni-worker:$OPENGENI_LOCAL_K8S_IMAGE_TAG" && docker tag opengeni-web:local-k8s-maintenance-candidate "opengeni-web:$OPENGENI_LOCAL_K8S_IMAGE_TAG"`,
          `${maintenanceImageEnvPrefix}kind load docker-image "opengeni-api:${localImageTag}" "opengeni-worker:${localImageTag}" "opengeni-web:${localImageTag}" --name \${KIND_CLUSTER_NAME:-opengeni-local}`,
        ]
      : [
          "docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target api -t opengeni-api:local-k8s .",
          "docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target worker -t opengeni-worker:local-k8s .",
          "OPENGENI_DEPLOYMENT_REVISION=${OPENGENI_DEPLOYMENT_REVISION:-local-k8s} docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target web --build-arg OPENGENI_DEPLOYMENT_REVISION -t opengeni-web:local-k8s .",
          "kind load docker-image opengeni-api:local-k8s opengeni-worker:local-k8s opengeni-web:local-k8s --name ${KIND_CLUSTER_NAME:-opengeni-local}",
        ];
    return [
      ...localImageCommands,
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl -n ${namespace} create secret generic opengeni-runtime-local-k8s --from-literal=OPENGENI_ACCESS_KEY="$OPENGENI_ACCESS_KEY" --from-literal=OPENGENI_DATABASE_URL="postgres://opengeni_app:opengeni_app@opengeni-local-postgres:5432/opengeni" --from-literal=OPENGENI_MIGRATIONS_DATABASE_URL="postgres://opengeni:opengeni@opengeni-local-postgres:5432/opengeni" --from-literal=OPENGENI_APP_DATABASE_USER=opengeni_app --from-literal=OPENGENI_APP_DATABASE_PASSWORD=opengeni_app${sandboxSecretArgs} --dry-run=client -o yaml | kubectl apply -f -`,
      ...platformDependencies.flatMap((dependency) => dependency.installCommands),
      ...helmApplicationDrainCommands({
        contract,
        namespace,
        release,
        drainUpgradeCommand,
        env,
      }),
      `${maintenanceImageEnvPrefix}helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace} --values ${values}${sandboxValueArgs}${maintenanceImageTagHelmArgs} --wait --timeout 15m`,
    ];
  }
  const commands: string[] = [
    `kubectl create namespace ${contract.runtime.namespace ?? "opengeni"} --dry-run=client -o yaml | kubectl apply -f -`,
  ];
  if (terraformRoot) {
    const overlayArg = productOverlay === "none" ? "" : ` --product-overlay ${productOverlay}`;
    commands.unshift(
      `terraform -chdir=${terraformRoot} init -backend=false`,
      `terraform -chdir=${terraformRoot} plan -var-file=terraform.tfvars`,
      `terraform -chdir=${terraformRoot} apply -var-file=terraform.tfvars`,
    );
    commands.push(
      `mkdir -p .agent/generated/${contract.profile}`,
      `terraform -chdir=${terraformRoot} output -json > .agent/generated/${contract.profile}/terraform-output.json`,
      ...imageBuildPushCommands(contract, terraformRoot),
      imageDigestResolutionCommand(contract, terraformRoot),
      `set -a && . .agent/generated/${contract.profile}/image-digests.env && set +a && OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" bun run deployment:runtime-artifacts -- --profile ${contract.profile}${overlayArg} --terraform-output .agent/generated/${contract.profile}/terraform-output.json --out-dir .agent/generated/${contract.profile}`,
      `kubectl -n ${contract.runtime.namespace ?? "opengeni"} create secret generic opengeni-runtime --from-env-file=.agent/generated/${contract.profile}/runtime.env --dry-run=client -o yaml | kubectl apply -f -`,
    );
  }
  for (const dependency of platformDependencies) {
    commands.push(...dependency.installCommands);
  }
  const generatedValuesArg = terraformRoot
    ? ` --values .agent/generated/${contract.profile}/helm-values.generated.yaml`
    : "";
  const valuesArg = `${helmValuesFile ? ` --values ${helmValuesFile}` : ""}${generatedValuesArg}`;
  const release = contract.runtime.releaseName;
  const namespace = contract.runtime.namespace ?? "opengeni";
  const drainUpgradeCommand =
    `helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace}${valuesArg} ` +
    `${HELM_APPLICATION_DRAIN_ARGS} --wait --timeout 15m`;
  commands.push(
    ...helmApplicationDrainCommands({
      contract,
      namespace,
      release,
      drainUpgradeCommand,
      env,
    }),
    `helm upgrade --install ${release} deploy/helm/opengeni --namespace ${namespace}${valuesArg} --wait --timeout 15m`,
  );
  return commands;
}

function verifyCommands(
  contract: DeploymentContract,
  platformDependencies: PlatformDependencyPlan[],
  productOverlay: ProductOverlayId,
): string[] {
  const baseUrl = contract.ingress.enabled
    ? (contract.product.publicBaseUrl ?? "https://opengeni.example.com")
    : "http://127.0.0.1:18080";
  const conformance = `bun run deployment:conformance -- --base-url ${baseUrl}`;
  const overlayArg = productOverlay === "none" ? "" : ` --product-overlay ${productOverlay}`;
  return [
    ...platformDependencies.flatMap((dependency) => dependency.verifyCommands),
    `bun run deployment:preflight -- --profile ${contract.profile}${overlayArg} --check-env`,
    contract.access.mode === "sharedKey"
      ? `OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY="$OPENGENI_ACCESS_KEY" ${conformance}`
      : contract.product.accessMode === "managed"
        ? `OPENGENI_CONFORMANCE_PRODUCT_TOKEN="$OPENGENI_TEST_WORKSPACE_API_KEY" ${conformance}`
        : conformance,
  ];
}

function imageBuildPushCommands(contract: DeploymentContract, terraformRoot: string): string[] {
  if (contract.runtime.cloud === "azure") {
    return [
      `ACR_LOGIN_SERVER="$(terraform -chdir=${terraformRoot} output -raw acr_login_server)" && ACR_ACCESS_TOKEN="$(az acr login --name "\${ACR_LOGIN_SERVER%%.*}" --expose-token --query accessToken -o tsv)" && printf '%s' "$ACR_ACCESS_TOKEN" | docker login "$ACR_LOGIN_SERVER" --username 00000000-0000-0000-0000-000000000000 --password-stdin`,
      `ACR_LOGIN_SERVER="$(terraform -chdir=${terraformRoot} output -raw acr_login_server)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target api -t "$ACR_LOGIN_SERVER/opengeni-api:$OPENGENI_IMAGE_TAG" . && docker push "$ACR_LOGIN_SERVER/opengeni-api:$OPENGENI_IMAGE_TAG"`,
      `ACR_LOGIN_SERVER="$(terraform -chdir=${terraformRoot} output -raw acr_login_server)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target worker -t "$ACR_LOGIN_SERVER/opengeni-worker:$OPENGENI_IMAGE_TAG" . && docker push "$ACR_LOGIN_SERVER/opengeni-worker:$OPENGENI_IMAGE_TAG"`,
      `ACR_LOGIN_SERVER="$(terraform -chdir=${terraformRoot} output -raw acr_login_server)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" OPENGENI_DEPLOYMENT_REVISION="\${OPENGENI_DEPLOYMENT_REVISION:-$OPENGENI_IMAGE_TAG}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target web --build-arg OPENGENI_DEPLOYMENT_REVISION -t "$ACR_LOGIN_SERVER/opengeni-web:$OPENGENI_IMAGE_TAG" . && docker push "$ACR_LOGIN_SERVER/opengeni-web:$OPENGENI_IMAGE_TAG"`,
    ];
  }
  if (contract.runtime.cloud === "aws") {
    return [
      `AWS_REGION="$(terraform -chdir=${terraformRoot} output -raw region)" && AWS_ACCOUNT_ID="$(terraform -chdir=${terraformRoot} output -raw account_id)" && aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"`,
      `API_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .api)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target api -t "$API_IMAGE:$OPENGENI_IMAGE_TAG" . && docker push "$API_IMAGE:$OPENGENI_IMAGE_TAG"`,
      `WORKER_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .worker)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target worker -t "$WORKER_IMAGE:$OPENGENI_IMAGE_TAG" . && docker push "$WORKER_IMAGE:$OPENGENI_IMAGE_TAG"`,
      `WEB_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .web)" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" OPENGENI_DEPLOYMENT_REVISION="\${OPENGENI_DEPLOYMENT_REVISION:-$OPENGENI_IMAGE_TAG}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target web --build-arg OPENGENI_DEPLOYMENT_REVISION -t "$WEB_IMAGE:$OPENGENI_IMAGE_TAG" . && docker push "$WEB_IMAGE:$OPENGENI_IMAGE_TAG"`,
    ];
  }
  if (contract.runtime.cloud === "gcp") {
    return [
      `GCP_IMAGE_REGISTRY="$(terraform -chdir=${terraformRoot} output -json helm_set_values | jq -r '."global.imageRegistry"')" && gcloud auth configure-docker "\${GCP_IMAGE_REGISTRY%%/*}" --quiet`,
      `GCP_IMAGE_REGISTRY="$(terraform -chdir=${terraformRoot} output -json helm_set_values | jq -r '."global.imageRegistry"')" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target api -t "$GCP_IMAGE_REGISTRY/opengeni-api:$OPENGENI_IMAGE_TAG" . && docker push "$GCP_IMAGE_REGISTRY/opengeni-api:$OPENGENI_IMAGE_TAG"`,
      `GCP_IMAGE_REGISTRY="$(terraform -chdir=${terraformRoot} output -json helm_set_values | jq -r '."global.imageRegistry"')" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target worker -t "$GCP_IMAGE_REGISTRY/opengeni-worker:$OPENGENI_IMAGE_TAG" . && docker push "$GCP_IMAGE_REGISTRY/opengeni-worker:$OPENGENI_IMAGE_TAG"`,
      `GCP_IMAGE_REGISTRY="$(terraform -chdir=${terraformRoot} output -json helm_set_values | jq -r '."global.imageRegistry"')" OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" OPENGENI_DEPLOYMENT_REVISION="\${OPENGENI_DEPLOYMENT_REVISION:-$OPENGENI_IMAGE_TAG}" docker build --platform \${OPENGENI_IMAGE_PLATFORM:-linux/amd64} -f docker/opengeni.Dockerfile --target web --build-arg OPENGENI_DEPLOYMENT_REVISION -t "$GCP_IMAGE_REGISTRY/opengeni-web:$OPENGENI_IMAGE_TAG" . && docker push "$GCP_IMAGE_REGISTRY/opengeni-web:$OPENGENI_IMAGE_TAG"`,
    ];
  }
  return [];
}

function imageDigestResolutionCommand(contract: DeploymentContract, terraformRoot: string): string {
  const output = `.agent/generated/${contract.profile}/image-digests.env`;
  const writeEnv =
    `umask 077 && { printf 'OPENGENI_API_IMAGE_DIGEST=%s\\n' "$OPENGENI_API_IMAGE_DIGEST"; ` +
    `printf 'OPENGENI_WORKER_IMAGE_DIGEST=%s\\n' "$OPENGENI_WORKER_IMAGE_DIGEST"; ` +
    `printf 'OPENGENI_WEB_IMAGE_DIGEST=%s\\n' "$OPENGENI_WEB_IMAGE_DIGEST"; ` +
    `printf 'OPENGENI_MIGRATIONS_IMAGE_DIGEST=%s\\n' "$OPENGENI_API_IMAGE_DIGEST"; } > ${output}`;
  if (contract.runtime.cloud === "azure") {
    return (
      `ACR_LOGIN_SERVER="$(terraform -chdir=${terraformRoot} output -raw acr_login_server)" && ` +
      `ACR_NAME="\${ACR_LOGIN_SERVER%%.*}" && OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" && ` +
      `OPENGENI_API_IMAGE_DIGEST="$(az acr repository show --name "$ACR_NAME" --image "opengeni-api:$OPENGENI_IMAGE_TAG" --query digest -o tsv)" && ` +
      `OPENGENI_WORKER_IMAGE_DIGEST="$(az acr repository show --name "$ACR_NAME" --image "opengeni-worker:$OPENGENI_IMAGE_TAG" --query digest -o tsv)" && ` +
      `OPENGENI_WEB_IMAGE_DIGEST="$(az acr repository show --name "$ACR_NAME" --image "opengeni-web:$OPENGENI_IMAGE_TAG" --query digest -o tsv)" && ${writeEnv}`
    );
  }
  if (contract.runtime.cloud === "aws") {
    return (
      `AWS_REGION="$(terraform -chdir=${terraformRoot} output -raw region)" && ` +
      `API_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .api)" && ` +
      `WORKER_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .worker)" && ` +
      `WEB_IMAGE="$(terraform -chdir=${terraformRoot} output -json ecr_repository_urls | jq -r .web)" && ` +
      `OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" && ` +
      `OPENGENI_API_IMAGE_DIGEST="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "\${API_IMAGE#*/}" --image-ids imageTag="$OPENGENI_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text)" && ` +
      `OPENGENI_WORKER_IMAGE_DIGEST="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "\${WORKER_IMAGE#*/}" --image-ids imageTag="$OPENGENI_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text)" && ` +
      `OPENGENI_WEB_IMAGE_DIGEST="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "\${WEB_IMAGE#*/}" --image-ids imageTag="$OPENGENI_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text)" && ${writeEnv}`
    );
  }
  if (contract.runtime.cloud === "gcp") {
    return (
      `GCP_IMAGE_REGISTRY="$(terraform -chdir=${terraformRoot} output -json helm_set_values | jq -r '."global.imageRegistry"')" && ` +
      `OPENGENI_IMAGE_TAG="\${OPENGENI_IMAGE_TAG:-$(git rev-parse --short HEAD)}" && ` +
      `OPENGENI_API_IMAGE_DIGEST="$(gcloud artifacts docker images describe "$GCP_IMAGE_REGISTRY/opengeni-api:$OPENGENI_IMAGE_TAG" --format='value(image_summary.digest)')" && ` +
      `OPENGENI_WORKER_IMAGE_DIGEST="$(gcloud artifacts docker images describe "$GCP_IMAGE_REGISTRY/opengeni-worker:$OPENGENI_IMAGE_TAG" --format='value(image_summary.digest)')" && ` +
      `OPENGENI_WEB_IMAGE_DIGEST="$(gcloud artifacts docker images describe "$GCP_IMAGE_REGISTRY/opengeni-web:$OPENGENI_IMAGE_TAG" --format='value(image_summary.digest)')" && ${writeEnv}`
    );
  }
  throw new Error(`immutable image digest resolution is unsupported for ${contract.runtime.cloud}`);
}

function destroyCommands(
  contract: DeploymentContract,
  terraformRoot: string | null,
  platformDependencies: PlatformDependencyPlan[],
): string[] {
  if (contract.profile === "local-compose") {
    return ["docker compose down --remove-orphans"];
  }
  const commands = [
    `helm uninstall ${contract.runtime.releaseName} --namespace ${contract.runtime.namespace ?? "opengeni"} --ignore-not-found`,
    `kubectl delete namespace ${contract.runtime.namespace ?? "opengeni"} --ignore-not-found`,
  ];
  for (const dependency of [...platformDependencies].reverse()) {
    commands.push(...dependency.destroyCommands);
  }
  if (platformDependencies.some((dependency) => dependency.namespace === "opengeni-platform")) {
    commands.push("kubectl delete namespace opengeni-platform --ignore-not-found");
  }
  if (terraformRoot) {
    commands.push(`terraform -chdir=${terraformRoot} destroy -var-file=terraform.tfvars`);
  }
  return commands;
}

function platformDependencyPlans(contract: DeploymentContract): PlatformDependencyPlan[] {
  if (contract.runtime.platform !== "kubernetes") {
    return [];
  }
  const managesOfficialCoreDependencies = [
    "azure-managed",
    "aws-managed",
    "gcp-managed",
    "self-contained-kubernetes",
  ].includes(contract.profile);
  const namespace = "opengeni-platform";
  const out: PlatformDependencyPlan[] = [];
  if (managesOfficialCoreDependencies && contract.nats.mode === "external") {
    out.push({
      id: "nats",
      lifecycle: "officialChart",
      namespace,
      releaseName: "opengeni-nats",
      chartRepoName: "nats",
      chartRepoUrl: "https://nats-io.github.io/k8s/helm/charts",
      chartName: "nats/nats",
      valuesFile: "deploy/stacks/official-nats.values.yaml",
      runtimeEnv: {
        OPENGENI_NATS_URL: "nats://opengeni-nats.opengeni-platform.svc.cluster.local:4222",
      },
      requiredEnvVars: [],
      requiredSecretKeys: [],
      installCommands: [
        "helm repo add nats https://nats-io.github.io/k8s/helm/charts",
        "helm repo update nats",
        "kubectl create namespace opengeni-platform --dry-run=client -o yaml | kubectl apply -f -",
        "helm upgrade --install opengeni-nats nats/nats --version 2.14.0 --namespace opengeni-platform --values deploy/stacks/official-nats.values.yaml",
        "kubectl apply -f deploy/stacks/opengeni-platform-networkpolicies.yaml",
      ],
      verifyCommands: [
        "kubectl -n opengeni-platform rollout status statefulset/opengeni-nats --timeout=180s",
        "kubectl -n opengeni-platform get svc opengeni-nats",
        "helm test opengeni-nats --namespace opengeni-platform --timeout 180s",
      ],
      destroyCommands: [
        "helm uninstall opengeni-nats --namespace opengeni-platform --ignore-not-found",
      ],
      notes: [
        "The official NATS chart is lifecycle-managed by the stack wrapper, not by the OpenGeni app chart.",
        "The service is ClusterIP-only; do not expose NATS with LoadBalancer or public ingress for the default stack.",
      ],
    });
  }
  if (managesOfficialCoreDependencies && contract.temporal.mode === "external") {
    const temporalTlsEnv =
      contract.runtime.cloud === "aws"
        ? `TEMPORAL_POSTGRES_TLS_ENABLED="\${TEMPORAL_POSTGRES_TLS_ENABLED:-true}" TEMPORAL_POSTGRES_TLS_CA_FILE="\${TEMPORAL_POSTGRES_TLS_CA_FILE:-/etc/opengeni/postgres-ca/ca.pem}" TEMPORAL_POSTGRES_TLS_CA_CONFIG_MAP_NAME="\${TEMPORAL_POSTGRES_TLS_CA_CONFIG_MAP_NAME:-opengeni-postgres-ca}"`
        : ["azure", "gcp"].includes(contract.runtime.cloud)
          ? `TEMPORAL_POSTGRES_TLS_ENABLED="\${TEMPORAL_POSTGRES_TLS_ENABLED:-true}"`
          : "";
    const temporalValuesCommand = `${temporalTlsEnv ? `${temporalTlsEnv} ` : ""}bun run deployment:temporal-values -- --out .agent/generated/${contract.profile}/official-temporal-postgres.values.yaml`;
    const temporalTlsPrepCommands =
      contract.runtime.cloud === "aws"
        ? [
            `curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o .agent/generated/${contract.profile}/rds-global-bundle.pem`,
            `kubectl -n opengeni-platform create configmap opengeni-postgres-ca --from-file=ca.pem=.agent/generated/${contract.profile}/rds-global-bundle.pem --dry-run=client -o yaml | kubectl apply -f -`,
          ]
        : [];
    out.push({
      id: "temporal",
      lifecycle: "officialChart",
      namespace,
      releaseName: "opengeni-temporal",
      chartRepoName: "temporal",
      chartRepoUrl: "https://go.temporal.io/helm-charts",
      chartName: "temporal/temporal",
      valuesFile: "deploy/stacks/official-temporal-postgres.values.example.yaml",
      runtimeEnv: {
        OPENGENI_TEMPORAL_HOST:
          "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
      },
      requiredEnvVars: ["TEMPORAL_POSTGRES_HOST", "TEMPORAL_POSTGRES_PASSWORD"],
      requiredSecretKeys: ["opengeni-temporal-postgres/password"],
      installCommands: [
        "helm repo add temporal https://go.temporal.io/helm-charts",
        "helm repo update temporal",
        "kubectl create namespace opengeni-platform --dry-run=client -o yaml | kubectl apply -f -",
        `mkdir -p .agent/generated/${contract.profile}`,
        ...temporalTlsPrepCommands,
        temporalValuesCommand,
        'kubectl -n opengeni-platform create secret generic opengeni-temporal-postgres --from-literal=password="$TEMPORAL_POSTGRES_PASSWORD" --dry-run=client -o yaml | kubectl apply -f -',
        `helm upgrade --install opengeni-temporal temporal/temporal --version 1.2.0 --namespace opengeni-platform --values .agent/generated/${contract.profile}/official-temporal-postgres.values.yaml`,
        "kubectl -n opengeni-platform delete job opengeni-temporal-register-default-namespace --ignore-not-found",
        "kubectl apply -f deploy/stacks/official-temporal-namespace-job.yaml",
        "kubectl -n opengeni-platform wait --for=condition=complete job/opengeni-temporal-register-default-namespace --timeout=180s",
        "kubectl apply -f deploy/stacks/opengeni-platform-networkpolicies.yaml",
      ],
      verifyCommands: [
        "kubectl -n opengeni-platform rollout status deployment/opengeni-temporal-frontend --timeout=300s",
        "kubectl -n opengeni-platform exec deploy/opengeni-temporal-admintools -- temporal operator namespace describe default --address opengeni-temporal-frontend:7233",
        "kubectl -n opengeni-platform get svc opengeni-temporal-frontend",
        "helm test opengeni-temporal --namespace opengeni-platform --timeout 300s",
      ],
      destroyCommands: [
        "helm uninstall opengeni-temporal --namespace opengeni-platform --ignore-not-found",
      ],
      notes: [
        "The official Temporal chart is lifecycle-managed by the stack wrapper, not by the OpenGeni app chart.",
        "The example values require an existing Postgres database/schema pair for Temporal persistence; use managed cloud Postgres or a customer database, not the OpenGeni chart's disposable Postgres fixture.",
      ],
    });
  }
  if (contract.sandbox.backend === "opensandbox") {
    const opensandboxNamespace = "opensandbox-system";
    const dataplaneNamespace = "opensandbox";
    const generatedDir = `.agent/generated/${contract.profile}/opensandbox`;
    const chartArchive = `${generatedDir}/opensandbox-0.2.0.tgz`;
    const batchSandboxTemplate =
      contract.runtime.cloud === "azure"
        ? "deploy/stacks/opensandbox-batchsandbox-template.azure.yaml"
        : "deploy/stacks/opensandbox-batchsandbox-template.yaml";
    out.push({
      id: "opensandbox",
      lifecycle: "officialChart",
      namespace: opensandboxNamespace,
      releaseName: "opensandbox",
      chartRepoName: null,
      chartRepoUrl: null,
      chartName: "opensandbox-group/OpenSandbox@88004c989e334ffd7811acbe193cddcd9014f14e",
      valuesFile: "deploy/stacks/official-opensandbox.values.yaml",
      runtimeEnv: {
        OPENGENI_OPENSANDBOX_BASE_URL:
          "http://opensandbox-server.opensandbox-system.svc.cluster.local",
      },
      requiredEnvVars: ["OPENGENI_OPENSANDBOX_API_KEY", "OPENGENI_OPENSANDBOX_IMAGE"],
      requiredSecretKeys: ["opensandbox-api-key/api-key"],
      installCommands: [
        `mkdir -p ${generatedDir}`,
        `scripts/operator/prepare-opensandbox-chart.sh ${generatedDir}`,
        `kubectl create namespace ${opensandboxNamespace} --dry-run=client -o yaml | kubectl apply -f -`,
        `kubectl create namespace ${dataplaneNamespace} --dry-run=client -o yaml | kubectl apply -f -`,
        `kubectl -n ${opensandboxNamespace} create secret generic opensandbox-api-key --from-literal=api-key="$OPENGENI_OPENSANDBOX_API_KEY" --dry-run=client -o yaml | kubectl apply -f -`,
        `scripts/operator/ensure-opensandbox-secure-access-secret.sh ${opensandboxNamespace} opensandbox-secure-access`,
        `kubectl -n ${opensandboxNamespace} create configmap opensandbox-secure-access-runtime-config --from-file=materialize-secure-access-config.py=scripts/operator/opensandbox-materialize-secure-access-config.py --dry-run=client -o yaml | kubectl apply -f -`,
        `kubectl apply -f ${batchSandboxTemplate}`,
        "kubectl apply -f deploy/stacks/opensandbox-controller-metrics-service.yaml",
        `helm upgrade --install opensandbox ${chartArchive} --namespace ${opensandboxNamespace} --values deploy/stacks/official-opensandbox.values.yaml --post-renderer scripts/operator/opensandbox-image-post-renderer.sh --wait --timeout 15m`,
      ],
      verifyCommands: [
        `helm lint ${chartArchive} --values deploy/stacks/official-opensandbox.values.yaml`,
        `kubectl -n ${opensandboxNamespace} rollout status deployment/opensandbox-controller-manager --timeout=300s`,
        `kubectl -n ${opensandboxNamespace} rollout status deployment/opensandbox-server --timeout=300s`,
        `kubectl -n ${opensandboxNamespace} get svc opensandbox-server -o jsonpath='{.spec.type}' | grep -qx ClusterIP`,
        `kubectl -n ${opensandboxNamespace} get svc opensandbox-ingress-gateway -o jsonpath='{.spec.type}' | grep -qx ClusterIP`,
        `kubectl -n ${opensandboxNamespace} rollout status deployment/opensandbox-ingress-gateway --timeout=300s`,
        `kubectl -n ${opensandboxNamespace} get secret opensandbox-secure-access -o jsonpath='{.data.active-key}' | grep -q .`,
        `kubectl -n ${opensandboxNamespace} get configmap opensandbox-secure-access-runtime-config -o go-template='{{index .data "materialize-secure-access-config.py"}}' | grep -q materialize`,
        `kubectl -n ${opensandboxNamespace} get svc opensandbox-controller-metrics -o jsonpath='{.spec.type}' | grep -qx ClusterIP`,
        `kubectl -n ${opensandboxNamespace} get secret opensandbox-api-key -o jsonpath='{.data.api-key}' | grep -q .`,
        `kubectl get crd batchsandboxes.sandbox.opensandbox.io pools.sandbox.opensandbox.io sandboxsnapshots.sandbox.opensandbox.io`,
      ],
      destroyCommands: [
        `kubectl -n ${dataplaneNamespace} delete batchsandboxes.sandbox.opensandbox.io,pools.sandbox.opensandbox.io --all --ignore-not-found --wait=true --timeout=15m`,
        `helm uninstall opensandbox --namespace ${opensandboxNamespace} --ignore-not-found`,
        `kubectl delete namespace ${dataplaneNamespace} ${opensandboxNamespace} --ignore-not-found --wait=true --timeout=15m`,
        "kubectl delete crd batchsandboxes.sandbox.opensandbox.io pools.sandbox.opensandbox.io sandboxsnapshots.sandbox.opensandbox.io --ignore-not-found",
      ],
      notes: [
        "OpenSandbox is lifecycle-managed from the exact upstream source commit and checksums in deploy/stacks/opensandbox-source.lock; its templates are not copied into the OpenGeni app chart.",
        "The lifecycle service is ClusterIP-only and its lifecycle routes are API-key authenticated. Exec and files stay on that private server-proxy. Channel B (browserd, noVNC, ttyd) uses the ClusterIP ingress gateway in URI mode with OSEP-0011 signed endpoints; put a TLS terminator in front of that ClusterIP in production rather than forking the upstream Service to LoadBalancer.",
        "Official server v0.2.2 ignores OPENSANDBOX_SECURE_ACCESS_* env. The image post-renderer adds an initContainer that materializes [ingress.secure_access] into a writable runtime TOML from Secret opensandbox-secure-access so keys never enter git or the server ConfigMap. Helm 4 cannot pass a script to --post-renderer; use helm template | scripts/operator/opensandbox-image-post-renderer.sh | kubectl apply -f -.",
        contract.runtime.cloud === "azure"
          ? "The Azure BatchSandbox template requires the optional Terraform sandbox node pool label and taint contract."
          : "The generic BatchSandbox template has no cloud-specific node selector and works on ordinary Kubernetes or k3s nodes.",
        "Native OpenSandbox snapshots remain disabled; OpenGeni portable workspace archives in object storage are authoritative in v1.",
      ],
    });
  }
  return out;
}

function usesOfficialPlatformChart(
  contract: DeploymentContract,
  id: PlatformDependencyPlan["id"],
): boolean {
  return platformDependencyPlans(contract).some(
    (dependency) => dependency.id === id && dependency.lifecycle === "officialChart",
  );
}

function planNotes(
  contract: DeploymentContract,
  env: Record<string, string | undefined>,
): string[] {
  const notes = [
    "Keep provider resource names, generated credentials, kubeconfigs, Terraform state, and filled tfvars in private operator-controlled storage outside the repository.",
    "Use the generated destroy commands as the baseline cleanup path for environments created from this plan.",
  ];
  if (contract.access.mode === "sharedKey") {
    notes.push(
      "Generate OPENGENI_ACCESS_KEY outside source control and provide it through the runtime secret path.",
    );
  }
  if (contract.nats.mode === "external") {
    notes.push(
      "NATS is intentionally outside the OpenGeni app chart; use an existing endpoint or the official NATS Helm chart.",
    );
  }
  if (contract.temporal.mode === "external") {
    notes.push(
      "Temporal is intentionally outside the OpenGeni app chart; use Temporal Cloud, an existing endpoint, or the official Temporal Helm chart.",
    );
  }
  if (contract.sandbox.backend === "opensandbox") {
    notes.push(
      "OpenSandbox is optional and planned only because this deployment explicitly selects sandbox.backend=opensandbox; the default Modal and other backend plans are unchanged.",
    );
  }
  if (contract.profile === "single-node-kubernetes") {
    notes.push(
      "This profile is one persistent machine with no service redundancy; Kubernetes owns restart, volume, and upgrade sequencing only.",
      "Bind NodePorts to loopback and expose only the documented edge ports through the private network boundary.",
      "Create the runtime, migration, Postgres, and Garage Secrets (env keys plus garage.toml) before the two-phase Helm bootstrap.",
    );
  }
  if (requestedMaintenanceCutover(env)) {
    notes.push(
      `This plan includes the explicit ${MODEL_CATALOG_MAINTENANCE_CUTOVER} application drain; keep the application stopped until migration 0383 and the final exact-digest upgrade succeed.`,
    );
  }
  return notes;
}

function secretLikeRuntimeEnv(name: string): boolean {
  return (
    name.includes("KEY") ||
    name.includes("SECRET") ||
    name.includes("TOKEN") ||
    name.includes("PASSWORD") ||
    name.includes("SEED") ||
    name.includes("CONNECTION_STRING") ||
    name === "OPENGENI_DATABASE_URL"
  );
}

function runtimeDatabaseUrlRequired(contract: DeploymentContract): boolean {
  return (
    contract.database.mode !== "inCluster" ||
    contract.profile === "single-node-kubernetes" ||
    contract.profile.startsWith("preview")
  );
}

function profileRequiredSecretKeys(contract: DeploymentContract): string[] {
  if (contract.profile !== "single-node-kubernetes") {
    return [];
  }
  return [
    "opengeni-postgres/POSTGRES_PASSWORD",
    "opengeni-garage/GARAGE_ACCESS_KEY_ID",
    "opengeni-garage/GARAGE_SECRET_ACCESS_KEY",
    "opengeni-garage/GARAGE_RPC_SECRET",
    "opengeni-garage/garage.toml",
    "opengeni-runtime/OPENGENI_DATABASE_URL",
    "opengeni-runtime/OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    "opengeni-migrations/OPENGENI_MIGRATIONS_DATABASE_URL",
    "opengeni-migrations/OPENGENI_APP_DATABASE_USER",
    "opengeni-migrations/OPENGENI_APP_DATABASE_PASSWORD",
  ];
}

function runtimeEnvFileValue(value: string | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n");
}

function compactBase64Env(value: string | undefined): string | undefined {
  return value?.replace(/\s/g, "");
}

function check(id: PreflightCheckId, required: boolean, description: string): PreflightCheck {
  return { id, required, description };
}

function requireModeReference(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  mode: DependencyMode,
  external: ExternalServiceRef | undefined,
  managed: ManagedServiceRef | undefined,
): void {
  if (mode === "external" && !external) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "external"],
      message: "external mode requires an external service reference",
    });
  }
  if (mode === "managed" && !managed) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "managed"],
      message: "managed mode requires a managed service reference",
    });
  }
}

interface RuntimeEnvEntry {
  key: string;
  value: string | undefined;
  required: boolean;
  fromSensitiveTerraformOutput?: string;
}

function runtimeEnvValues(
  contract: DeploymentContract,
  terraformOutputs: TerraformOutputs,
  env: Record<string, string | undefined>,
): RuntimeEnvEntry[] {
  const publicBaseUrl = env.OPENGENI_PUBLIC_BASE_URL ?? contract.product.publicBaseUrl;
  const entries: RuntimeEnvEntry[] = [
    envOrRequiredRuntime(
      "OPENGENI_DATABASE_URL",
      env.OPENGENI_DATABASE_URL,
      runtimeDatabaseUrlRequired(contract),
    ),
    valueEnv("OPENGENI_AUTH_REQUIRED", String(contract.access.mode === "sharedKey")),
    ...(contract.access.mode === "sharedKey"
      ? [requiredEnv("OPENGENI_ACCESS_KEY", env.OPENGENI_ACCESS_KEY)]
      : []),
    valueEnv("OPENGENI_AUTH_ALLOW_HEALTH", String(contract.access.allowUnauthenticatedHealth)),
    valueEnv("OPENGENI_AUTH_ALLOW_METRICS", String(contract.access.allowUnauthenticatedMetrics)),
    valueEnv(
      "OPENGENI_DEPLOYMENT_REVISION",
      env.OPENGENI_DEPLOYMENT_REVISION ?? env.OPENGENI_IMAGE_TAG ?? "latest",
    ),
    valueEnv("OPENGENI_PRODUCT_ACCESS_MODE", contract.product.accessMode),
    valueEnv("OPENGENI_BILLING_MODE", contract.product.billingMode),
    valueEnv("OPENGENI_ENTITLEMENTS_MODE", contract.product.entitlementsMode),
    valueEnv("OPENGENI_USAGE_LIMITS_MODE", contract.product.usageLimitsMode),
    valueEnv("OPENGENI_ANALYTICS_ENABLED", env.OPENGENI_ANALYTICS_ENABLED),
    valueEnv("OPENGENI_ANALYTICS_CONSENT_REQUIRED", env.OPENGENI_ANALYTICS_CONSENT_REQUIRED),
    valueEnv("OPENGENI_ANALYTICS_REO_CLIENT_ID", env.OPENGENI_ANALYTICS_REO_CLIENT_ID),
    valueEnv("OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY", env.OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY),
    valueEnv("OPENGENI_ANALYTICS_POSTHOG_HOST", env.OPENGENI_ANALYTICS_POSTHOG_HOST),
    valueEnv("OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID", env.OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID),
    valueEnv("OPENGENI_INTEGRATIONS_ENABLED", env.OPENGENI_INTEGRATIONS_ENABLED),
    valueEnv("OPENGENI_INTEGRATIONS_STATE_SECRET", env.OPENGENI_INTEGRATIONS_STATE_SECRET),
    valueEnv("OPENGENI_SLACK_CLIENT_ID", env.OPENGENI_SLACK_CLIENT_ID),
    valueEnv("OPENGENI_SLACK_CLIENT_SECRET", env.OPENGENI_SLACK_CLIENT_SECRET),
    valueEnv("OPENGENI_SLACK_SIGNING_SECRET", env.OPENGENI_SLACK_SIGNING_SECRET),
    valueEnv("OPENGENI_SLACK_BOT_DISPLAY_NAME", env.OPENGENI_SLACK_BOT_DISPLAY_NAME),
    valueEnv("OPENGENI_SLACK_COMMAND", env.OPENGENI_SLACK_COMMAND),
    valueEnv("OPENGENI_PR_REVIEW_GITHUB_APP_ID", env.OPENGENI_PR_REVIEW_GITHUB_APP_ID),
    valueEnv("OPENGENI_PR_REVIEW_GITHUB_CLIENT_ID", env.OPENGENI_PR_REVIEW_GITHUB_CLIENT_ID),
    valueEnv(
      "OPENGENI_PR_REVIEW_GITHUB_CLIENT_SECRET",
      env.OPENGENI_PR_REVIEW_GITHUB_CLIENT_SECRET,
    ),
    valueEnv("OPENGENI_PR_REVIEW_GITHUB_APP_SLUG", env.OPENGENI_PR_REVIEW_GITHUB_APP_SLUG),
    valueEnv(
      "OPENGENI_PR_REVIEW_GITHUB_WEBHOOK_SECRET",
      env.OPENGENI_PR_REVIEW_GITHUB_WEBHOOK_SECRET,
    ),
    valueEnv(
      "OPENGENI_PR_REVIEW_GITHUB_APP_PRIVATE_KEY",
      env.OPENGENI_PR_REVIEW_GITHUB_APP_PRIVATE_KEY,
    ),
    ...(contract.product.accessMode !== "managed" && env.OPENGENI_PR_REVIEW_GITHUB_APP_ID
      ? [
          requiredEnv(
            "OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET",
            env.OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET,
          ),
          requiredEnv(
            "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
            env.OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY,
          ),
        ]
      : []),
    ...(publicBaseUrl ? [valueEnv("OPENGENI_PUBLIC_BASE_URL", publicBaseUrl)] : []),
    ...(contract.product.accessMode === "managed" ||
    (contract.product.accessMode === "configured" && contract.access.mode !== "sharedKey")
      ? [requiredEnv("OPENGENI_DELEGATION_SECRET", env.OPENGENI_DELEGATION_SECRET)]
      : []),
    valueEnv("OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS", env.OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS),
    valueEnv("OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS", env.OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS),
    ...(contract.product.accessMode === "managed"
      ? [
          requiredEnv("OPENGENI_BETTER_AUTH_SECRET", env.OPENGENI_BETTER_AUTH_SECRET),
          valueEnv(
            "OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS",
            env.OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS ?? publicBaseUrl ?? "",
          ),
          valueEnv("OPENGENI_BETTER_AUTH_ALLOWED_HOSTS", env.OPENGENI_BETTER_AUTH_ALLOWED_HOSTS),
          valueEnv("OPENGENI_BETTER_AUTH_COOKIE_DOMAIN", env.OPENGENI_BETTER_AUTH_COOKIE_DOMAIN),
          valueEnv(
            "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID",
            env.OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID,
          ),
          valueEnv(
            "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET",
            env.OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET,
          ),
          valueEnv(
            "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID",
            env.OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID,
          ),
          valueEnv(
            "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET",
            env.OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET,
          ),
          requiredEnv(
            "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
            env.OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY,
          ),
          requiredEnv("OPENGENI_RESEND_API_KEY", env.OPENGENI_RESEND_API_KEY),
          valueEnv(
            "OPENGENI_EMAIL_FROM",
            env.OPENGENI_EMAIL_FROM ?? "OpenGeni <auth@mail.opengeni.ai>",
          ),
          valueEnv(
            "OPENGENI_GITHUB_APP_MANIFEST_BASE_URL",
            env.OPENGENI_GITHUB_APP_MANIFEST_BASE_URL ?? publicBaseUrl,
          ),
          requiredEnv(
            "OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET",
            env.OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET,
          ),
          requiredEnv("OPENGENI_GITHUB_APP_ID", env.OPENGENI_GITHUB_APP_ID),
          requiredEnv("OPENGENI_GITHUB_CLIENT_ID", env.OPENGENI_GITHUB_CLIENT_ID),
          requiredEnv("OPENGENI_GITHUB_CLIENT_SECRET", env.OPENGENI_GITHUB_CLIENT_SECRET),
          requiredEnv("OPENGENI_GITHUB_APP_SLUG", env.OPENGENI_GITHUB_APP_SLUG),
          requiredEnv("OPENGENI_GITHUB_APP_PRIVATE_KEY", env.OPENGENI_GITHUB_APP_PRIVATE_KEY),
          valueEnv("OPENGENI_GITHUB_REST_MCP_ENABLED", env.OPENGENI_GITHUB_REST_MCP_ENABLED),
          valueEnv(
            "OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED",
            env.OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED,
          ),
          valueEnv(
            "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID",
            env.OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID,
          ),
          valueEnv(
            "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET",
            env.OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET,
          ),
        ]
      : []),
    ...(contract.product.billingMode === "stripe"
      ? [
          requiredEnv("OPENGENI_STRIPE_SECRET_KEY", env.OPENGENI_STRIPE_SECRET_KEY),
          requiredEnv("OPENGENI_STRIPE_PUBLISHABLE_KEY", env.OPENGENI_STRIPE_PUBLISHABLE_KEY),
          requiredEnv("OPENGENI_STRIPE_WEBHOOK_SECRET", env.OPENGENI_STRIPE_WEBHOOK_SECRET),
          requiredEnv("OPENGENI_STRIPE_CREDITS_PRODUCT_ID", env.OPENGENI_STRIPE_CREDITS_PRODUCT_ID),
          requiredEnv("OPENGENI_MODEL_PRICING_JSON", env.OPENGENI_MODEL_PRICING_JSON),
        ]
      : []),
    ...(contract.product.entitlementsMode === "static"
      ? [requiredEnv("OPENGENI_STATIC_ENTITLEMENTS_JSON", env.OPENGENI_STATIC_ENTITLEMENTS_JSON)]
      : []),
    ...(contract.product.usageLimitsMode === "static"
      ? [requiredEnv("OPENGENI_STATIC_USAGE_LIMITS_JSON", env.OPENGENI_STATIC_USAGE_LIMITS_JSON)]
      : []),
    envOrRequiredRuntime(
      "OPENGENI_TEMPORAL_HOST",
      terraformOutputString(terraformOutputs, "temporal_host") ??
        platformRuntimeEnv(contract, "OPENGENI_TEMPORAL_HOST") ??
        env.OPENGENI_TEMPORAL_HOST,
      contract.temporal.mode !== "inCluster" && !usesOfficialPlatformChart(contract, "temporal"),
    ),
    valueEnv(
      "OPENGENI_TEMPORAL_NAMESPACE",
      terraformOutputString(terraformOutputs, "temporal_namespace") ?? contract.temporal.namespace,
    ),
    valueEnv(
      "OPENGENI_TEMPORAL_TASK_QUEUE",
      terraformOutputString(terraformOutputs, "temporal_task_queue") ?? contract.temporal.taskQueue,
    ),
    valueEnv("OPENGENI_TEMPORAL_TLS_ENABLED", env.OPENGENI_TEMPORAL_TLS_ENABLED ?? "false"),
    valueEnv("OPENGENI_TEMPORAL_API_KEY", env.OPENGENI_TEMPORAL_API_KEY),
    valueEnv("OPENGENI_TEMPORAL_TLS_SERVER_NAME", env.OPENGENI_TEMPORAL_TLS_SERVER_NAME),
    valueEnv(
      "OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64",
      compactBase64Env(env.OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64),
    ),
    valueEnv(
      "OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64",
      compactBase64Env(env.OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64),
    ),
    valueEnv(
      "OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64",
      compactBase64Env(env.OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64),
    ),
    envOrRequiredRuntime(
      "OPENGENI_NATS_URL",
      platformRuntimeEnv(contract, "OPENGENI_NATS_URL") ?? env.OPENGENI_NATS_URL,
      contract.nats.mode !== "inCluster" && !usesOfficialPlatformChart(contract, "nats"),
    ),
    valueEnv("OPENGENI_API_HOST", "0.0.0.0"),
    valueEnv("OPENGENI_API_PORT", "8000"),
    valueEnv("OPENGENI_SANDBOX_BACKEND", contract.sandbox.backend),
    valueEnv(
      "OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED",
      env.OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED ?? "false",
    ),
    valueEnv("OPENGENI_OPENAI_PROVIDER", inferredOpenAiProvider(env)),
    valueEnv(
      "OPENGENI_OPENAI_MODEL",
      env.OPENGENI_OPENAI_MODEL ?? env.OPENGENI_AZURE_OPENAI_DEPLOYMENT ?? "gpt-5.6-sol",
    ),
    valueEnv(
      "OPENGENI_OPENAI_ALLOWED_MODELS",
      env.OPENGENI_OPENAI_ALLOWED_MODELS ??
        env.OPENGENI_OPENAI_MODEL ??
        env.OPENGENI_AZURE_OPENAI_DEPLOYMENT ??
        "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna",
    ),
    valueEnv("OPENGENI_OPENAI_REASONING_EFFORT", env.OPENGENI_OPENAI_REASONING_EFFORT ?? "low"),
    valueEnv(
      "OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS",
      env.OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS ?? "low,medium,high,xhigh,max",
    ),
    valueEnv("OPENGENI_MODEL_CATALOG_SOURCE", env.OPENGENI_MODEL_CATALOG_SOURCE),
    valueEnv("OPENGENI_MODEL_COST_POLICY_JSON", env.OPENGENI_MODEL_COST_POLICY_JSON),
    valueEnv("OPENGENI_MODEL_NOTES_JSON", env.OPENGENI_MODEL_NOTES_JSON),
    ...(inferredOpenAiProvider(env) === "azure"
      ? [
          env.OPENGENI_AZURE_OPENAI_BASE_URL
            ? requiredEnv("OPENGENI_AZURE_OPENAI_BASE_URL", env.OPENGENI_AZURE_OPENAI_BASE_URL)
            : requiredEnv("OPENGENI_AZURE_OPENAI_ENDPOINT", env.OPENGENI_AZURE_OPENAI_ENDPOINT),
          ...(env.OPENGENI_AZURE_OPENAI_BASE_URL && env.OPENGENI_AZURE_OPENAI_ENDPOINT
            ? [valueEnv("OPENGENI_AZURE_OPENAI_ENDPOINT", env.OPENGENI_AZURE_OPENAI_ENDPOINT)]
            : []),
          requiredEnv("OPENGENI_AZURE_OPENAI_DEPLOYMENT", env.OPENGENI_AZURE_OPENAI_DEPLOYMENT),
          ...(azureOpenAIApiVersionRequired(env)
            ? [
                requiredEnv(
                  "OPENGENI_AZURE_OPENAI_API_VERSION",
                  env.OPENGENI_AZURE_OPENAI_API_VERSION,
                ),
              ]
            : []),
          requiredEnv("OPENGENI_AZURE_OPENAI_API_KEY", env.OPENGENI_AZURE_OPENAI_API_KEY),
        ]
      : [requiredEnv("OPENGENI_OPENAI_API_KEY", env.OPENGENI_OPENAI_API_KEY)]),
    ...(env.OPENGENI_VERCEL_AI_GATEWAY_API_KEY
      ? [requiredEnv("OPENGENI_VERCEL_AI_GATEWAY_API_KEY", env.OPENGENI_VERCEL_AI_GATEWAY_API_KEY)]
      : []),
    ...(env.OPENGENI_OPENROUTER_API_KEY
      ? [requiredEnv("OPENGENI_OPENROUTER_API_KEY", env.OPENGENI_OPENROUTER_API_KEY)]
      : []),
  ];

  if (contract.objectStorage.api === "azure-blob") {
    const output = terraformOutputs.object_storage_azure_connection_string;
    const connectionStringEntry: RuntimeEnvEntry = {
      key: "OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING",
      value:
        env.OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING ??
        terraformOutputString(terraformOutputs, "object_storage_azure_connection_string"),
      required: true,
    };
    if (output?.sensitive) {
      connectionStringEntry.fromSensitiveTerraformOutput = "object_storage_azure_connection_string";
    }
    entries.push(
      valueEnv("OPENGENI_OBJECT_STORAGE_BACKEND", "azure-blob"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_BUCKET",
        terraformOutputString(terraformOutputs, "object_storage_bucket") ??
          contract.objectStorage.bucket,
      ),
      connectionStringEntry,
    );
  } else if (contract.objectStorage.api === "aws-s3") {
    entries.push(
      valueEnv("OPENGENI_OBJECT_STORAGE_BACKEND", "aws-s3"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_BUCKET",
        terraformOutputString(terraformOutputs, "object_storage_bucket") ??
          contract.objectStorage.bucket,
      ),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_REGION",
        terraformOutputString(terraformOutputs, "region") ??
          contract.runtime.region ??
          env.AWS_REGION ??
          "us-east-1",
      ),
      valueEnv("OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE", "false"),
    );
  } else if (contract.objectStorage.api === "gcs") {
    entries.push(
      valueEnv("OPENGENI_OBJECT_STORAGE_BACKEND", "gcs"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_BUCKET",
        terraformOutputString(terraformOutputs, "object_storage_bucket") ??
          contract.objectStorage.bucket,
      ),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID",
        terraformOutputString(terraformOutputs, "project_id") ?? env.GOOGLE_CLOUD_PROJECT,
      ),
    );
  } else if (contract.objectStorage.mode === "inCluster") {
    entries.push(
      valueEnv("OPENGENI_OBJECT_STORAGE_BACKEND", "s3-compatible"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_BUCKET",
        terraformOutputString(terraformOutputs, "object_storage_bucket") ??
          contract.objectStorage.bucket,
      ),
      valueEnv("OPENGENI_OBJECT_STORAGE_REGION", env.OPENGENI_OBJECT_STORAGE_REGION ?? "us-east-1"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_S3_PROVIDER",
        env.OPENGENI_OBJECT_STORAGE_S3_PROVIDER ?? "S3Compatible",
      ),
    );
  } else {
    entries.push(
      valueEnv("OPENGENI_OBJECT_STORAGE_BACKEND", "s3-compatible"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_BUCKET",
        terraformOutputString(terraformOutputs, "object_storage_bucket") ??
          contract.objectStorage.bucket,
      ),
      requiredEnv("OPENGENI_OBJECT_STORAGE_ENDPOINT", env.OPENGENI_OBJECT_STORAGE_ENDPOINT),
      requiredEnv(
        "OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID",
        env.OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID,
      ),
      requiredEnv(
        "OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY",
        env.OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY,
      ),
      valueEnv("OPENGENI_OBJECT_STORAGE_REGION", env.OPENGENI_OBJECT_STORAGE_REGION ?? "us-east-1"),
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_S3_PROVIDER",
        env.OPENGENI_OBJECT_STORAGE_S3_PROVIDER ?? "S3Compatible",
      ),
    );
  }
  if (
    (contract.objectStorage.api === "s3-compatible" || contract.objectStorage.api === "aws-s3") &&
    env.OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT
  ) {
    entries.push(
      valueEnv(
        "OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT",
        env.OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT,
      ),
    );
  }

  // Backend-gated sandbox env render (table-driven; replaces the single
  // modal-if). The active backend's required creds become requiredEnv (a
  // missing one surfaces in missingEnvVars); its optional passthroughs become
  // valueEnv (emitted only when set). Inactive backends contribute nothing, so
  // a daytona deployment never demands Modal creds and vice versa.
  const sandboxEnv = SANDBOX_REQUIRED_ENV[contract.sandbox.backend];
  for (const key of sandboxEnv.required) {
    entries.push(requiredEnv(key, platformRuntimeEnv(contract, key) ?? env[key]));
  }
  for (const key of sandboxEnv.optional) {
    entries.push(valueEnv(key, env[key]));
  }
  if (contract.sandbox.backend === "selfhosted") {
    for (const key of SELFHOSTED_CONTROL_PLANE_REQUIRED_ENV) {
      entries.push(requiredEnv(key, env[key]));
    }
  }

  // sandbox workspace passthroughs (the desktop/Channel-A feature rollout). These are
  // recognized runtime env vars so a surfacing-enabled deployment carries them
  // into runtime.env, but they are valueEnv passthroughs (emitted only when set,
  // never forced into missingEnvVars): OPENGENI_STREAM_TOKEN_SECRET gracefully
  // falls back to OPENGENI_DELEGATION_SECRET when unset (config's
  // resolveStreamTokenSecret), and the rollout flags default off in
  // @opengeni/config. Explicit rollout values are carried by the generated
  // runtime Secret, whose later envFrom position makes it authoritative over
  // any non-production example ConfigMap value.
  for (const key of SANDBOX_SURFACING_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of SANDBOX_LIFECYCLE_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of WORKSPACE_CONTROL_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of SLACK_WORKSPACE_ROUTING_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of WORK_DISCOVERY_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }
  for (const key of EXTERNAL_BROWSER_PROVIDER_PASSTHROUGH_ENV) {
    entries.push(valueEnv(key, env[key]));
  }

  return dedupeRuntimeEnv(entries);
}

function inferredOpenAiProvider(env: Record<string, string | undefined>): "openai" | "azure" {
  if (env.OPENGENI_OPENAI_PROVIDER === "openai" || env.OPENGENI_OPENAI_PROVIDER === "azure") {
    return env.OPENGENI_OPENAI_PROVIDER;
  }
  if (
    env.OPENGENI_AZURE_OPENAI_API_KEY ||
    env.OPENGENI_AZURE_OPENAI_BASE_URL ||
    env.OPENGENI_AZURE_OPENAI_ENDPOINT
  ) {
    return "azure";
  }
  return "openai";
}

function azureOpenAIApiVersionRequired(env: Record<string, string | undefined>): boolean {
  const baseUrl = env.OPENGENI_AZURE_OPENAI_BASE_URL?.replace(/\/+$/, "").toLowerCase();
  return !baseUrl || !baseUrl.endsWith("/openai/v1");
}

function platformRuntimeEnv(contract: DeploymentContract, key: string): string | undefined {
  for (const dependency of platformDependencyPlans(contract)) {
    const value = dependency.runtimeEnv[key];
    if (value) return value;
  }
  return undefined;
}

function requiredEnv(key: string, value: string | undefined): RuntimeEnvEntry {
  return { key, value: nonEmpty(value), required: true };
}

function valueEnv(key: string, value: string | undefined): RuntimeEnvEntry {
  return { key, value: nonEmpty(value), required: false };
}

function envOrRequiredRuntime(
  key: string,
  value: string | undefined,
  required: boolean,
): RuntimeEnvEntry {
  return required ? requiredEnv(key, value) : valueEnv(key, value);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const resolved = nonEmpty(value);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function dedupeRuntimeEnv(entries: RuntimeEnvEntry[]): RuntimeEnvEntry[] {
  const byKey = new Map<string, RuntimeEnvEntry>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    if (!existing) {
      byKey.set(entry.key, entry);
      continue;
    }
    byKey.set(entry.key, {
      ...existing,
      value: existing.value || entry.value,
      required: existing.required || entry.required,
      ...(existing.fromSensitiveTerraformOutput || entry.fromSensitiveTerraformOutput
        ? {
            fromSensitiveTerraformOutput:
              existing.fromSensitiveTerraformOutput ?? entry.fromSensitiveTerraformOutput,
          }
        : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function terraformOutputString(outputs: TerraformOutputs, name: string): string | undefined {
  const value = outputs[name]?.value;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function terraformOutputObject(outputs: TerraformOutputs, name: string): Record<string, string> {
  const value = outputs[name]?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim().length > 0) {
      out[key] = item;
    }
  }
  return out;
}

function addGeneratedImageValues(
  values: Record<string, string>,
  tag: string,
  env: Record<string, string | undefined>,
): void {
  const digests: Record<string, string | undefined> = {
    api: env.OPENGENI_API_IMAGE_DIGEST,
    worker: env.OPENGENI_WORKER_IMAGE_DIGEST,
    web: env.OPENGENI_WEB_IMAGE_DIGEST,
    migrations: env.OPENGENI_MIGRATIONS_IMAGE_DIGEST ?? env.OPENGENI_API_IMAGE_DIGEST,
  };
  for (const component of ["api", "worker", "web", "migrations"]) {
    values[`${component}.image.tag`] = tag;
    values[`${component}.image.digest`] = digests[component] ?? "";
  }
}

function addRuntimeConfigHelmValues(
  values: Record<string, string>,
  contract: DeploymentContract,
  env: Record<string, string | undefined>,
): void {
  const publicBaseUrl = env.OPENGENI_PUBLIC_BASE_URL ?? contract.product.publicBaseUrl;
  values["config.OPENGENI_AUTH_REQUIRED"] = String(contract.access.mode === "sharedKey");
  values["config.OPENGENI_AUTH_ALLOW_HEALTH"] = String(contract.access.allowUnauthenticatedHealth);
  values["config.OPENGENI_AUTH_ALLOW_METRICS"] = String(
    contract.access.allowUnauthenticatedMetrics,
  );
  values["config.OPENGENI_ENVIRONMENT"] = env.OPENGENI_ENVIRONMENT ?? contract.profile;
  values["config.OPENGENI_DEPLOYMENT_REVISION"] =
    env.OPENGENI_DEPLOYMENT_REVISION ?? env.OPENGENI_IMAGE_TAG ?? "latest";
  values["config.OPENGENI_PRODUCT_ACCESS_MODE"] = contract.product.accessMode;
  values["config.OPENGENI_BILLING_MODE"] = contract.product.billingMode;
  values["config.OPENGENI_ENTITLEMENTS_MODE"] = contract.product.entitlementsMode;
  values["config.OPENGENI_USAGE_LIMITS_MODE"] = contract.product.usageLimitsMode;
  values["config.OPENGENI_API_HOST"] = "0.0.0.0";
  values["config.OPENGENI_API_PORT"] = "8000";
  values["config.OPENGENI_TEMPORAL_NAMESPACE"] = contract.temporal.namespace;
  values["config.OPENGENI_TEMPORAL_TASK_QUEUE"] = contract.temporal.taskQueue;
  values["config.OPENGENI_SANDBOX_BACKEND"] = contract.sandbox.backend;
  values["config.OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED"] =
    env.OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED ?? "false";
  values["config.OPENGENI_OPENAI_PROVIDER"] = inferredOpenAiProvider(env);
  values["config.OPENGENI_OPENAI_MODEL"] =
    env.OPENGENI_OPENAI_MODEL ?? env.OPENGENI_AZURE_OPENAI_DEPLOYMENT ?? "gpt-5.6-sol";
  values["config.OPENGENI_OPENAI_ALLOWED_MODELS"] =
    env.OPENGENI_OPENAI_ALLOWED_MODELS ??
    env.OPENGENI_OPENAI_MODEL ??
    env.OPENGENI_AZURE_OPENAI_DEPLOYMENT ??
    "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna";
  values["config.OPENGENI_OPENAI_REASONING_EFFORT"] = env.OPENGENI_OPENAI_REASONING_EFFORT ?? "low";
  values["config.OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS"] =
    env.OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS ?? "low,medium,high,xhigh,max";
  for (const key of [
    "OPENGENI_ANALYTICS_ENABLED",
    "OPENGENI_ANALYTICS_CONSENT_REQUIRED",
    "OPENGENI_ANALYTICS_REO_CLIENT_ID",
    "OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY",
    "OPENGENI_ANALYTICS_POSTHOG_HOST",
    "OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID",
    "OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS",
    "OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS",
  ] as const) {
    const value = env[key];
    if (value) {
      values[`config.${key}`] = value;
    }
  }
  if (publicBaseUrl) {
    values["config.OPENGENI_PUBLIC_BASE_URL"] = publicBaseUrl;
    values["config.OPENGENI_WEB_ALLOWED_HOSTS"] =
      env.OPENGENI_WEB_ALLOWED_HOSTS ?? hostnameForUrl(publicBaseUrl) ?? "";
  }
  if (
    contract.profile.startsWith("preview") &&
    contract.objectStorage.mode === "inCluster" &&
    publicBaseUrl
  ) {
    values["minio.publicEndpoint"] = publicBaseUrl;
  }
  if (runtimeDatabaseUrlRequired(contract)) {
    values["migrations.secret.existingSecret"] =
      env.OPENGENI_MIGRATIONS_SECRET_NAME ?? "opengeni-migrations";
  }
  if (contract.database.mode === "inCluster" && runtimeDatabaseUrlRequired(contract)) {
    values["postgres.runtime.existingSecret"] = "opengeni-runtime";
    values["postgres.runtime.databaseUrlKey"] = "OPENGENI_DATABASE_URL";
  }
}

function hostnameForUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function nestedObjectFromHelmSetValues(values: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    setNestedValue(root, splitHelmSetPath(path), value);
  }
  return root;
}

function splitHelmSetPath(path: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === "\\" && path[index + 1] === ".") {
      current += ".";
      index += 1;
      continue;
    }
    if (char === ".") {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.filter((part) => part.length > 0);
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: string): void {
  let cursor = root;
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    if (!key) {
      continue;
    }
    if (index === path.length - 1) {
      cursor[key] = value;
      return;
    }
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
}

function renderYaml(value: unknown, indent = 0): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${" ".repeat(indent)}${yamlValue(value)}\n`;
  }
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      lines.push(`${" ".repeat(indent)}${key}:\n${renderYaml(item, indent + 2)}`);
    } else {
      lines.push(`${" ".repeat(indent)}${key}: ${yamlValue(item)}\n`);
    }
  }
  return lines.join("");
}

function yamlValue(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return "null";
  return JSON.stringify(value);
}
