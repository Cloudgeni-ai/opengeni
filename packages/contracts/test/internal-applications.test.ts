import { describe, expect, test } from "bun:test";
import {
  CreateInternalApplicationAiSessionRequest,
  InternalApplicationDefinition,
  InternalApplicationDeploymentPlan,
  UpsertInternalApplicationDataSourceRequest,
  UpsertInternalApplicationDeploymentTargetRequest,
} from "../src/internal-applications";

const id = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}`;

const definition = {
  schemaVersion: 1,
  source: { kind: "prompt", prompt: "Build a governed maintenance assistant." },
  dataBindings: [
    {
      dataSourceId: id,
      expectedRevision: 1,
      accessMode: "attach",
      permissions: ["read"],
      mountName: "maintenance-data",
    },
  ],
  compute: {
    architecture: "amd64",
    cpuMillicores: 500,
    memoryMiB: 1024,
    storageMiB: 2048,
    gpu: null,
    minReplicas: 1,
    maxReplicas: 2,
  },
  ai: {
    enabled: true,
    route: "local",
    defaultModel: "local-research-model",
    allowedModels: ["local-research-model"],
    capabilities: ["document-search"],
    monthlyBudgetMicros: null,
    requireHumanApprovalForWrites: true,
  },
  routes: [{ name: "web", path: "/", port: 3000, visibility: "workspace" }],
  variableSetIds: [],
  metadata: { ownerTeam: "research" },
};

describe("internal application contracts", () => {
  test("accepts bounded, credential-free native AI session input", () => {
    expect(
      CreateInternalApplicationAiSessionRequest.safeParse({
        operationId: id,
        initialMessage: "Summarize the selected experiment.",
        modelContext: "Experiment 42 has an approved tensile-strength result.",
        metadata: { project: "materials" },
      }).success,
    ).toBe(true);
    expect(
      CreateInternalApplicationAiSessionRequest.safeParse({
        operationId: id,
        initialMessage: "Hello",
        metadata: { apiKey: "must-not-cross-this-boundary" },
      }).success,
    ).toBe(false);
  });
  test("accepts a prompt-built application with governed data and native AI", () => {
    expect(InternalApplicationDefinition.safeParse(definition).success).toBe(true);
  });

  test("rejects duplicate bindings and secret-like metadata", () => {
    expect(
      InternalApplicationDefinition.safeParse({
        ...definition,
        dataBindings: [...definition.dataBindings, ...definition.dataBindings],
      }).success,
    ).toBe(false);
    expect(
      InternalApplicationDefinition.safeParse({
        ...definition,
        metadata: { apiToken: "must-not-be-here" },
      }).success,
    ).toBe(false);
  });

  test("requires the selected default model to be explicitly allowed", () => {
    expect(
      InternalApplicationDefinition.safeParse({
        ...definition,
        ai: { ...definition.ai, allowedModels: ["another-model"] },
      }).success,
    ).toBe(false);
    expect(
      InternalApplicationDefinition.safeParse({
        ...definition,
        ai: {
          ...definition.ai,
          enabled: false,
          defaultModel: null,
          allowedModels: [],
        },
      }).success,
    ).toBe(true);
  });

  test("data-source kind and credential-free locator must agree", () => {
    const base = {
      expectedRevision: 0,
      name: "Lab database",
      kind: "postgres",
      allowedAccessModes: ["attach"],
      locator: {
        kind: "postgres",
        host: "postgres.lab.internal",
        port: 5432,
        database: "research",
        schemas: ["public"],
        sslMode: "require",
        credentialConnectionId: null,
      },
      governance: {
        classification: "restricted",
        residencySite: "SINTEF Oslo",
        residencyRegion: "NO",
        externalEgressAllowed: false,
        retentionDays: null,
        owner: "Research IT",
        purpose: "Internal demonstrations",
      },
    } as const;
    expect(UpsertInternalApplicationDataSourceRequest.safeParse(base).success).toBe(true);
    expect(
      UpsertInternalApplicationDataSourceRequest.safeParse({
        ...base,
        kind: "s3",
      }).success,
    ).toBe(false);
  });

  test("rejects deployment endpoints with embedded credentials", () => {
    expect(
      UpsertInternalApplicationDeploymentTargetRequest.safeParse({
        expectedRevision: 0,
        name: "Local cluster",
        kind: "kubernetes",
        environment: "development",
        site: "SINTEF Oslo",
        config: {
          kind: "kubernetes",
          apiServer: "https://operator:password@kubernetes.internal",
          namespace: "internal-apps",
          serviceAccount: "opengeni-internal-apps",
          ingressClass: null,
          ingressNamespace: null,
          internalDomain: "apps.lab.internal",
          registry: "registry.lab.internal/opengeni",
          storageClasses: ["local-path"],
          runtimeApiUrl: "http://opengeni-api.opengeni.svc:8000",
          runtimeCredentialSecretPrefix: "opengeni-internal-app-runtime",
          dataCredentialSecretPrefix: "opengeni-internal-app-data",
          allowedEgressCidrs: [],
          credentialConnectionId: null,
        },
        capabilities: {
          architectures: ["amd64"],
          cpuMillicoresMax: 8_000,
          memoryMiBMax: 32_768,
          storageMiBMax: 1_000_000,
          gpuTypes: [],
          supportsNetworkPolicy: true,
          supportsPersistentVolumes: true,
          supportsInternalIngress: true,
          supportsLocalModelRoute: true,
        },
      }).success,
    ).toBe(false);
  });

  test("accepts an auditable immutable deployment plan", () => {
    expect(
      InternalApplicationDeploymentPlan.safeParse({
        schemaVersion: 1,
        digest,
        applicationId: id,
        applicationRevisionId: id,
        applicationRevision: 1,
        bundleId: id,
        bundleDigest: digest,
        targetId: id,
        targetRevision: 1,
        environment: "development",
        actions: [
          {
            id: "deploy-app",
            kind: "create",
            resourceType: "kubernetes-deployment",
            resourceName: "maintenance-assistant",
            summary: "Deploy the immutable application bundle",
            risk: "low",
            irreversible: false,
          },
        ],
        dataFlows: [
          {
            dataSourceId: id,
            sourceSite: "SINTEF Oslo",
            destinationSite: "SINTEF Oslo",
            accessMode: "attach",
            externalEgress: false,
            credentialDelivery: "brokered",
          },
        ],
        runtimeIdentity: "system:serviceaccount:internal-apps:materials-demo",
        secretReferences: ["materials-demo-runtime"],
        network: { policyEnforced: true, allowedEgressCidrs: ["10.20.0.0/16"] },
        modelRoute: "local",
        estimatedMonthlyCostMicros: null,
        policyChecks: [{ id: "data-residency", status: "pass", message: "Data stays local" }],
        destructive: false,
        createdAt: "2026-08-24T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
