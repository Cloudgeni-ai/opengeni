import { createHash } from "node:crypto";

import {
  ApplyInternalApplicationDeploymentRequest,
  CreateInternalApplicationAiSessionRequest,
  CreateInternalApplicationBuildSessionRequest,
  InternalApplicationDeploymentActionResponse,
  InternalApplicationDeploymentPlan,
  PlanInternalApplicationDeploymentRequest,
  ReconcileInternalApplicationDeploymentOperationRequest,
  RetireInternalApplicationDeploymentRequest,
  RollbackInternalApplicationDeploymentRequest,
  stableJson,
  type InternalApplicationBundle,
  type InternalApplicationDataSource,
  type InternalApplicationDeployment,
  type InternalApplicationDeploymentTarget,
  type InternalApplicationDetail,
} from "@opengeni/contracts";
import {
  approveInternalApplicationDeploymentPlan as approvePlanInDatabase,
  beginInternalApplicationApply,
  beginInternalApplicationSimpleOperation,
  getInternalApplicationDeploymentOperation,
  internalApplicationRequestHash,
  persistInternalApplicationDeploymentPlan,
  projectInternalApplicationDeployment,
  projectInternalApplicationOperation,
  reconcileInternalApplicationUnknownOperation,
  resolveInternalApplicationDeploymentRuntime,
  resolveInternalApplicationProviderInputs,
  resolveInternalApplicationPlanInputs,
  settleInternalApplicationApply,
  settleInternalApplicationSimpleOperation,
  type Database,
} from "@opengeni/db";

export type InternalApplicationProviderInputs = {
  application: InternalApplicationDetail;
  bundle: InternalApplicationBundle;
  target: InternalApplicationDeploymentTarget;
  dataSources: InternalApplicationDataSource[];
};

export type InternalApplicationProviderResult = {
  internalUrl: string | null;
  facts: Record<string, string | number | boolean>;
};

export type InternalApplicationObservation = InternalApplicationProviderResult & {
  status: "running" | "degraded" | "failed" | "retired";
};

export interface InternalApplicationProvider {
  apply(
    plan: InternalApplicationDeploymentPlan,
    input: InternalApplicationProviderInputs,
  ): Promise<InternalApplicationProviderResult>;
  observe(
    deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ): Promise<InternalApplicationObservation>;
  rollback(
    deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ): Promise<InternalApplicationProviderResult>;
  retire(
    deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ): Promise<InternalApplicationProviderResult>;
}

export class InternalApplicationProviderError extends Error {
  readonly name = "InternalApplicationProviderError";

  constructor(
    message: string,
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
  }
}

export function resolveInternalApplicationBuildSessionPolicy(
  detail: InternalApplicationDetail,
  dataSources: InternalApplicationDataSource[],
  targets: InternalApplicationDeploymentTarget[],
  rawRequest: CreateInternalApplicationBuildSessionRequest,
) {
  const request = CreateInternalApplicationBuildSessionRequest.parse(rawRequest);
  if (detail.application.headRevision !== request.expectedApplicationRevision) {
    throw new InternalApplicationProviderError(
      "Application revision changed before the build session started",
      "application_revision_changed",
      false,
    );
  }
  const target = request.targetId
    ? targets.find((candidate) => candidate.id === request.targetId)
    : null;
  if (request.targetId && (!target || target.status === "disabled")) {
    throw new InternalApplicationProviderError(
      "Selected build target is not available",
      "target_unavailable",
      false,
    );
  }
  const sourceById = new Map(dataSources.map((source) => [source.id, source]));
  const bindings = detail.headRevision.definition.dataBindings.map((binding) => {
    const source = sourceById.get(binding.dataSourceId);
    if (!source || source.status !== "active" || source.revision !== binding.expectedRevision) {
      throw new InternalApplicationProviderError(
        `Data source ${binding.mountName} is unavailable or changed`,
        "data_source_changed",
        false,
      );
    }
    return {
      mountName: binding.mountName,
      kind: source.kind,
      accessMode: binding.accessMode,
      permissions: binding.permissions,
      schemaDefinition: source.schemaDefinition,
      governance: source.governance,
    };
  });
  const buildContext = {
    schemaVersion: 1,
    applicationId: detail.application.id,
    applicationRevisionId: detail.headRevision.id,
    applicationRevision: detail.application.headRevision,
    slug: detail.application.slug,
    definitionHash: detail.application.definitionHash,
    definition: detail.headRevision.definition,
    dataBindings: bindings,
    target: target
      ? {
          id: target.id,
          revision: target.revision,
          kind: target.kind,
          environment: target.environment,
          site: target.site,
          capabilities: target.capabilities,
        }
      : null,
  };
  const source = detail.headRevision.definition.source;
  const sourceInstruction =
    source.kind === "prompt"
      ? source.prompt
      : source.kind === "repository"
        ? `Use repository ${source.repositoryUri}${source.ref ? ` at ref ${source.ref}` : ""}${source.subpath ? `, subpath ${source.subpath}` : ""}.`
        : `Inspect and extend the registered source bundle ${source.bundleId}.`;
  return {
    request,
    instructions: [
      "You are the build and preview agent for a governed OpenGeni internal application.",
      "Work only in /workspace. Generate or update a complete, testable application from the frozen context below.",
      "Never embed credentials, tokens, signed URLs, governed dataset bytes, or provider secrets in source, logs, artifacts, images, or manifests.",
      "Treat data bindings as interfaces: build against their declared schemas and environment-injected runtime configuration; do not fetch source data during the build.",
      "Provide /healthz-compatible health behavior matching the declared bundle health contract, a production Dockerfile, deterministic lockfiles, tests, and concise operator documentation.",
      "Run formatting, type checks, tests, and a local preview when the sandbox supports it. Keep failures visible and repair them.",
      "Write /workspace/opengeni.bundle-build.json with the exact application/revision identity, build/test commands, runtime command, health path/port, configuration keys, and produced artifact paths. Do not invent an image digest, SBOM digest, or provenance digest; those come from the trusted publisher.",
      "Do not deploy or contact a registry. Publication and deployment happen through a separately approved control-plane operation.",
      request.additionalInstructions ?? "",
      `Frozen build context:\n${stableJson(buildContext)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    initialMessage: `Build and test ${detail.application.name}. ${sourceInstruction}`,
  };
}

function dataSourceConnectionId(source: InternalApplicationDataSource): string | null {
  return "credentialConnectionId" in source.locator ? source.locator.credentialConnectionId : null;
}

function credentialFreeLocator(source: InternalApplicationDataSource): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source.locator).filter(([key]) => key !== "credentialConnectionId"),
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function buildInternalApplicationDeploymentPlan(
  inputs: Awaited<ReturnType<typeof resolveInternalApplicationPlanInputs>>,
  now = new Date(),
) {
  const definition = inputs.application.headRevision.definition;
  const compute = definition.compute;
  const capabilities = inputs.target.capabilities;
  const checks: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }> = [];
  checks.push({
    id: "provider-adapter",
    status: inputs.target.kind === "kubernetes" ? "pass" : "fail",
    message:
      inputs.target.kind === "kubernetes"
        ? "The native Kubernetes provider can apply this target"
        : `The ${inputs.target.kind} provider is not enabled in this preview`,
  });
  const capacityFailures: string[] = [];
  if (!capabilities.architectures.includes(compute.architecture))
    capacityFailures.push("architecture");
  if (compute.cpuMillicores > capabilities.cpuMillicoresMax) capacityFailures.push("CPU");
  if (compute.memoryMiB > capabilities.memoryMiBMax) capacityFailures.push("memory");
  if (compute.storageMiB > capabilities.storageMiBMax) capacityFailures.push("storage");
  if (compute.gpu && !capabilities.gpuTypes.includes(compute.gpu.type))
    capacityFailures.push("GPU");
  checks.push({
    id: "target-capacity",
    status: capacityFailures.length === 0 ? "pass" : "fail",
    message:
      capacityFailures.length === 0
        ? "Target satisfies the compute profile"
        : `Target does not satisfy: ${capacityFailures.join(", ")}`,
  });
  if (definition.ai.enabled && definition.ai.route === "local") {
    checks.push({
      id: "local-model-route",
      status: capabilities.supportsLocalModelRoute ? "pass" : "fail",
      message: capabilities.supportsLocalModelRoute
        ? "Target supports a local model route"
        : "Target cannot provide the requested local model route",
    });
  }
  if (definition.ai.enabled && inputs.target.config.kind === "kubernetes") {
    checks.push({
      id: "native-ai-credential",
      status: inputs.target.config.runtimeCredentialSecretPrefix ? "pass" : "fail",
      message: inputs.target.config.runtimeCredentialSecretPrefix
        ? "Runtime API credential is referenced through the target secret manager"
        : "Native AI requires a Kubernetes runtime credential Secret reference",
    });
  }
  if (!capabilities.supportsNetworkPolicy) {
    checks.push({
      id: "network-policy",
      status: "warn",
      message: "Target cannot enforce an application NetworkPolicy",
    });
  } else {
    checks.push({
      id: "network-policy",
      status: "pass",
      message: "Target can enforce application network boundaries",
    });
  }
  if (
    inputs.target.config.kind === "kubernetes" &&
    inputs.target.config.ingressClass &&
    !inputs.target.config.ingressNamespace
  ) {
    checks.push({
      id: "ingress-namespace",
      status: "fail",
      message: "Internal ingress requires an explicit controller namespace",
    });
  }
  const sourceById = new Map(inputs.dataSources.map((source) => [source.id, source]));
  const dataFlows = definition.dataBindings.map((binding) => {
    const source = sourceById.get(binding.dataSourceId);
    if (!source) throw new Error(`Planner input omitted data source ${binding.dataSourceId}`);
    const lifecycleBroker =
      inputs.target.config.kind === "kubernetes"
        ? inputs.target.config.dataLifecycleBroker
        : undefined;
    if (
      binding.accessMode !== "attach" &&
      !lifecycleBroker?.supportedModes.includes(binding.accessMode)
    ) {
      checks.push({
        id: `data-mode-${binding.mountName}`,
        status: "fail",
        message: `${binding.accessMode} requires an approved target data-lifecycle broker`,
      });
    } else if (binding.accessMode !== "attach") {
      checks.push({
        id: `data-mode-${binding.mountName}`,
        status: "pass",
        message: `${binding.accessMode} is handled by the target's approved data-lifecycle broker`,
      });
    }
    const leavesSite = source.governance.residencySite !== inputs.target.site;
    if (leavesSite && !source.governance.externalEgressAllowed) {
      checks.push({
        id: `residency-${binding.mountName}`,
        status: "fail",
        message: `${binding.mountName} cannot leave ${source.governance.residencySite}`,
      });
    } else {
      checks.push({
        id: `residency-${binding.mountName}`,
        status: "pass",
        message: leavesSite
          ? `${binding.mountName} permits transfer to ${inputs.target.site}`
          : `${binding.mountName} stays at ${inputs.target.site}`,
      });
    }
    if (
      definition.ai.enabled &&
      definition.ai.route !== "local" &&
      !source.governance.externalEgressAllowed
    ) {
      checks.push({
        id: `model-egress-${binding.mountName}`,
        status: "fail",
        message: `${binding.mountName} forbids the requested external model route`,
      });
    }
    if (
      (dataSourceConnectionId(source) || binding.accessMode !== "attach") &&
      inputs.target.config.kind === "kubernetes" &&
      !inputs.target.config.dataCredentialSecretPrefix
    ) {
      checks.push({
        id: `credential-${binding.mountName}`,
        status: "fail",
        message: `${binding.mountName} requires a Kubernetes data credential Secret prefix`,
      });
    }
    return {
      dataSourceId: source.id,
      sourceSite: source.governance.residencySite,
      destinationSite: inputs.target.site,
      accessMode: binding.accessMode,
      externalEgress: leavesSite,
      credentialDelivery:
        source.locator.kind === "documents"
          ? ("none" as const)
          : binding.accessMode === "attach"
            ? ("brokered" as const)
            : ("short_lived" as const),
    };
  });
  const mutatesData = definition.dataBindings.some((binding) =>
    binding.permissions.some((permission) => permission !== "read"),
  );
  const changesDataLifecycle = definition.dataBindings.some(
    (binding) => binding.accessMode !== "attach",
  );
  const destructive =
    inputs.request.environment === "production" || mutatesData || changesDataLifecycle;
  const actions = [
    ...definition.dataBindings
      .filter((binding) => binding.accessMode !== "attach")
      .map((binding) => ({
        id: `${binding.accessMode}-${binding.mountName}`,
        kind: binding.accessMode === "clone" ? ("migrate" as const) : ("create" as const),
        resourceType: "governed-data-binding",
        resourceName: binding.mountName,
        summary:
          binding.accessMode === "clone"
            ? "Create an approved bounded copy with lineage and retention"
            : "Provision isolated application-owned state",
        risk: "high" as const,
        irreversible: false,
      })),
    {
      id: inputs.currentDeployment ? "update-workload" : "create-workload",
      kind: inputs.currentDeployment ? ("update" as const) : ("create" as const),
      resourceType:
        inputs.target.kind === "kubernetes" ? "kubernetes-deployment" : "application-workload",
      resourceName: inputs.application.application.slug,
      summary: inputs.currentDeployment
        ? "Replace the running workload with this immutable bundle"
        : "Create the application workload from this immutable bundle",
      risk: destructive ? ("high" as const) : ("low" as const),
      irreversible: false,
    },
    {
      id: "verify-health",
      kind: "verify" as const,
      resourceType: "health-check",
      resourceName: inputs.bundle.manifest.health.path,
      summary: "Verify the declared health endpoint before marking the deployment running",
      risk: "low" as const,
      irreversible: false,
    },
  ];
  const runtimeIdentity =
    inputs.target.config.kind === "kubernetes"
      ? `system:serviceaccount:${inputs.target.config.namespace}:${inputs.target.config.serviceAccount}`
      : inputs.target.config.kind === "connected_machine"
        ? `connected-machine:${inputs.target.config.enrollmentId}`
        : `${inputs.target.config.provider}:${inputs.target.config.clusterId}`;
  const secretReferences =
    inputs.target.config.kind === "kubernetes"
      ? [
          ...(definition.ai.enabled && inputs.target.config.runtimeCredentialSecretPrefix
            ? [
                `${inputs.target.config.runtimeCredentialSecretPrefix}-${inputs.application.application.slug}`,
              ]
            : []),
          ...definition.dataBindings.flatMap((binding) => {
            const source = sourceById.get(binding.dataSourceId);
            return inputs.target.config.kind === "kubernetes" &&
              inputs.target.config.dataCredentialSecretPrefix &&
              source &&
              (dataSourceConnectionId(source) || binding.accessMode !== "attach")
              ? [`${inputs.target.config.dataCredentialSecretPrefix}-${binding.mountName}`]
              : [];
          }),
        ]
      : [];
  const planWithoutDigest = {
    schemaVersion: 1 as const,
    applicationId: inputs.application.application.id,
    applicationRevisionId: inputs.application.headRevision.id,
    applicationRevision: inputs.application.headRevision.revision,
    bundleId: inputs.bundle.id,
    bundleDigest: inputs.bundle.digest,
    targetId: inputs.target.id,
    targetRevision: inputs.target.revision,
    environment: inputs.request.environment,
    actions,
    dataFlows,
    runtimeIdentity,
    secretReferences,
    network: {
      policyEnforced: inputs.target.capabilities.supportsNetworkPolicy,
      allowedEgressCidrs:
        inputs.target.config.kind === "kubernetes" ? inputs.target.config.allowedEgressCidrs : [],
    },
    modelRoute: definition.ai.enabled ? definition.ai.route : ("disabled" as const),
    estimatedMonthlyCostMicros: Math.round(
      (compute.cpuMillicores * 7_500 + compute.memoryMiB * 600) * Math.max(1, compute.minReplicas),
    ),
    policyChecks: checks,
    destructive,
  };
  return InternalApplicationDeploymentPlan.parse({
    ...planWithoutDigest,
    digest: digest(planWithoutDigest),
    createdAt: now.toISOString(),
  });
}

export function resolveInternalApplicationAiSessionPolicy(
  detail: InternalApplicationDetail,
  deployments: InternalApplicationDeployment[],
  bundles: InternalApplicationBundle[],
  rawRequest: CreateInternalApplicationAiSessionRequest,
) {
  const request = CreateInternalApplicationAiSessionRequest.parse(rawRequest);
  const policy = detail.headRevision.definition.ai;
  if (detail.application.status === "archived") {
    throw new InternalApplicationProviderError(
      "Archived applications cannot start AI sessions",
      "application_archived",
      false,
    );
  }
  if (!policy.enabled || !policy.defaultModel) {
    throw new InternalApplicationProviderError(
      "Native AI is disabled for this application revision",
      "native_ai_disabled",
      false,
    );
  }
  const model = request.model ?? policy.defaultModel;
  if (!policy.allowedModels.includes(model)) {
    throw new InternalApplicationProviderError(
      "Requested model is outside the application policy",
      "model_not_allowed",
      false,
    );
  }
  const deployment = deployments.find(
    (candidate) =>
      candidate.activeBundleId !== null &&
      bundles.some(
        (bundle) =>
          bundle.id === candidate.activeBundleId &&
          bundle.applicationRevisionId === detail.headRevision.id &&
          bundle.status === "ready",
      ) &&
      ["running", "degraded", "rolled_back"].includes(candidate.status),
  );
  if (!deployment) {
    throw new InternalApplicationProviderError(
      "Native AI requires an active deployment of the current application revision",
      "active_deployment_required",
      false,
    );
  }
  const instructions = [
    `You are the native AI runtime for the internal application ${detail.application.name}.`,
    `Application revision: ${detail.application.headRevision}.`,
    `Declared capabilities: ${policy.capabilities.join(", ") || "none"}.`,
    policy.requireHumanApprovalForWrites
      ? "Any write or external side effect requires explicit human approval."
      : "Follow the application's configured side-effect policy.",
    "Use only data explicitly supplied in this session and tools explicitly selected by the platform.",
    request.instructions ?? null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");
  return { request, policy, model, deployment, instructions };
}

export async function planInternalApplicationDeployment(
  db: Database,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    request: PlanInternalApplicationDeploymentRequest;
  },
) {
  const request = PlanInternalApplicationDeploymentRequest.parse(input.request);
  const resolved = await resolveInternalApplicationPlanInputs(db, input.workspaceId, request);
  const plan = buildInternalApplicationDeploymentPlan(resolved);
  const persisted = await persistInternalApplicationDeploymentPlan(db, {
    workspaceId: input.workspaceId,
    actorSubjectId: input.actorSubjectId,
    operationId: request.operationId,
    requestHash: internalApplicationRequestHash(request),
    plan,
  });
  return InternalApplicationDeploymentActionResponse.parse({
    deployment: projectInternalApplicationDeployment(persisted.deployment),
    operation: projectInternalApplicationOperation(persisted.operation),
  });
}

export const approveInternalApplicationDeploymentPlan = approvePlanInDatabase;

async function providerInputsForPlan(
  db: Database,
  workspaceId: string,
  plan: InternalApplicationDeploymentPlan,
): Promise<InternalApplicationProviderInputs> {
  return await resolveInternalApplicationProviderInputs(db, {
    workspaceId,
    applicationId: plan.applicationId,
    bundleId: plan.bundleId,
    targetId: plan.targetId,
  });
}

function boundedProviderFailure(error: unknown) {
  if (error instanceof InternalApplicationProviderError) return error;
  return new InternalApplicationProviderError(
    "Deployment provider request failed",
    "provider_failed",
    true,
  );
}

export async function applyInternalApplicationDeployment(
  db: Database,
  provider: InternalApplicationProvider,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    request: ApplyInternalApplicationDeploymentRequest;
  },
) {
  const request = ApplyInternalApplicationDeploymentRequest.parse(input.request);
  const admitted = await beginInternalApplicationApply(db, {
    workspaceId: input.workspaceId,
    actorSubjectId: input.actorSubjectId,
    ...request,
  });
  if (admitted.replay) {
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(admitted.deployment),
      operation: projectInternalApplicationOperation(admitted.operation),
    });
  }
  try {
    const providerInput = await providerInputsForPlan(db, input.workspaceId, admitted.plan);
    const result = await provider.apply(admitted.plan, providerInput);
    const settled = await settleInternalApplicationApply(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: "succeeded",
      internalUrl: result.internalUrl,
      result: result.facts,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  } catch (rawError) {
    const error = boundedProviderFailure(rawError);
    const settled = await settleInternalApplicationApply(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: error.outcomeUnknown ? "unknown" : "failed",
      errorCode: error.code,
      errorMessage: error.message,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  }
}

export async function observeInternalApplicationDeployment(
  db: Database,
  provider: InternalApplicationProvider,
  input: {
    workspaceId: string;
    deploymentId: string;
    operationId: string;
    actorSubjectId: string;
    expectedDeploymentRevision?: number;
  },
) {
  const admitted = await beginInternalApplicationSimpleOperation(db, {
    ...input,
    kind: "observe",
  });
  if (admitted.replay)
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(admitted.deployment),
      operation: projectInternalApplicationOperation(admitted.operation),
    });
  try {
    const runtime = await resolveInternalApplicationDeploymentRuntime(
      db,
      input.workspaceId,
      input.deploymentId,
    );
    if (!runtime.bundle)
      throw new InternalApplicationProviderError(
        "Deployment has no bundle",
        "bundle_missing",
        false,
      );
    const detailInputs = await resolveInternalApplicationProviderInputs(db, {
      workspaceId: input.workspaceId,
      applicationId: runtime.deployment.applicationId,
      bundleId: runtime.bundle.id,
      targetId: runtime.target.id,
    });
    const observation = await provider.observe(runtime.deployment, detailInputs);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: "succeeded",
      observedStatus: observation.status,
      internalUrl: observation.internalUrl,
      result: observation.facts,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  } catch (rawError) {
    const error = boundedProviderFailure(rawError);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: error.outcomeUnknown ? "unknown" : "failed",
      errorCode: error.code,
      errorMessage: error.message,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  }
}

export async function reconcileInternalApplicationDeploymentOperation(
  db: Database,
  provider: InternalApplicationProvider,
  input: {
    workspaceId: string;
    operationId: string;
    actorSubjectId: string;
    request: ReconcileInternalApplicationDeploymentOperationRequest;
  },
) {
  const request = ReconcileInternalApplicationDeploymentOperationRequest.parse(input.request);
  const original = await getInternalApplicationDeploymentOperation(
    db,
    input.workspaceId,
    input.operationId,
  );
  const runtime = await resolveInternalApplicationDeploymentRuntime(
    db,
    input.workspaceId,
    original.deploymentId,
  );
  if (original.status === "completed")
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: runtime.deployment,
      operation: original,
    });
  if (original.status !== "outcome_unknown")
    throw new InternalApplicationProviderError(
      "Only an outcome-unknown provider operation can be reconciled",
      "operation_not_reconcilable",
      false,
    );
  const observation = await observeInternalApplicationDeployment(db, provider, {
    workspaceId: input.workspaceId,
    deploymentId: original.deploymentId,
    operationId: request.operationId,
    actorSubjectId: input.actorSubjectId,
    expectedDeploymentRevision: request.expectedDeploymentRevision,
  });
  const operation =
    observation.operation.status === "completed"
      ? await reconcileInternalApplicationUnknownOperation(db, {
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          observationOperationId: request.operationId,
          actorSubjectId: input.actorSubjectId,
        })
      : await getInternalApplicationDeploymentOperation(db, input.workspaceId, input.operationId);
  return InternalApplicationDeploymentActionResponse.parse({
    deployment: observation.deployment,
    operation,
  });
}

export async function rollbackInternalApplicationDeployment(
  db: Database,
  provider: InternalApplicationProvider,
  input: {
    workspaceId: string;
    deploymentId: string;
    actorSubjectId: string;
    request: RollbackInternalApplicationDeploymentRequest;
  },
) {
  const request = RollbackInternalApplicationDeploymentRequest.parse(input.request);
  const admitted = await beginInternalApplicationSimpleOperation(db, {
    workspaceId: input.workspaceId,
    deploymentId: input.deploymentId,
    operationId: request.operationId,
    kind: "rollback",
    actorSubjectId: input.actorSubjectId,
    expectedDeploymentRevision: request.expectedDeploymentRevision,
  });
  if (admitted.replay)
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(admitted.deployment),
      operation: projectInternalApplicationOperation(admitted.operation),
    });
  try {
    const runtime = await resolveInternalApplicationDeploymentRuntime(
      db,
      input.workspaceId,
      input.deploymentId,
    );
    if (!runtime.previousBundleId)
      throw new InternalApplicationProviderError(
        "Deployment has no previous bundle",
        "rollback_unavailable",
        false,
      );
    const priorInputs = await resolveInternalApplicationProviderInputs(db, {
      workspaceId: input.workspaceId,
      applicationId: runtime.deployment.applicationId,
      bundleId: runtime.previousBundleId,
      targetId: runtime.target.id,
    });
    const result = await provider.rollback(runtime.deployment, priorInputs);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: "succeeded",
      internalUrl: result.internalUrl,
      result: result.facts,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  } catch (rawError) {
    const error = boundedProviderFailure(rawError);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: error.outcomeUnknown ? "unknown" : "failed",
      errorCode: error.code,
      errorMessage: error.message,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  }
}

export async function retireInternalApplicationDeployment(
  db: Database,
  provider: InternalApplicationProvider,
  input: {
    workspaceId: string;
    deploymentId: string;
    actorSubjectId: string;
    request: RetireInternalApplicationDeploymentRequest;
  },
) {
  const request = RetireInternalApplicationDeploymentRequest.parse(input.request);
  const admitted = await beginInternalApplicationSimpleOperation(db, {
    workspaceId: input.workspaceId,
    deploymentId: input.deploymentId,
    operationId: request.operationId,
    kind: "retire",
    actorSubjectId: input.actorSubjectId,
    expectedDeploymentRevision: request.expectedDeploymentRevision,
  });
  if (admitted.replay)
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(admitted.deployment),
      operation: projectInternalApplicationOperation(admitted.operation),
    });
  try {
    const runtime = await resolveInternalApplicationDeploymentRuntime(
      db,
      input.workspaceId,
      input.deploymentId,
    );
    if (!runtime.bundle)
      throw new InternalApplicationProviderError(
        "Deployment has no active bundle",
        "bundle_missing",
        false,
      );
    const providerInputs = await resolveInternalApplicationProviderInputs(db, {
      workspaceId: input.workspaceId,
      applicationId: runtime.deployment.applicationId,
      bundleId: runtime.bundle.id,
      targetId: runtime.target.id,
      allowInactive: true,
    });
    const result = await provider.retire(runtime.deployment, providerInputs);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: "succeeded",
      internalUrl: null,
      result: result.facts,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  } catch (rawError) {
    const error = boundedProviderFailure(rawError);
    const settled = await settleInternalApplicationSimpleOperation(db, {
      workspaceId: input.workspaceId,
      operationId: request.operationId,
      actorSubjectId: input.actorSubjectId,
      outcome: error.outcomeUnknown ? "unknown" : "failed",
      errorCode: error.code,
      errorMessage: error.message,
    });
    return InternalApplicationDeploymentActionResponse.parse({
      deployment: projectInternalApplicationDeployment(settled.deployment),
      operation: projectInternalApplicationOperation(settled.operation),
    });
  }
}

export type KubernetesCredentialResolver = (input: {
  workspaceId: string;
  connectionId: string | null;
  apiServer: string;
}) => Promise<{ bearerToken: string; certificateAuthority?: string }>;

type KubernetesCredential = Awaited<ReturnType<KubernetesCredentialResolver>>;
type TlsFetchInit = RequestInit & { tls?: { ca?: string } };

export type InternalApplicationDataLifecycleCredentialResolver = (input: {
  workspaceId: string;
  connectionId: string;
  endpoint: string;
}) => Promise<{ bearerToken: string }>;

type KubernetesObject = Record<string, unknown> & {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string } & Record<string, unknown>;
};

export class KubernetesInternalApplicationProvider implements InternalApplicationProvider {
  constructor(
    private readonly resolveCredential: KubernetesCredentialResolver,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveDataLifecycleCredential?: InternalApplicationDataLifecycleCredentialResolver,
  ) {}

  async apply(plan: InternalApplicationDeploymentPlan, input: InternalApplicationProviderInputs) {
    const dataFacts = await this.applyDataLifecycle(plan.digest, input);
    return await this.applyBundle(input, dataFacts);
  }

  async rollback(
    _deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ) {
    return await this.applyBundle(input);
  }

  async retire(
    deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ) {
    const config = this.kubernetesConfig(input.target);
    const credential = await this.resolveCredential({
      workspaceId: input.application.application.workspaceId,
      connectionId: config.credentialConnectionId,
      apiServer: config.apiServer,
    });
    const resources = this.resources(input, config).reverse();
    const dataFacts = await this.retireDataLifecycle(deployment.id, input);
    let deleted = 0;
    let absent = 0;
    for (const resource of resources) {
      const outcome = await this.deleteResource(config.apiServer, credential, resource);
      if (outcome === "deleted") deleted += 1;
      else absent += 1;
    }
    return {
      internalUrl: null,
      facts: {
        provider: "kubernetes",
        namespace: config.namespace,
        resourcesDeleted: deleted,
        resourcesAlreadyAbsent: absent,
        ...dataFacts,
      },
    };
  }

  async observe(
    deployment: InternalApplicationDeployment,
    input: InternalApplicationProviderInputs,
  ) {
    const config = this.kubernetesConfig(input.target);
    const credential = await this.resolveCredential({
      workspaceId: input.application.application.workspaceId,
      connectionId: config.credentialConnectionId,
      apiServer: config.apiServer,
    });
    const name = input.application.application.slug;
    const response = await this.fetchImpl(
      `${config.apiServer.replace(/\/$/u, "")}/apis/apps/v1/namespaces/${encodeURIComponent(config.namespace)}/deployments/${encodeURIComponent(name)}`,
      {
        headers: {
          authorization: `Bearer ${credential.bearerToken}`,
          accept: "application/json",
        },
        ...(credential.certificateAuthority
          ? { tls: { ca: credential.certificateAuthority } }
          : {}),
      } as TlsFetchInit,
    );
    if (!response.ok) throw await this.providerHttpError(response, "observe");
    const value = (await response.json()) as {
      metadata?: {
        uid?: string;
        generation?: number;
        annotations?: Record<string, string>;
      };
      spec?: { replicas?: number };
      status?: {
        availableReplicas?: number;
        replicas?: number;
        readyReplicas?: number;
        updatedReplicas?: number;
        unavailableReplicas?: number;
        observedGeneration?: number;
        conditions?: Array<{ type?: string; status?: string; reason?: string }>;
      };
    };
    const desired =
      value.spec?.replicas ?? input.application.headRevision.definition.compute.minReplicas;
    const available = value.status?.availableReplicas ?? 0;
    const ready = value.status?.readyReplicas ?? 0;
    const updated = value.status?.updatedReplicas ?? 0;
    const unavailable = value.status?.unavailableReplicas ?? 0;
    const generation = value.metadata?.generation;
    const observedGeneration = value.status?.observedGeneration;
    const appliedBundleDigest = value.metadata?.annotations?.["opengeni.ai/bundle-digest"];
    const drifted =
      typeof appliedBundleDigest === "string" && appliedBundleDigest !== input.bundle.digest;
    const progressing = value.status?.conditions?.find(
      (condition) => condition.type === "Progressing",
    );
    const availableCondition = value.status?.conditions?.find(
      (condition) => condition.type === "Available",
    );
    const rolloutCurrent =
      generation === undefined ||
      (observedGeneration !== undefined && observedGeneration >= generation);
    const rolloutHealthy =
      rolloutCurrent &&
      available >= desired &&
      ready >= desired &&
      updated >= desired &&
      unavailable === 0 &&
      !drifted;
    const rolloutFailed =
      progressing?.status === "False" && progressing.reason === "ProgressDeadlineExceeded";
    return {
      status: rolloutFailed
        ? ("failed" as const)
        : rolloutHealthy
          ? ("running" as const)
          : ("degraded" as const),
      internalUrl: deployment.internalUrl,
      facts: {
        provider: "kubernetes",
        namespace: config.namespace,
        resourceName: name,
        desiredReplicas: desired,
        availableReplicas: available,
        readyReplicas: ready,
        updatedReplicas: updated,
        unavailableReplicas: unavailable,
        rolloutCurrent,
        drifted,
        ...(value.metadata?.uid ? { providerResourceId: value.metadata.uid } : {}),
        ...(value.metadata?.generation !== undefined
          ? { generation: value.metadata.generation }
          : {}),
        ...(value.status?.observedGeneration !== undefined
          ? { observedGeneration: value.status.observedGeneration }
          : {}),
        ...(appliedBundleDigest ? { observedBundleDigest: appliedBundleDigest } : {}),
        ...(progressing?.status ? { progressing: progressing.status } : {}),
        ...(progressing?.reason ? { progressingReason: progressing.reason } : {}),
        ...(availableCondition?.status ? { availableCondition: availableCondition.status } : {}),
        ...(availableCondition?.reason ? { availableReason: availableCondition.reason } : {}),
      },
    };
  }

  private async applyBundle(
    input: InternalApplicationProviderInputs,
    dataFacts: Record<string, string | number | boolean> = {},
  ) {
    const config = this.kubernetesConfig(input.target);
    const credential = await this.resolveCredential({
      workspaceId: input.application.application.workspaceId,
      connectionId: config.credentialConnectionId,
      apiServer: config.apiServer,
    });
    const resources = this.resources(input, config);
    for (const resource of resources)
      await this.serverSideApply(config.apiServer, credential, resource);
    const host = `${input.application.application.slug}.${config.internalDomain}`;
    const internalUrl = `https://${host}`;
    const rollout = await this.waitForRollout(input, internalUrl);
    return {
      internalUrl,
      facts: {
        provider: "kubernetes",
        namespace: config.namespace,
        resourcesApplied: resources.length,
        ...rollout.facts,
        ...dataFacts,
      },
    };
  }

  private async waitForRollout(
    input: InternalApplicationProviderInputs,
    internalUrl: string,
  ): Promise<InternalApplicationObservation> {
    const now = new Date().toISOString();
    const probe: InternalApplicationDeployment = {
      schemaVersion: 1,
      id: input.application.application.id,
      applicationId: input.application.application.id,
      environment: input.target.environment,
      targetId: input.target.id,
      targetRevision: input.target.revision,
      activeBundleId: input.bundle.id,
      desiredBundleId: input.bundle.id,
      status: "deploying",
      internalUrl,
      revision: 1,
      lastObservedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const deadline = Date.now() + 120_000;
    while (true) {
      try {
        const observation = await this.observe(probe, input);
        if (observation.status === "running") return observation;
        if (observation.status === "failed")
          throw new InternalApplicationProviderError(
            "Kubernetes rollout reached a terminal failure",
            "kubernetes_rollout_failed",
            false,
          );
      } catch (error) {
        if (error instanceof InternalApplicationProviderError && error.code !== "kubernetes_404")
          throw error;
      }
      if (Date.now() >= deadline)
        throw new InternalApplicationProviderError(
          "Kubernetes rollout did not reach current healthy state before the deadline",
          "kubernetes_rollout_timeout",
          true,
        );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  private async applyDataLifecycle(
    planDigest: string,
    input: InternalApplicationProviderInputs,
  ): Promise<Record<string, string | number | boolean>> {
    const bindings = input.application.headRevision.definition.dataBindings.filter(
      (binding) => binding.accessMode !== "attach",
    );
    if (bindings.length === 0) return {};
    return await this.callDataLifecycleBroker("apply", planDigest, input, bindings);
  }

  private async retireDataLifecycle(
    deploymentId: string,
    input: InternalApplicationProviderInputs,
  ): Promise<Record<string, string | number | boolean>> {
    const bindings = input.application.headRevision.definition.dataBindings.filter(
      (binding) => binding.accessMode !== "attach",
    );
    if (bindings.length === 0) return {};
    return await this.callDataLifecycleBroker("retire", deploymentId, input, bindings);
  }

  private async callDataLifecycleBroker(
    action: "apply" | "retire",
    idempotencyKey: string,
    input: InternalApplicationProviderInputs,
    bindings: InternalApplicationDetail["headRevision"]["definition"]["dataBindings"],
  ): Promise<Record<string, string | number | boolean>> {
    const config = this.kubernetesConfig(input.target);
    const broker = config.dataLifecycleBroker;
    if (!broker || !this.resolveDataLifecycleCredential)
      throw new InternalApplicationProviderError(
        "Target data-lifecycle broker is unavailable",
        "data_lifecycle_broker_unavailable",
        false,
      );
    for (const binding of bindings)
      if (!broker.supportedModes.includes(binding.accessMode as "clone" | "provision"))
        throw new InternalApplicationProviderError(
          `Data lifecycle mode ${binding.accessMode} is not supported by this target`,
          "data_lifecycle_mode_unsupported",
          false,
        );
    const credential = await this.resolveDataLifecycleCredential({
      workspaceId: input.application.application.workspaceId,
      connectionId: broker.credentialConnectionId,
      endpoint: broker.endpoint,
    });
    const sourceById = new Map(input.dataSources.map((source) => [source.id, source]));
    const response = await this.fetchImpl(
      `${broker.endpoint.replace(/\/$/u, "")}/v1/bindings/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: stableJson({
          schemaVersion: 1,
          action,
          application: {
            id: input.application.application.id,
            revision: input.application.application.headRevision,
            definitionHash: input.application.application.definitionHash,
          },
          target: {
            id: input.target.id,
            revision: input.target.revision,
            environment: input.target.environment,
            site: input.target.site,
            namespace: config.namespace,
          },
          bindings: bindings.map((binding) => {
            const source = sourceById.get(binding.dataSourceId);
            if (!source)
              throw new InternalApplicationProviderError(
                `Data binding ${binding.mountName} was not resolved`,
                "data_binding_missing",
                false,
              );
            return {
              sourceId: source.id,
              sourceRevision: source.revision,
              kind: source.kind,
              locator: credentialFreeLocator(source),
              schemaDefinition: source.schemaDefinition,
              governance: source.governance,
              mountName: binding.mountName,
              accessMode: binding.accessMode,
              permissions: binding.permissions,
              runtimeSecretName: config.dataCredentialSecretPrefix
                ? `${config.dataCredentialSecretPrefix}-${binding.mountName}`
                : null,
            };
          }),
        }),
      },
    ).catch((error) => {
      throw new InternalApplicationProviderError(
        `Data lifecycle broker ${action} transport failed: ${error instanceof Error ? error.message : String(error)}`,
        "data_lifecycle_transport",
        true,
      );
    });
    if (!response.ok) {
      const definite = response.status >= 400 && response.status < 500;
      throw new InternalApplicationProviderError(
        `Data lifecycle broker ${action} failed with HTTP ${response.status}`,
        `data_lifecycle_${response.status}`,
        !definite,
      );
    }
    const result = (await response.json()) as {
      auditDigest?: unknown;
      bindingsProcessed?: unknown;
    };
    if (
      typeof result.auditDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(result.auditDigest) ||
      typeof result.bindingsProcessed !== "number" ||
      !Number.isInteger(result.bindingsProcessed) ||
      result.bindingsProcessed !== bindings.length
    )
      throw new InternalApplicationProviderError(
        "Data lifecycle broker returned invalid evidence",
        "data_lifecycle_invalid_evidence",
        false,
      );
    return {
      dataLifecycleAction: action,
      dataLifecycleBindings: result.bindingsProcessed,
      dataLifecycleAuditDigest: result.auditDigest,
    };
  }

  private kubernetesConfig(target: InternalApplicationDeploymentTarget) {
    if (target.kind !== "kubernetes" || target.config.kind !== "kubernetes")
      throw new InternalApplicationProviderError(
        "Only Kubernetes targets are supported by this provider",
        "unsupported_target",
        false,
      );
    return target.config;
  }

  private resources(
    input: InternalApplicationProviderInputs,
    config: Extract<InternalApplicationDeploymentTarget["config"], { kind: "kubernetes" }>,
  ): KubernetesObject[] {
    const app = input.application.application;
    const definition = input.application.headRevision.definition;
    const name = app.slug;
    const labels = {
      "app.kubernetes.io/name": name,
      "app.kubernetes.io/managed-by": "opengeni",
      "opengeni.ai/application-id": app.id,
    };
    const image = input.bundle.manifest.image.reference.includes("@")
      ? input.bundle.manifest.image.reference
      : `${input.bundle.manifest.image.reference}@${input.bundle.manifest.image.digest}`;
    const runtimeUrl = config.runtimeApiUrl;
    const sourceById = new Map(input.dataSources.map((source) => [source.id, source]));
    const dataBindings = definition.dataBindings.map((binding) => {
      const source = sourceById.get(binding.dataSourceId);
      if (!source) {
        throw new InternalApplicationProviderError(
          `Data binding ${binding.mountName} was not resolved`,
          "data_binding_missing",
          false,
        );
      }
      return {
        dataSourceId: binding.dataSourceId,
        mountName: binding.mountName,
        accessMode: binding.accessMode,
        permissions: binding.permissions,
        kind: source.kind,
        locator: credentialFreeLocator(source),
        credentialEnvironmentPrefix: binding.mountName.replaceAll("-", "_").toUpperCase(),
      };
    });
    const environment: Array<Record<string, unknown>> = [
      { name: "OPENGENI_INTERNAL_APPLICATION_ID", value: app.id },
      { name: "OPENGENI_WORKSPACE_ID", value: app.workspaceId },
      { name: "OPENGENI_RUNTIME_URL", value: runtimeUrl },
      {
        name: "OPENGENI_AI_ROUTE",
        value: definition.ai.enabled ? definition.ai.route : "disabled",
      },
      {
        name: "OPENGENI_AI_DEFAULT_MODEL",
        value: definition.ai.defaultModel ?? "",
      },
      { name: "OPENGENI_DATA_BINDINGS_JSON", value: stableJson(dataBindings) },
    ];
    if (definition.ai.enabled && config.runtimeCredentialSecretPrefix) {
      environment.push({
        name: "OPENGENI_API_KEY",
        valueFrom: {
          secretKeyRef: {
            name: `${config.runtimeCredentialSecretPrefix}-${name}`,
            key: "apiKey",
          },
        },
      });
    }
    const dataCredentialSecretNames = definition.dataBindings.flatMap((binding) => {
      const source = sourceById.get(binding.dataSourceId);
      if (
        !source ||
        (!dataSourceConnectionId(source) && binding.accessMode === "attach") ||
        !config.dataCredentialSecretPrefix
      )
        return [];
      return [`${config.dataCredentialSecretPrefix}-${binding.mountName}`];
    });
    const deployment: KubernetesObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name,
        namespace: config.namespace,
        labels,
        annotations: {
          "opengeni.ai/bundle-digest": input.bundle.digest,
          "opengeni.ai/definition-hash": app.definitionHash,
        },
      },
      spec: {
        replicas: definition.compute.minReplicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: config.serviceAccount,
            containers: [
              {
                name: "application",
                image,
                imagePullPolicy: "IfNotPresent",
                command: input.bundle.manifest.runtime.command,
                workingDir: input.bundle.manifest.runtime.workingDirectory,
                ports: definition.routes.map((route) => ({
                  name: route.name,
                  containerPort: route.port,
                })),
                env: environment,
                ...(dataCredentialSecretNames.length > 0
                  ? {
                      envFrom: dataCredentialSecretNames.map((secretName) => ({
                        secretRef: { name: secretName },
                      })),
                    }
                  : {}),
                resources: {
                  requests: {
                    cpu: `${definition.compute.cpuMillicores}m`,
                    memory: `${definition.compute.memoryMiB}Mi`,
                  },
                  limits: {
                    cpu: `${definition.compute.cpuMillicores}m`,
                    memory: `${definition.compute.memoryMiB}Mi`,
                  },
                },
                readinessProbe: {
                  httpGet: {
                    path: input.bundle.manifest.health.path,
                    port: input.bundle.manifest.health.port,
                  },
                  periodSeconds: 5,
                  failureThreshold: 12,
                },
                livenessProbe: {
                  httpGet: {
                    path: input.bundle.manifest.health.path,
                    port: input.bundle.manifest.health.port,
                  },
                  periodSeconds: 10,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    };
    const primaryRoute = definition.routes[0]!;
    const service: KubernetesObject = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: config.namespace, labels },
      spec: {
        selector: labels,
        ports: definition.routes.map((route) => ({
          name: route.name,
          port: route.port,
          targetPort: route.port,
        })),
      },
    };
    const resources = [deployment, service];
    if (config.ingressClass && input.target.capabilities.supportsInternalIngress)
      resources.push({
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { name, namespace: config.namespace, labels },
        spec: {
          ingressClassName: config.ingressClass,
          rules: [
            {
              host: `${name}.${config.internalDomain}`,
              http: {
                paths: [
                  {
                    path: primaryRoute.path,
                    pathType: "Prefix",
                    backend: {
                      service: { name, port: { number: primaryRoute.port } },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    if (input.target.capabilities.supportsNetworkPolicy)
      resources.push({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name, namespace: config.namespace, labels },
        spec: {
          podSelector: { matchLabels: labels },
          policyTypes: ["Ingress", "Egress"],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      "kubernetes.io/metadata.name": config.namespace,
                    },
                  },
                },
                ...(config.ingressNamespace
                  ? [
                      {
                        namespaceSelector: {
                          matchLabels: {
                            "kubernetes.io/metadata.name": config.ingressNamespace,
                          },
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
          egress: [
            {
              to: [
                { namespaceSelector: {} },
                ...config.allowedEgressCidrs.map((cidr) => ({
                  ipBlock: { cidr },
                })),
              ],
            },
          ],
        },
      });
    return resources;
  }

  private async serverSideApply(
    apiServer: string,
    credential: KubernetesCredential,
    resource: KubernetesObject,
  ) {
    const url = `${this.resourceUrl(apiServer, resource)}?fieldManager=opengeni-internal-apps&force=true`;
    const response = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${credential.bearerToken}`,
        "content-type": "application/apply-patch+yaml",
        accept: "application/json",
      },
      body: JSON.stringify(resource),
      ...(credential.certificateAuthority ? { tls: { ca: credential.certificateAuthority } } : {}),
    } as TlsFetchInit);
    if (!response.ok) throw await this.providerHttpError(response, `apply ${resource.kind}`);
  }

  private async deleteResource(
    apiServer: string,
    credential: KubernetesCredential,
    resource: KubernetesObject,
  ) {
    const response = await this.fetchImpl(this.resourceUrl(apiServer, resource), {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${credential.bearerToken}`,
        accept: "application/json",
      },
      ...(credential.certificateAuthority ? { tls: { ca: credential.certificateAuthority } } : {}),
    } as TlsFetchInit);
    if (response.status === 404) return "absent" as const;
    if (!response.ok) throw await this.providerHttpError(response, `delete ${resource.kind}`);
    return "deleted" as const;
  }

  private resourceUrl(apiServer: string, resource: KubernetesObject) {
    const group = resource.apiVersion === "v1" ? "api/v1" : `apis/${resource.apiVersion}`;
    const plural =
      resource.kind === "Deployment"
        ? "deployments"
        : resource.kind === "Service"
          ? "services"
          : resource.kind === "Ingress"
            ? "ingresses"
            : "networkpolicies";
    return `${apiServer.replace(/\/$/u, "")}/${group}/namespaces/${encodeURIComponent(resource.metadata.namespace)}/${plural}/${encodeURIComponent(resource.metadata.name)}`;
  }

  private async providerHttpError(response: Response, action: string) {
    const definite = response.status >= 400 && response.status < 500;
    return new InternalApplicationProviderError(
      `Kubernetes ${action} failed with HTTP ${response.status}`,
      `kubernetes_${response.status}`,
      !definite,
    );
  }
}
