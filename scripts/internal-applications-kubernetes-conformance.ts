import {
  buildInternalApplicationDeploymentPlan,
  KubernetesInternalApplicationProvider,
} from "@opengeni/core";

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`${args[0]} exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 2_048)}`);
  return stdout.trim();
}

async function main() {
  const context = process.env.OPENGENI_INTERNAL_APPLICATIONS_KUBE_CONTEXT;
  if (!context || !context.startsWith("kind-opengeni-internal-apps-"))
    throw new Error(
      "OPENGENI_INTERNAL_APPLICATIONS_KUBE_CONTEXT must name an isolated kind-opengeni-internal-apps-* context",
    );
  const image = process.env.OPENGENI_INTERNAL_APPLICATIONS_CONFORMANCE_IMAGE ?? "traefik:v3.6";
  const kubeconfig = JSON.parse(
    await command([
      "kubectl",
      "config",
      "view",
      "--raw",
      "--minify",
      "--context",
      context,
      "-o",
      "json",
    ]),
  ) as {
    clusters?: Array<{
      cluster?: { server?: string; "certificate-authority-data"?: string };
    }>;
  };
  const cluster = kubeconfig.clusters?.[0]?.cluster;
  if (!cluster?.server || !cluster["certificate-authority-data"])
    throw new Error("kind context did not expose an API server and certificate authority");
  const token = await command([
    "kubectl",
    "--context",
    context,
    "-n",
    "opengeni-internal-apps",
    "create",
    "token",
    "opengeni-internal-app-deployer",
    "--duration=10m",
  ]);
  const repoDigests = JSON.parse(
    await command(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"]),
  ) as string[];
  const imageDigest = repoDigests[0]?.split("@")[1];
  if (!imageDigest?.match(/^sha256:[a-f0-9]{64}$/u))
    throw new Error(`${image} has no immutable repository digest`);
  const architecture = (await command([
    "docker",
    "image",
    "inspect",
    image,
    "--format",
    "{{.Architecture}}",
  ])) as "amd64" | "arm64";
  if (architecture !== "amd64" && architecture !== "arm64")
    throw new Error(`unsupported image architecture ${architecture}`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const definitionHash = `sha256:${"b".repeat(64)}` as const;
  const input = {
    application: {
      application: {
        schemaVersion: 1 as const,
        id,
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        slug: `conformance-${id.slice(0, 8)}`,
        name: "Kubernetes conformance",
        description: "Ephemeral provider conformance workload",
        status: "active" as const,
        headRevisionId: crypto.randomUUID(),
        headRevision: 1,
        definitionHash,
        createdBySubjectId: "operator:conformance",
        createdAt: now,
        updatedAt: now,
      },
      headRevision: {
        schemaVersion: 1 as const,
        id: crypto.randomUUID(),
        applicationId: id,
        revision: 1,
        definitionHash,
        definition: {
          schemaVersion: 1 as const,
          source: { kind: "prompt" as const, prompt: "Serve a health-checked test workload." },
          dataBindings: [],
          compute: {
            architecture,
            cpuMillicores: 100,
            memoryMiB: 128,
            storageMiB: 64,
            gpu: null,
            minReplicas: 1,
            maxReplicas: 1,
          },
          ai: {
            enabled: false,
            route: "local" as const,
            defaultModel: null,
            allowedModels: [],
            capabilities: [],
            monthlyBudgetMicros: null,
            requireHumanApprovalForWrites: true,
          },
          routes: [{ name: "web", path: "/", port: 3000, visibility: "workspace" as const }],
          variableSetIds: [],
          metadata: {},
        },
        createdBySubjectId: "operator:conformance",
        createdAt: now,
      },
    },
    bundle: {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      applicationId: id,
      applicationRevisionId: "",
      digest: imageDigest as `sha256:${string}`,
      manifest: {
        schemaVersion: 1 as const,
        image: {
          reference: image.split(":")[0]!,
          digest: imageDigest as `sha256:${string}`,
          architecture,
        },
        staticAssetsDigest: null,
        migrationsDigest: null,
        runtime: {
          command: [
            "/entrypoint.sh",
            "traefik",
            "--ping=true",
            "--entryPoints.traefik.address=:3000",
          ],
          workingDirectory: "/",
        },
        health: { path: "/ping", port: 3000 },
        configurationKeys: [],
        sbomDigest: imageDigest as `sha256:${string}`,
        provenanceDigest: imageDigest as `sha256:${string}`,
      },
      status: "ready" as const,
      createdBySubjectId: "operator:conformance",
      createdAt: now,
    },
    target: {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: "",
      name: "Ephemeral kind",
      description: "",
      kind: "kubernetes" as const,
      environment: "development" as const,
      site: "local-kind",
      config: {
        kind: "kubernetes" as const,
        apiServer: cluster.server,
        namespace: "opengeni-internal-apps",
        serviceAccount: "opengeni-internal-apps",
        ingressClass: null,
        ingressNamespace: null,
        internalDomain: "apps.kind.internal",
        registry: "local",
        storageClasses: ["standard"],
        runtimeApiUrl: "http://opengeni-api.invalid:8000",
        runtimeCredentialSecretPrefix: null,
        dataCredentialSecretPrefix: null,
        allowedEgressCidrs: [],
        credentialConnectionId: null,
      },
      capabilities: {
        architectures: [architecture],
        cpuMillicoresMax: 2_000,
        memoryMiBMax: 4_096,
        storageMiBMax: 10_240,
        gpuTypes: [],
        supportsNetworkPolicy: true,
        supportsPersistentVolumes: true,
        supportsInternalIngress: false,
        supportsLocalModelRoute: false,
      },
      metadata: {},
      status: "active" as const,
      revision: 1,
      lastObservedAt: null,
      createdBySubjectId: "operator:conformance",
      createdAt: now,
      updatedAt: now,
    },
    dataSources: [],
    currentDeployment: null,
  };
  input.application.headRevision.applicationId = input.application.application.id;
  input.bundle.applicationRevisionId = input.application.headRevision.id;
  input.target.workspaceId = input.application.application.workspaceId;
  const provider = new KubernetesInternalApplicationProvider(async () => ({
    bearerToken: token,
    certificateAuthority: Buffer.from(cluster["certificate-authority-data"]!, "base64").toString(
      "utf8",
    ),
  }));
  const plan = buildInternalApplicationDeploymentPlan(
    {
      ...input,
      request: {
        operationId: crypto.randomUUID(),
        applicationId: input.application.application.id,
        expectedApplicationRevision: 1,
        bundleId: input.bundle.id,
        targetId: input.target.id,
        expectedTargetRevision: 1,
        environment: "development" as const,
      },
    },
    new Date(),
  );
  const deployment = {
    schemaVersion: 1 as const,
    id: crypto.randomUUID(),
    applicationId: id,
    environment: "development" as const,
    targetId: input.target.id,
    targetRevision: 1,
    activeBundleId: input.bundle.id,
    desiredBundleId: input.bundle.id,
    status: "deploying" as const,
    internalUrl: null,
    revision: 1,
    lastObservedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const applied = await provider.apply(plan, input);
    async function waitForRunning(providerInput = input) {
      let result = await provider.observe(deployment, providerInput);
      for (let attempt = 0; result.status !== "running" && attempt < 29; attempt += 1) {
        await Bun.sleep(2_000);
        result = await provider.observe(deployment, providerInput);
      }
      return result;
    }
    const observed = await waitForRunning();
    if (observed.status !== "running") throw new Error("workload did not become ready");
    await command([
      "kubectl",
      "--context",
      context,
      "-n",
      "opengeni-internal-apps",
      "rollout",
      "restart",
      `deployment/${input.application.application.slug}`,
    ]);
    const afterRestart = await waitForRunning();
    if (afterRestart.status !== "running")
      throw new Error("workload did not recover after restart");
    const updatedInput = structuredClone(input);
    updatedInput.bundle.id = crypto.randomUUID();
    updatedInput.bundle.digest = `sha256:${"c".repeat(64)}`;
    const updatePlan = buildInternalApplicationDeploymentPlan(
      {
        ...updatedInput,
        request: {
          operationId: crypto.randomUUID(),
          applicationId: updatedInput.application.application.id,
          expectedApplicationRevision: 1,
          bundleId: updatedInput.bundle.id,
          targetId: updatedInput.target.id,
          expectedTargetRevision: 1,
          environment: "development" as const,
        },
        currentDeployment: deployment,
      },
      new Date(),
    );
    await provider.apply(updatePlan, updatedInput);
    const updated = await waitForRunning(updatedInput);
    if (updated.status !== "running") throw new Error("updated bundle did not become ready");
    await provider.rollback({ ...deployment, activeBundleId: updatedInput.bundle.id }, input);
    const rolledBack = await waitForRunning(input);
    if (rolledBack.status !== "running") throw new Error("rollback did not restore health");
    await command([
      "kubectl",
      "--context",
      context,
      "-n",
      "opengeni-internal-apps",
      "annotate",
      "deployment",
      input.application.application.slug,
      `opengeni.ai/bundle-digest=sha256:${"f".repeat(64)}`,
      "--overwrite",
    ]);
    const drift = await provider.observe(deployment, input);
    if (drift.status !== "degraded" || drift.facts.drifted !== true)
      throw new Error("bundle drift was not detected");
    const retired = await provider.retire(deployment, input);
    process.stdout.write(
      `${JSON.stringify({ context, application: input.application.application.slug, applied, observed, afterRestart, updated, rolledBack, drift, retired }, null, 2)}\n`,
    );
  } finally {
    await provider.retire(deployment, input).catch(() => undefined);
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
