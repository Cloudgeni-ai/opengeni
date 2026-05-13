import { z } from "zod";

export const DeploymentProfileId = z.enum([
  "local-compose",
  "local-kubernetes",
  "kubernetes-external",
  "azure-managed",
  "azure-existing-services",
  "self-contained-kubernetes",
]);
export type DeploymentProfileId = z.infer<typeof DeploymentProfileId>;

export const CloudProvider = z.enum(["local", "generic", "azure", "aws", "gcp"]);
export type CloudProvider = z.infer<typeof CloudProvider>;

export const RuntimePlatform = z.enum(["docker-compose", "kubernetes"]);
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;

export const DependencyMode = z.enum(["managed", "external", "inCluster", "disabled"]);
export type DependencyMode = z.infer<typeof DependencyMode>;

export const StorageApi = z.enum(["s3-compatible", "azure-blob"]);
export type StorageApi = z.infer<typeof StorageApi>;

export const SandboxBackend = z.enum(["docker", "modal", "local", "none"]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

export const SecretDeliveryMode = z.enum([
  "envFile",
  "kubernetesSecret",
  "externalSecrets",
  "vault",
  "azureKeyVault",
]);
export type SecretDeliveryMode = z.infer<typeof SecretDeliveryMode>;

export const ObservabilityBackend = z.enum([
  "none",
  "otel",
  "azureMonitor",
  "prometheusGrafana",
  "datadog",
  "honeycomb",
  "customerProvided",
]);
export type ObservabilityBackend = z.infer<typeof ObservabilityBackend>;

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

export const DeploymentContract = z.object({
  profile: DeploymentProfileId,
  runtime: RuntimeSpec,
  database: DatabaseSpec,
  temporal: TemporalSpec,
  nats: NatsSpec,
  objectStorage: ObjectStorageSpec,
  secrets: SecretsSpec,
  ingress: IngressSpec,
  observability: ObservabilitySpec,
  sandbox: SandboxSpec,
  backups: BackupSpec.default({
    postgresRequired: true,
    objectStorageRequired: true,
    restoreDrillRequired: true,
  }),
}).superRefine((contract, ctx) => {
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
  requireModeReference(ctx, ["database"], contract.database.mode, contract.database.external, contract.database.managed);
  requireModeReference(ctx, ["temporal"], contract.temporal.mode, contract.temporal.external, contract.temporal.managed);
  requireModeReference(ctx, ["objectStorage"], contract.objectStorage.mode, contract.objectStorage.external, contract.objectStorage.managed);
  if (contract.nats.mode === "external" && !contract.nats.external) {
    ctx.addIssue({
      code: "custom",
      path: ["nats", "external"],
      message: "external NATS requires an external service reference",
    });
  }
  if (contract.objectStorage.api === "azure-blob" && contract.objectStorage.mode !== "managed" && contract.runtime.cloud !== "azure") {
    ctx.addIssue({
      code: "custom",
      path: ["objectStorage", "api"],
      message: "azure-blob storage is only valid for Azure managed/reference deployments",
    });
  }
});
export type DeploymentContract = z.infer<typeof DeploymentContract>;

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
    observability: { backend: "none", requireTraces: false, requireMetrics: false, requireStructuredLogs: true },
    sandbox: { backend: "docker", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "local-kubernetes": parseDeploymentContract({
    profile: "local-kubernetes",
    runtime: { platform: "kubernetes", cloud: "local", namespace: "opengeni-local", releaseName: "opengeni-local" },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "kubernetesSecret" },
    ingress: { enabled: false, tls: false, sseTimeoutSeconds: 3600 },
    observability: { backend: "none", requireTraces: false, requireMetrics: false, requireStructuredLogs: true },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "kubernetes-external": parseDeploymentContract({
    profile: "kubernetes-external",
    runtime: { platform: "kubernetes", cloud: "generic", namespace: "opengeni", releaseName: "opengeni" },
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
    nats: { mode: "external", external: { secretRef: { name: "opengeni-nats", key: "OPENGENI_NATS_URL" } } },
    objectStorage: {
      mode: "external",
      api: "s3-compatible",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "externalSecrets" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    observability: { backend: "otel", requireTraces: true, requireMetrics: true, requireStructuredLogs: true },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "azure-managed": parseDeploymentContract({
    profile: "azure-managed",
    runtime: { platform: "kubernetes", cloud: "azure", namespace: "opengeni", releaseName: "opengeni" },
    database: {
      mode: "managed",
      engine: "postgres",
      pgvectorRequired: true,
      managed: { provider: "azure", notes: "Azure Database for PostgreSQL Flexible Server with pgvector enabled." },
    },
    temporal: {
      mode: "inCluster",
      namespace: "default",
      taskQueue: "opengeni-runs-ts",
    },
    nats: { mode: "inCluster" },
    objectStorage: {
      mode: "managed",
      api: "azure-blob",
      bucket: "opengeni-files",
      managed: { provider: "azure", notes: "Azure Storage account Blob container for production file storage." },
    },
    secrets: { mode: "azureKeyVault" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    observability: { backend: "azureMonitor", requireTraces: true, requireMetrics: true, requireStructuredLogs: true },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "azure-existing-services": parseDeploymentContract({
    profile: "azure-existing-services",
    runtime: { platform: "kubernetes", cloud: "azure", namespace: "opengeni", releaseName: "opengeni" },
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
    nats: { mode: "inCluster" },
    objectStorage: {
      mode: "external",
      api: "azure-blob",
      bucket: "opengeni-files",
      external: { secretRef: { name: "opengeni-object-storage" } },
    },
    secrets: { mode: "azureKeyVault" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    observability: { backend: "azureMonitor", requireTraces: true, requireMetrics: true, requireStructuredLogs: true },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
  "self-contained-kubernetes": parseDeploymentContract({
    profile: "self-contained-kubernetes",
    runtime: { platform: "kubernetes", cloud: "generic", namespace: "opengeni", releaseName: "opengeni" },
    database: { mode: "inCluster", engine: "postgres", pgvectorRequired: true },
    temporal: { mode: "inCluster", namespace: "default", taskQueue: "opengeni-runs-ts" },
    nats: { mode: "inCluster" },
    objectStorage: { mode: "inCluster", api: "s3-compatible", bucket: "opengeni-files" },
    secrets: { mode: "kubernetesSecret" },
    ingress: { enabled: true, tls: true, sseTimeoutSeconds: 3600 },
    observability: { backend: "otel", requireTraces: true, requireMetrics: true, requireStructuredLogs: true },
    sandbox: { backend: "none", preparationProfiles: ["none"], envAllowlist: [] },
  }),
};

export function parseDeploymentContract(input: unknown): DeploymentContract {
  return DeploymentContract.parse(input);
}

export function preflightChecksFor(contract: DeploymentContract): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (contract.runtime.platform === "kubernetes") {
    checks.push(check("kubernetes-context", true, "Verify Kubernetes context, namespace, service accounts, and API access."));
    checks.push(check("container-registry", true, "Verify immutable OpenGeni images can be pulled by the workload plane."));
  }
  checks.push(check("postgres-connectivity", true, "Verify API and migration jobs can connect to Postgres."));
  if (contract.database.pgvectorRequired) {
    checks.push(check("postgres-pgvector", true, "Verify the pgvector extension is installed or can be enabled."));
  }
  checks.push(check("postgres-migrations", true, "Verify migrations can run safely and idempotently."));
  checks.push(check("temporal-connectivity", true, "Verify API and workers can reach the configured Temporal endpoint."));
  checks.push(check("temporal-worker-task-queue", true, "Verify workers can poll the configured namespace and task queue."));
  checks.push(check("nats-pubsub", true, "Verify API and workers can publish and subscribe through NATS."));
  checks.push(check("object-storage-read-write", true, "Verify object storage write, read, and URL or mount behavior."));
  checks.push(check("secret-delivery", true, "Verify required runtime secrets are delivered without leaking unintended values."));
  if (contract.ingress.enabled) {
    checks.push(check("ingress-sse", true, "Verify ingress supports long-lived SSE streams and reconnect replay."));
  }
  if (contract.observability.backend !== "none") {
    checks.push(check("otel-export", true, "Verify logs, metrics, and traces reach the configured observability path."));
  }
  checks.push(check("sandbox-readiness", contract.sandbox.backend !== "none", "Verify the selected sandbox backend can start and run a command."));
  checks.push(check("backup-policy", true, "Verify backup, retention, and restore drill expectations for durable data."));
  checks.push(check("conformance-session", true, "Verify a scripted OpenGeni session can create, stream, replay, run, and complete."));
  return checks;
}

export function requiredRuntimeEnvVars(contract: DeploymentContract): string[] {
  const vars = [
    "OPENGENI_TEMPORAL_NAMESPACE",
    "OPENGENI_TEMPORAL_TASK_QUEUE",
    "OPENGENI_SANDBOX_BACKEND",
  ];
  if (contract.database.mode !== "inCluster") {
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
    } else {
      vars.push("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
    }
  }
  if (contract.runtime.platform === "kubernetes") {
    vars.push("OPENGENI_API_HOST", "OPENGENI_API_PORT");
  }
  return [...new Set(vars)].sort();
}

export function missingRuntimeEnvVars(
  contract: DeploymentContract,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return requiredRuntimeEnvVars(contract).filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
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
