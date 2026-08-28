/** Public SDK shapes for the feature-gated governed internal application factory. */
export type InternalApplicationDataAccessMode = "attach" | "clone" | "provision";
export type InternalApplicationEnvironment = "development" | "staging" | "production";
export type InternalApplicationMetadata = Record<string, string | number | boolean>;

export type InternalApplicationDataSourceLocator =
  | {
      kind: "postgres";
      host: string;
      port: number;
      database: string;
      schemas: string[];
      sslMode: "disable" | "prefer" | "require" | "verify-full";
      credentialConnectionId: string | null;
    }
  | {
      kind: "s3";
      endpoint: string;
      region: string | null;
      bucket: string;
      prefix: string;
      credentialConnectionId: string | null;
    }
  | {
      kind: "documents";
      scope: "workspace" | "organization";
      sourceKind: string | null;
      aclTags: string[];
    }
  | {
      kind: "vector";
      endpoint: string;
      collection: string;
      credentialConnectionId: string | null;
    }
  | { kind: "http_api"; baseUrl: string; credentialConnectionId: string | null }
  | {
      kind: "custom";
      provider: string;
      locator: string;
      credentialConnectionId: string | null;
    };

export type InternalApplicationDataSourceLocatorInput =
  | {
      kind: "postgres";
      host: string;
      port?: number | undefined;
      database: string;
      schemas: string[];
      sslMode: "disable" | "prefer" | "require" | "verify-full";
      credentialConnectionId: string | null;
    }
  | Exclude<InternalApplicationDataSourceLocator, { kind: "postgres" }>;

export type InternalApplicationDataGovernance = {
  classification: "public" | "internal" | "confidential" | "restricted";
  residencySite: string;
  residencyRegion: string | null;
  externalEgressAllowed: boolean;
  retentionDays: number | null;
  owner: string;
  purpose: string;
};

export type InternalApplicationDataSource = {
  schemaVersion: 1;
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string;
  kind: InternalApplicationDataSourceLocator["kind"];
  allowedAccessModes: InternalApplicationDataAccessMode[];
  locator: InternalApplicationDataSourceLocator;
  schemaDefinition: Record<string, unknown>;
  governance: InternalApplicationDataGovernance;
  metadata: InternalApplicationMetadata;
  status: "active" | "disabled";
  revision: number;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertInternalApplicationDataSourceRequest = {
  expectedRevision: number;
  name: string;
  description?: string | undefined;
  kind: InternalApplicationDataSourceLocator["kind"];
  allowedAccessModes: InternalApplicationDataAccessMode[];
  locator: InternalApplicationDataSourceLocatorInput;
  schemaDefinition?: Record<string, unknown> | undefined;
  governance: InternalApplicationDataGovernance;
  metadata?: InternalApplicationMetadata | undefined;
  status?: "active" | "disabled" | undefined;
};

export type InternalApplicationDeploymentTargetConfig =
  | {
      kind: "kubernetes";
      apiServer: string;
      namespace: string;
      serviceAccount: string;
      ingressClass: string | null;
      ingressNamespace: string | null;
      internalDomain: string;
      registry: string;
      storageClasses: string[];
      runtimeApiUrl: string;
      runtimeCredentialSecretPrefix: string | null;
      dataCredentialSecretPrefix: string | null;
      dataLifecycleBroker?:
        | {
            endpoint: string;
            credentialConnectionId: string;
            supportedModes: Array<"clone" | "provision">;
          }
        | undefined;
      allowedEgressCidrs: string[];
      credentialConnectionId: string | null;
    }
  | {
      kind: "connected_machine";
      enrollmentId: string;
      workingDirectory: string;
      internalDomain: string | null;
    }
  | {
      kind: "managed";
      provider: "azure" | "aws" | "gcp" | "other";
      region: string;
      clusterId: string;
      internalDomain: string;
      registry: string;
      credentialConnectionId: string | null;
    };

export type InternalApplicationTargetCapabilities = {
  architectures: Array<"amd64" | "arm64">;
  cpuMillicoresMax: number;
  memoryMiBMax: number;
  storageMiBMax: number;
  gpuTypes: string[];
  supportsNetworkPolicy: boolean;
  supportsPersistentVolumes: boolean;
  supportsInternalIngress: boolean;
  supportsLocalModelRoute: boolean;
};

export type InternalApplicationDeploymentTarget = {
  schemaVersion: 1;
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string;
  kind: InternalApplicationDeploymentTargetConfig["kind"];
  environment: InternalApplicationEnvironment;
  site: string;
  config: InternalApplicationDeploymentTargetConfig;
  capabilities: InternalApplicationTargetCapabilities;
  metadata: InternalApplicationMetadata;
  status: "active" | "degraded" | "disabled";
  revision: number;
  lastObservedAt: string | null;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertInternalApplicationDeploymentTargetRequest = {
  expectedRevision: number;
  name: string;
  description?: string | undefined;
  kind: InternalApplicationDeploymentTargetConfig["kind"];
  environment: InternalApplicationEnvironment;
  site: string;
  config: InternalApplicationDeploymentTargetConfig;
  capabilities: InternalApplicationTargetCapabilities;
  metadata?: InternalApplicationMetadata | undefined;
  status?: "active" | "degraded" | "disabled" | undefined;
};

export type InternalApplicationDefinition = {
  schemaVersion: 1;
  source:
    | { kind: "prompt"; prompt: string }
    | {
        kind: "repository";
        repositoryUri: string;
        ref: string | null;
        subpath: string | null;
      }
    | { kind: "bundle"; bundleId: string };
  dataBindings: Array<{
    dataSourceId: string;
    expectedRevision: number;
    accessMode: InternalApplicationDataAccessMode;
    permissions: Array<"read" | "write" | "admin">;
    mountName: string;
  }>;
  compute: {
    architecture: "amd64" | "arm64";
    cpuMillicores: number;
    memoryMiB: number;
    storageMiB: number;
    gpu: { type: string; count: number } | null;
    minReplicas: number;
    maxReplicas: number;
  };
  ai: {
    enabled: boolean;
    route: "local" | "opengeni_managed" | "workspace_provider";
    defaultModel: string | null;
    allowedModels: string[];
    capabilities: string[];
    monthlyBudgetMicros: number | null;
    requireHumanApprovalForWrites: boolean;
  };
  routes: Array<{
    name: string;
    path: string;
    port: number;
    visibility: "workspace" | "organization" | "private";
  }>;
  variableSetIds: string[];
  metadata: InternalApplicationMetadata;
};

export type InternalApplicationSummary = {
  schemaVersion: 1;
  runtimeKind: "external_deployment";
  id: string;
  accountId: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  status: "draft" | "active" | "archived";
  headRevisionId: string;
  headRevision: number;
  definitionHash: string;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};
export type InternalApplicationRevision = {
  schemaVersion: 1;
  runtimeKind: "external_deployment";
  id: string;
  applicationId: string;
  revision: number;
  definitionHash: string;
  definition: InternalApplicationDefinition;
  createdBySubjectId: string;
  createdAt: string;
};
export type InternalApplicationDetail = {
  application: InternalApplicationSummary;
  headRevision: InternalApplicationRevision;
};
export type CreateInternalApplicationRequest = {
  operationId: string;
  slug: string;
  name: string;
  description?: string | undefined;
  definition: InternalApplicationDefinition;
};
export type UpdateInternalApplicationRequest = {
  operationId: string;
  expectedHeadRevision: number;
  name: string;
  description: string;
  status: "draft" | "active" | "archived";
  definition: InternalApplicationDefinition;
};

export type InternalApplicationBundleManifest = {
  schemaVersion: 1;
  image: { reference: string; digest: string; architecture: "amd64" | "arm64" };
  staticAssetsDigest: string | null;
  migrationsDigest: string | null;
  runtime: { command: string[]; workingDirectory: string };
  health: { path: string; port: number };
  configurationKeys: string[];
  sbomDigest: string;
  provenanceDigest: string;
};
export type InternalApplicationBundle = {
  schemaVersion: 1;
  id: string;
  applicationId: string;
  applicationRevisionId: string;
  digest: string;
  manifest: InternalApplicationBundleManifest;
  status: "ready" | "revoked";
  createdBySubjectId: string;
  createdAt: string;
};
export type RegisterInternalApplicationBundleRequest = {
  operationId: string;
  applicationRevisionId: string;
  digest: string;
  manifest: InternalApplicationBundleManifest;
};
export type CreateInternalApplicationBuildSessionRequest = {
  operationId: string;
  expectedApplicationRevision: number;
  targetId?: string | null | undefined;
  model?: string | undefined;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  additionalInstructions?: string | undefined;
};
export type InternalApplicationBuildSessionReceipt = {
  schemaVersion: 1;
  applicationId: string;
  applicationRevision: number;
  sessionId: string;
  initialTurnId: string | null;
  model: string;
  eventsPath: string;
};

export type InternalApplicationDeploymentStatus =
  | "not_deployed"
  | "plan_ready"
  | "awaiting_approval"
  | "deploying"
  | "running"
  | "degraded"
  | "failed"
  | "rolling_back"
  | "rolled_back"
  | "retired";
export type InternalApplicationDeployment = {
  schemaVersion: 1;
  id: string;
  applicationId: string;
  environment: InternalApplicationEnvironment;
  targetId: string;
  targetRevision: number;
  activeBundleId: string | null;
  desiredBundleId: string | null;
  status: InternalApplicationDeploymentStatus;
  internalUrl: string | null;
  revision: number;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type InternalApplicationDeploymentPlan = {
  schemaVersion: 1;
  digest: string;
  applicationId: string;
  applicationRevisionId: string;
  applicationRevision: number;
  bundleId: string;
  bundleDigest: string;
  targetId: string;
  targetRevision: number;
  environment: InternalApplicationEnvironment;
  actions: Array<{
    id: string;
    kind: "create" | "update" | "delete" | "migrate" | "verify";
    resourceType: string;
    resourceName: string;
    summary: string;
    risk: "low" | "medium" | "high";
    irreversible: boolean;
  }>;
  dataFlows: Array<{
    dataSourceId: string;
    sourceSite: string;
    destinationSite: string;
    accessMode: InternalApplicationDataAccessMode;
    externalEgress: boolean;
    credentialDelivery: "brokered" | "short_lived" | "none";
  }>;
  runtimeIdentity: string;
  secretReferences: string[];
  network: { policyEnforced: boolean; allowedEgressCidrs: string[] };
  modelRoute: "disabled" | "local" | "opengeni_managed" | "workspace_provider";
  estimatedMonthlyCostMicros: number | null;
  policyChecks: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
  destructive: boolean;
  createdAt: string;
};
export type InternalApplicationDeploymentOperation = {
  schemaVersion: 1;
  id: string;
  deploymentId: string;
  kind: "plan" | "apply" | "observe" | "rollback" | "retire";
  status:
    | "planned"
    | "awaiting_approval"
    | "approved"
    | "provider_started"
    | "outcome_unknown"
    | "observing"
    | "completed"
    | "failed"
    | "superseded";
  requestHash: string;
  plan: InternalApplicationDeploymentPlan | null;
  approvedBySubjectId: string | null;
  approvedAt: string | null;
  result: InternalApplicationMetadata | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};
export type InternalApplicationDeploymentActionResponse = {
  deployment: InternalApplicationDeployment;
  operation: InternalApplicationDeploymentOperation;
};
export type PlanInternalApplicationDeploymentRequest = {
  operationId: string;
  applicationId: string;
  expectedApplicationRevision: number;
  bundleId: string;
  targetId: string;
  expectedTargetRevision: number;
  environment: InternalApplicationEnvironment;
};
export type ApproveInternalApplicationDeploymentRequest = {
  expectedPlanDigest: string;
};
export type ApplyInternalApplicationDeploymentRequest = {
  operationId: string;
  planOperationId: string;
  expectedPlanDigest: string;
};
export type ObserveInternalApplicationDeploymentRequest = {
  operationId: string;
};
export type RollbackInternalApplicationDeploymentRequest = {
  operationId: string;
  expectedDeploymentRevision: number;
};
export type RetireInternalApplicationDeploymentRequest = {
  operationId: string;
  expectedDeploymentRevision: number;
};
export type ReconcileInternalApplicationDeploymentOperationRequest = {
  operationId: string;
  expectedDeploymentRevision: number;
};
export type InternalApplicationEvent = {
  schemaVersion: 1;
  id: string;
  applicationId: string | null;
  deploymentId: string | null;
  operationId: string | null;
  type: string;
  actorSubjectId: string;
  facts: Record<string, string | number | boolean | null>;
  createdAt: string;
};
export type CreateInternalApplicationAiSessionRequest = {
  operationId: string;
  initialMessage: string;
  modelContext?: string | undefined;
  instructions?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  metadata?: InternalApplicationMetadata | undefined;
};
export type InternalApplicationAiSessionReceipt = {
  schemaVersion: 1;
  applicationId: string;
  applicationRevision: number;
  sessionId: string;
  initialTurnId: string | null;
  model: string;
  eventsPath: string;
};
