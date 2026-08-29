import { describe, expect, test } from "bun:test";
import {
  buildInternalApplicationDeploymentPlan,
  InternalApplicationProviderError,
  KubernetesInternalApplicationProvider,
  resolveInternalApplicationBuildSessionPolicy,
  resolveInternalApplicationAiSessionPolicy,
} from "../src/domain/internal-applications";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const digest = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-08-24T12:00:00.000Z");

function runningDeployment() {
  return {
    schemaVersion: 1 as const,
    id,
    applicationId: id,
    environment: "development" as const,
    targetId: id,
    targetRevision: 1,
    activeBundleId: id,
    desiredBundleId: id,
    status: "running" as const,
    internalUrl: "https://maintenance-assistant.apps.lab.internal",
    revision: 2,
    lastObservedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function inputs() {
  return {
    request: {
      operationId: id,
      applicationId: id,
      expectedApplicationRevision: 1,
      bundleId: id,
      targetId: id,
      expectedTargetRevision: 1,
      environment: "development" as const,
    },
    application: {
      application: {
        schemaVersion: 1 as const,
        id,
        accountId: id,
        workspaceId: id,
        slug: "maintenance-assistant",
        name: "Maintenance Assistant",
        description: "",
        status: "active" as const,
        headRevisionId: id,
        headRevision: 1,
        definitionHash: digest,
        createdBySubjectId: "user:owner",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      headRevision: {
        schemaVersion: 1 as const,
        id,
        applicationId: id,
        revision: 1,
        definitionHash: digest,
        definition: {
          schemaVersion: 1 as const,
          source: { kind: "prompt" as const, prompt: "Build an assistant." },
          dataBindings: [
            {
              dataSourceId: otherId,
              expectedRevision: 1,
              accessMode: "attach" as const,
              permissions: ["read" as const],
              mountName: "research-data",
            },
          ],
          compute: {
            architecture: "amd64" as const,
            cpuMillicores: 500,
            memoryMiB: 1024,
            storageMiB: 2048,
            gpu: null,
            minReplicas: 1,
            maxReplicas: 2,
          },
          ai: {
            enabled: true,
            route: "local" as const,
            defaultModel: "local-model",
            allowedModels: ["local-model"],
            capabilities: ["document-search"],
            monthlyBudgetMicros: null,
            requireHumanApprovalForWrites: true,
          },
          routes: [
            {
              name: "web",
              path: "/",
              port: 3000,
              visibility: "workspace" as const,
            },
          ],
          variableSetIds: [],
          metadata: {},
        },
        createdBySubjectId: "user:owner",
        createdAt: now.toISOString(),
      },
    },
    bundle: {
      schemaVersion: 1 as const,
      id,
      applicationId: id,
      applicationRevisionId: id,
      digest,
      manifest: {
        schemaVersion: 1 as const,
        image: {
          reference: "registry.internal/maintenance",
          digest,
          architecture: "amd64" as const,
        },
        staticAssetsDigest: null,
        migrationsDigest: null,
        runtime: { command: ["bun", "run", "start"], workingDirectory: "/app" },
        health: { path: "/healthz", port: 3000 },
        configurationKeys: ["OPENGENI_RUNTIME_URL"],
        sbomDigest: digest,
        provenanceDigest: digest,
      },
      status: "ready" as const,
      createdBySubjectId: "user:owner",
      createdAt: now.toISOString(),
    },
    target: {
      schemaVersion: 1 as const,
      id,
      accountId: id,
      workspaceId: id,
      name: "SINTEF local Kubernetes",
      description: "",
      kind: "kubernetes" as const,
      environment: "development" as const,
      site: "SINTEF Oslo",
      config: {
        kind: "kubernetes" as const,
        apiServer: "https://kubernetes.internal",
        namespace: "internal-apps",
        serviceAccount: "opengeni-internal-apps",
        ingressClass: "nginx",
        ingressNamespace: "ingress-nginx",
        internalDomain: "apps.lab.internal",
        registry: "registry.internal",
        storageClasses: ["local-path"],
        runtimeApiUrl: "http://opengeni-api.opengeni.svc:8000",
        runtimeCredentialSecretPrefix: "maintenance-opengeni-runtime",
        dataCredentialSecretPrefix: "maintenance-data",
        allowedEgressCidrs: ["10.20.0.0/16"],
        credentialConnectionId: null,
      },
      capabilities: {
        architectures: ["amd64" as const],
        cpuMillicoresMax: 8_000,
        memoryMiBMax: 32_768,
        storageMiBMax: 1_000_000,
        gpuTypes: [],
        supportsNetworkPolicy: true,
        supportsPersistentVolumes: true,
        supportsInternalIngress: true,
        supportsLocalModelRoute: true,
      },
      metadata: {},
      status: "active" as const,
      revision: 1,
      lastObservedAt: null,
      createdBySubjectId: "user:owner",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    dataSources: [
      {
        schemaVersion: 1 as const,
        id: otherId,
        accountId: id,
        workspaceId: id,
        name: "Research database",
        description: "",
        kind: "postgres" as const,
        allowedAccessModes: ["attach" as const],
        locator: {
          kind: "postgres" as const,
          host: "measurements.sintef.internal",
          port: 5432,
          database: "materials",
          schemas: ["approved"],
          sslMode: "verify-full" as const,
          credentialConnectionId: connectionId,
        },
        schemaDefinition: {},
        governance: {
          classification: "restricted" as const,
          residencySite: "SINTEF Oslo",
          residencyRegion: "NO",
          externalEgressAllowed: false,
          retentionDays: null,
          owner: "Research IT",
          purpose: "Demonstration",
        },
        metadata: {},
        status: "active" as const,
        revision: 1,
        createdBySubjectId: "user:owner",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
    currentDeployment: null,
  };
}

describe("internal application planner", () => {
  test("is deterministic and proves local data plus local AI routing", () => {
    const first = buildInternalApplicationDeploymentPlan(inputs(), now);
    const second = buildInternalApplicationDeploymentPlan(inputs(), now);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.policyChecks.every((check) => check.status === "pass")).toBe(true);
    expect(first.dataFlows[0]).toMatchObject({
      sourceSite: "SINTEF Oslo",
      destinationSite: "SINTEF Oslo",
      externalEgress: false,
    });
  });

  test("fails closed when restricted data would leave its site", () => {
    const value = inputs();
    value.target.site = "External cloud";
    const plan = buildInternalApplicationDeploymentPlan(value, now);
    expect(plan.policyChecks).toContainEqual(
      expect.objectContaining({
        id: "residency-research-data",
        status: "fail",
      }),
    );
  });

  test("plans clone/provision only through an approved lifecycle broker", () => {
    const value = inputs();
    value.application.headRevision.definition.dataBindings[0]!.accessMode = "clone";
    value.dataSources[0]!.allowedAccessModes = ["attach", "clone"];
    let plan = buildInternalApplicationDeploymentPlan(value, now);
    expect(plan.policyChecks).toContainEqual(
      expect.objectContaining({ id: "data-mode-research-data", status: "fail" }),
    );
    value.target.config.dataLifecycleBroker = {
      endpoint: "https://data-broker.sintef.internal",
      credentialConnectionId: connectionId,
      supportedModes: ["clone"],
    };
    plan = buildInternalApplicationDeploymentPlan(value, now);
    expect(plan.policyChecks).toContainEqual(
      expect.objectContaining({ id: "data-mode-research-data", status: "pass" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "clone-research-data", kind: "migrate" }),
    );
    expect(plan.dataFlows[0]?.credentialDelivery).toBe("short_lived");
    expect(plan.destructive).toBe(true);
  });
});

describe("internal application native AI policy", () => {
  test("selects only an allowed model on an active deployment", () => {
    const value = inputs();
    const resolved = resolveInternalApplicationAiSessionPolicy(
      value.application,
      [runningDeployment()],
      [value.bundle],
      { operationId: id, initialMessage: "Summarize the approved record" },
    );
    expect(resolved.model).toBe("local-model");
    expect(resolved.instructions).toContain("Maintenance Assistant");
    expect(resolved.instructions).toContain("explicit human approval");
  });

  test("fails closed for a disallowed model or absent active deployment", () => {
    const value = inputs();
    expect(() =>
      resolveInternalApplicationAiSessionPolicy(
        value.application,
        [runningDeployment()],
        [value.bundle],
        {
          operationId: id,
          initialMessage: "Hello",
          model: "remote-unapproved-model",
        },
      ),
    ).toThrow("outside the application policy");
    expect(() =>
      resolveInternalApplicationAiSessionPolicy(value.application, [], [value.bundle], {
        operationId: id,
        initialMessage: "Hello",
      }),
    ).toThrow("active deployment of the current application revision");
    expect(() =>
      resolveInternalApplicationAiSessionPolicy(
        value.application,
        [runningDeployment()],
        [{ ...value.bundle, applicationRevisionId: otherId }],
        { operationId: id, initialMessage: "Hello" },
      ),
    ).toThrow("current application revision");
  });
});

describe("internal application build-session policy", () => {
  test("freezes revision and capability context without data credentials or locators", () => {
    const value = inputs();
    const resolved = resolveInternalApplicationBuildSessionPolicy(
      value.application,
      value.dataSources,
      [value.target],
      {
        operationId: id,
        expectedApplicationRevision: 1,
        targetId: value.target.id,
      },
    );
    expect(resolved.instructions).toContain("Frozen build context");
    expect(resolved.instructions).toContain("research-data");
    expect(resolved.instructions).toContain("supportsLocalModelRoute");
    expect(resolved.instructions).not.toContain(connectionId);
    expect(resolved.instructions).not.toContain("measurements.sintef.internal");
    expect(resolved.instructions).not.toContain("test-bearer-token");
  });

  test("rejects a stale application revision before session creation", () => {
    const value = inputs();
    expect(() =>
      resolveInternalApplicationBuildSessionPolicy(
        value.application,
        value.dataSources,
        [value.target],
        {
          operationId: id,
          expectedApplicationRevision: 2,
          targetId: null,
        },
      ),
    ).toThrow("revision changed");
  });
});

describe("Kubernetes internal application provider", () => {
  test("server-side applies digest-pinned, secret-free resources", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "test-bearer-token" }),
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json(
          init?.method === "PATCH"
            ? {}
            : {
                metadata: {
                  generation: 1,
                  annotations: { "opengeni.ai/bundle-digest": digest },
                },
                spec: { replicas: 1 },
                status: {
                  availableReplicas: 1,
                  readyReplicas: 1,
                  updatedReplicas: 1,
                  unavailableReplicas: 0,
                  observedGeneration: 1,
                },
              },
        );
      }) as typeof fetch,
    );
    const value = inputs();
    const plan = buildInternalApplicationDeploymentPlan(value, now);
    const result = await provider.apply(plan, value);
    expect(result.internalUrl).toBe("https://maintenance-assistant.apps.lab.internal");
    expect(requests).toHaveLength(5);
    const mutations = requests.filter((request) => request.init.method === "PATCH");
    const rendered = mutations.map((request) => String(request.init.body)).join("\n");
    expect(rendered).toContain(`registry.internal/maintenance@${digest}`);
    expect(rendered).toContain("OPENGENI_DATA_BINDINGS_JSON");
    expect(rendered).toContain("maintenance-opengeni-runtime-maintenance-assistant");
    expect(rendered).toContain("maintenance-data-research-data");
    expect(rendered).toContain("measurements.sintef.internal");
    expect(rendered).toContain("10.20.0.0/16");
    expect(rendered).toContain("livenessProbe");
    expect(rendered).not.toContain("test-bearer-token");
    expect(rendered).not.toContain(connectionId);
    expect(rendered).not.toMatch(/password|bearer[_-]?token|private[_-]?key/iu);
    expect(mutations).toHaveLength(4);
  });

  test("classifies a Kubernetes 403 as a definite provider failure", async () => {
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "test" }),
      (async () => new Response("{}", { status: 403 })) as typeof fetch,
    );
    const value = inputs();
    await expect(
      provider.apply(buildInternalApplicationDeploymentPlan(value, now), value),
    ).rejects.toMatchObject<Partial<InternalApplicationProviderError>>({
      code: "kubernetes_403",
      outcomeUnknown: false,
    });
  });

  test("does not settle apply before a terminally failed rollout", async () => {
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "test" }),
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH"
          ? Response.json({})
          : Response.json({
              metadata: {
                generation: 2,
                annotations: { "opengeni.ai/bundle-digest": digest },
              },
              spec: { replicas: 1 },
              status: {
                availableReplicas: 0,
                readyReplicas: 0,
                updatedReplicas: 0,
                unavailableReplicas: 1,
                observedGeneration: 2,
                conditions: [
                  {
                    type: "Progressing",
                    status: "False",
                    reason: "ProgressDeadlineExceeded",
                  },
                ],
              },
            })) as typeof fetch,
    );
    const value = inputs();
    await expect(
      provider.apply(buildInternalApplicationDeploymentPlan(value, now), value),
    ).rejects.toMatchObject<Partial<InternalApplicationProviderError>>({
      code: "kubernetes_rollout_failed",
      outcomeUnknown: false,
    });
  });

  test("retires only the exact managed resources and treats absence as success", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "test" }),
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response("{}", {
          status: requests.length === 1 ? 404 : 200,
        });
      }) as typeof fetch,
    );
    const result = await provider.retire(runningDeployment(), inputs());
    expect(result).toMatchObject({
      internalUrl: null,
      facts: { resourcesDeleted: 3, resourcesAlreadyAbsent: 1 },
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.method === "DELETE")).toBe(true);
    expect(requests[0]?.url).toContain("networkpolicies/maintenance-assistant");
    expect(requests.at(-1)?.url).toContain("deployments/maintenance-assistant");
  });

  test("observes rollout identity and reports bundle drift as degraded", async () => {
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "test" }),
      (async () =>
        Response.json({
          metadata: {
            uid: "deployment-uid",
            generation: 4,
            annotations: { "opengeni.ai/bundle-digest": `sha256:${"f".repeat(64)}` },
          },
          spec: { replicas: 1 },
          status: {
            availableReplicas: 1,
            readyReplicas: 1,
            updatedReplicas: 1,
            observedGeneration: 4,
            conditions: [{ type: "Available", status: "True", reason: "MinimumReplicasAvailable" }],
          },
        })) as typeof fetch,
    );
    const observation = await provider.observe(runningDeployment(), inputs());
    expect(observation).toMatchObject({
      status: "degraded",
      facts: {
        providerResourceId: "deployment-uid",
        generation: 4,
        observedGeneration: 4,
        drifted: true,
        availableCondition: "True",
      },
    });
  });

  test("uses a credential-isolated lifecycle broker for clone before applying compute", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new KubernetesInternalApplicationProvider(
      async () => ({ bearerToken: "kubernetes-token" }),
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("data-broker"))
          return Response.json({
            auditDigest: `sha256:${"e".repeat(64)}`,
            bindingsProcessed: 1,
          });
        if (init?.method === "PATCH") return Response.json({});
        return Response.json({
          metadata: {
            generation: 1,
            annotations: { "opengeni.ai/bundle-digest": digest },
          },
          spec: { replicas: 1 },
          status: {
            availableReplicas: 1,
            readyReplicas: 1,
            updatedReplicas: 1,
            unavailableReplicas: 0,
            observedGeneration: 1,
          },
        });
      }) as typeof fetch,
      async () => ({ bearerToken: "broker-token" }),
    );
    const value = inputs();
    value.application.headRevision.definition.dataBindings[0]!.accessMode = "clone";
    value.dataSources[0]!.allowedAccessModes = ["attach", "clone"];
    value.target.config.dataLifecycleBroker = {
      endpoint: "https://data-broker.sintef.internal",
      credentialConnectionId: connectionId,
      supportedModes: ["clone"],
    };
    const result = await provider.apply(buildInternalApplicationDeploymentPlan(value, now), value);
    expect(result.facts).toMatchObject({
      dataLifecycleAction: "apply",
      dataLifecycleBindings: 1,
      dataLifecycleAuditDigest: `sha256:${"e".repeat(64)}`,
    });
    const brokerRequest = requests[0]!;
    expect(brokerRequest.url).toEndWith("/v1/bindings/apply");
    expect(brokerRequest.init.headers).toMatchObject({
      authorization: "Bearer broker-token",
    });
    const body = String(brokerRequest.init.body);
    expect(body).toContain('"accessMode":"clone"');
    expect(body).toContain('"runtimeSecretName":"maintenance-data-research-data"');
    expect(body).not.toContain(connectionId);
    expect(body).not.toContain("broker-token");
    expect(body).not.toContain("kubernetes-token");
    expect(requests.filter((request) => request.init.method === "PATCH")).toHaveLength(4);
  });
});
