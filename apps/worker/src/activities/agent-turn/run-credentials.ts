import { getSessionRootId, resolvePrReviewGitCredential } from "@opengeni/db";
import { prReviewRegistrationIdFromCredentialBinding } from "@opengeni/core";
import {
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  refreshGitCredentialBindingTokenFiles,
  refreshCodemodeTokenFile,
  codemodeTokenFileFromEnvironment,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
} from "@opengeni/runtime";
import { codemodeWorkspaceUrl, type Settings } from "@opengeni/config";
import {
  assertGitCredentialRenewalTransportUnchanged,
  gitCredentialAuthorityForTurn,
  mintSandboxCodemodeToken,
  mintRunGitCredentials,
  mintRunGitCredentialBinding,
  sandboxEnvironmentForRun,
  type GitHubTokenMintAuthorization,
  type MintedRunGitCredentials,
  type loadWorkspaceEnvironmentForRunWithCredentials,
} from "../environment";
import type { mergeResourceRefs } from "../common";
import { startGitCredentialRenewalLoop } from "../git-credential-renewal";
import {
  RUN_CREDENTIAL_EXPIRY_LEAD_MS,
  startRunCredentialRenewalLoop,
} from "../run-credential-renewal";
import {
  CODEMODE_TOKEN_EXPIRY_LEAD_MS,
  startCodemodeTokenRenewalLoop,
} from "../codemode-token-renewal";
import {
  bindRunCredentialResolver,
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
} from "../run-credentials";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import { type ResumedTurnSandbox } from "../../sandbox-resume";
import { lazyProvisionEnabled } from "../../sandbox-routing";
import { recordTurnSandboxEstablishPolicy } from "../../observability-metrics";
import { sandboxRunAs } from "@opengeni/runtime";

import {
  assertGitHubResourcesRemainAuthorized,
  assertFileResourcesRemainAuthorized,
  assertGitHubTokenMintSelectionAuthorized,
  requiresSignedFileResourceDownloads,
} from "./file-resources";
import { throwIfTurnOperationCancelled, waitForTurnOperation } from "./sandbox-provision";
import {
  sandboxEstablishPolicyDecision,
  ensureTurnModalRegistryImage,
  sandboxArtifactRuntimeAdmission,
} from "./sandbox-route";
import type { ClaimTurnOk } from "./claim";
import type { GovernanceModelOk } from "./governance-model";
import type { SandboxTurnRuntime } from "./sandbox-runtime";
import type {
  AttemptIdentityState,
  EventingState,
  RenewalState,
  SandboxRuntimeState,
} from "./turn-context";

export type PrepareRunCredentialsDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  connectionCredentials: ActivityServices["connectionCredentials"];
  personalGitHubCredentials: ActivityServices["personalGitHubCredentials"];
  eventing: EventingState;
  attempt: AttemptIdentityState;
  renewals: RenewalState;
  sandboxState: SandboxRuntimeState;
  sandboxRuntime: SandboxTurnRuntime;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  runSettings: GovernanceModelOk["runSettings"];
  workspaceVariableSet: Awaited<ReturnType<typeof loadWorkspaceEnvironmentForRunWithCredentials>>;
  turnResources: ReturnType<typeof mergeResourceRefs>;
  requiredGeneratedVideoFiles: Array<{
    operationId: string;
    artifactId: string;
    fileId: string;
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    filename: string;
  }>;
  machinePrimary: boolean;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  groupBoxBackend: Settings["sandboxBackend"];
  sandboxCreationBackend: Settings["sandboxBackend"];
  effectiveRunCredentialBackend: Settings["sandboxBackend"];
  sandboxWorkspaceEnvironmentValues: Record<string, string>;
  connectionScope: { accountId: string; workspaceId: string };
  runWorkspaceMutationForSandbox: SandboxTurnRuntime["runWorkspaceMutationForSandbox"];
};

export async function prepareRunCredentials(deps: PrepareRunCredentialsDeps) {
  const {
    input,
    settings,
    db,
    observability,
    cancellationSignal,
    connectionCredentials,
    personalGitHubCredentials,
    eventing,
    attempt,
    renewals,
    sandboxState,
    turn,
    session,
    fileAuthoritySubjectId,
    runSettings,
    workspaceVariableSet,
    turnResources,
    requiredGeneratedVideoFiles,
    machinePrimary,
    activeSandboxBackend,
    groupBoxBackend,
    sandboxCreationBackend,
    effectiveRunCredentialBackend,
    sandboxWorkspaceEnvironmentValues,
    connectionScope,
    runWorkspaceMutationForSandbox,
  } = deps;

  const runCredentialResolver =
    effectiveRunCredentialBackend === "none"
      ? null
      : await waitForTurnOperation(
          bindRunCredentialResolver({
            db,
            connectionCredentials: connectionCredentials ?? null,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            session,
            turn,
            attemptId: input.attemptId,
            effectiveSandboxBackend: effectiveRunCredentialBackend,
            variableSet: workspaceVariableSet
              ? {
                  id: workspaceVariableSet.id,
                  name: workspaceVariableSet.name,
                }
              : null,
          }),
          cancellationSignal,
          undefined,
        );
  const establishDecision = sandboxEstablishPolicyDecision({
    lazyEnabled: lazyProvisionEnabled(settings),
    machinePrimary,
    sandboxBackend: runSettings.sandboxBackend,
    hasRunCredentialResolver: runCredentialResolver !== null,
    generatedVideoFileCount: requiredGeneratedVideoFiles.length,
    hasSignedFileResources:
      requiresSignedFileResourceDownloads(runSettings, activeSandboxBackend ?? groupBoxBackend) &&
      turn.resources.some((resource) => resource.kind === "file"),
  });
  const establishPolicy = establishDecision.policy;
  recordTurnSandboxEstablishPolicy(observability, {
    policy: establishDecision.policy,
    reason: establishDecision.reason,
    backend: machinePrimary ? "selfhosted" : groupBoxBackend,
  });
  // Resolve once before model preparation so partial/auth-needed host state
  // is available as bounded model context and reconnect UI even when an
  // on-demand turn never provisions a box. Resolution alone performs no
  // sandbox write or renewal; both paths reuse this exact material and the
  // lazy path materializes it only inside its first-operation single-flight.
  const initialRunCredentialMaterial = runCredentialResolver
    ? await waitForTurnOperation(
        runCredentialResolver.resolve({
          purpose: "provision",
          forceRefresh: false,
        }),
        cancellationSignal,
        undefined,
      )
    : null;
  if (initialRunCredentialMaterial) {
    for (const payload of runCredentialAuthNeededPayloads(initialRunCredentialMaterial)) {
      renewals.publishedRunCredentialNotices.add(JSON.stringify(payload));
      await eventing.publish!([{ type: "credential.auth_needed", payload }], true);
    }
  }
  const runCredentialsNote = initialRunCredentialMaterial
    ? runCredentialModelNote(initialRunCredentialMaterial)
    : undefined;
  throwIfTurnOperationCancelled(cancellationSignal);
  const authorizeGitHubTokenMint: GitHubTokenMintAuthorization = async (selection) => {
    const registrationId = prReviewRegistrationIdFromCredentialBinding(
      selection.credentialBindingId,
    );
    if (registrationId) {
      await resolvePrReviewGitCredential(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        registrationId,
        provider: "github",
        sessionId: input.sessionId,
        rootSessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration: turn.executionGeneration,
        repositoryRefs: selection.repositoryRefs.map((reference) => ({
          uri: reference.uri,
          ...(reference.expectedCommitSha !== undefined
            ? { expectedCommitSha: reference.expectedCommitSha }
            : {}),
          ...(reference.repositoryId !== undefined ? { repositoryId: reference.repositoryId } : {}),
          ...(reference.installationId !== undefined
            ? { installationId: reference.installationId }
            : {}),
          ...(reference.projectId !== undefined ? { projectId: reference.projectId } : {}),
        })),
      });
      return;
    }
    await assertGitHubTokenMintSelectionAuthorized(
      db,
      input.workspaceId,
      selection.installationId,
      selection.repositoryIds,
    );
  };
  await Promise.all([
    waitForTurnOperation(
      ensureTurnModalRegistryImage(runSettings, sandboxCreationBackend),
      cancellationSignal,
      undefined,
    ),
    activeSandboxBackend !== "selfhosted"
      ? assertGitHubResourcesRemainAuthorized(
          db,
          input.workspaceId,
          turnResources,
          authorizeGitHubTokenMint,
        )
      : Promise.resolve(),
    assertFileResourcesRemainAuthorized(
      db,
      input.accountId,
      input.workspaceId,
      fileAuthoritySubjectId,
      turn.resources,
    ),
  ]);
  // Computed exactly ONCE per turn and reused for BOTH the box manifest
  // (resumeBoxForTurn -> establishSandboxSessionFromEnvelope, below) AND the
  // agent (runtime.buildAgent, below). sandboxEnvironmentForRun mints a FRESH
  // run-scoped git provider tokens on every call, so a second call would
  // yield DIFFERENT token values and re-introduce the manifest-env delta the
  // SDK's provided-session guard throws on — the box and the agent MUST share
  // this same object. A machine-primary turn skips the (inert) token mint entirely
  // (the machine uses its own git creds); the SAME base env still feeds the box +
  // the agent, so env-parity holds.
  // TOKEN-BROKER (B1): sandboxEnvironmentForRun now returns the STABLE manifest
  // env (no rotating GH_TOKEN/GITHUB_TOKEN/GIT_CONFIG_* extraheader) PLUS the
  // run-scoped git tokens minted ONCE per turn as provider seeds, with `gitToken`
  // retained as the GitHub alias. The env feeds BOTH the box manifest AND the
  // agent (env-parity, as before); tokens are threaded OFF-MANIFEST as
  // clone-seeds to buildAgent (below) so the box never carries rotating values
  // on its manifest. When a platform token IS minted, the host `gitCredentials`
  // provider may supply it; unset still self-mints GitHub from settings.
  // gitToken/gitTokens are undefined on the selfhosted skip path (the machine
  // uses its own git creds).
  // Git and MCP credentials share one lineage snapshot for this turn. A
  // host that supplies both ports must never see two independently resolved
  // roots for the same execution merely because the call sites are far apart.
  const needsHostCredentialRoot = Boolean(
    connectionCredentials?.gitCredentials ||
    personalGitHubCredentials ||
    connectionCredentials?.mcpCredentials,
  );
  const hostCredentialRootSessionId = needsHostCredentialRoot
    ? await getSessionRootId(db, input.workspaceId, input.sessionId)
    : null;
  if (needsHostCredentialRoot && !hostCredentialRootSessionId) {
    throw new Error(`cannot resolve host credentials for missing session ${input.sessionId}`);
  }
  const gitCredentialAuthority =
    (connectionCredentials?.gitCredentials || personalGitHubCredentials) &&
    hostCredentialRootSessionId
      ? gitCredentialAuthorityForTurn({
          sessionId: input.sessionId,
          rootSessionId: hostCredentialRootSessionId,
          attemptId: input.attemptId,
          turn,
        })
      : undefined;
  const codemodeAuthority = {
    sessionId: input.sessionId,
    turnId: turn.id,
    attemptId: input.attemptId,
    executionGeneration: turn.executionGeneration,
  };
  const sandboxArtifactRuntime = sandboxArtifactRuntimeAdmission(
    settings,
    runSettings,
    activeSandboxBackend ?? groupBoxBackend,
  );
  const {
    environment: baseSandboxEnvironment,
    gitToken: sandboxGitToken,
    gitTokens: sandboxGitTokens,
    gitTokenExpiresAt: sandboxGitTokenExpiresAt,
    gitCredentialBindings: sandboxGitCredentialBindings,
    codemodeToken: sandboxCodemodeToken,
    codemodeTokenExpiresAt: sandboxCodemodeTokenExpiresAt,
  } = await waitForTurnOperation(
    sandboxEnvironmentForRun(
      runSettings,
      turnResources,
      // Rig default sets merged BELOW the session set (session wins); rig-less
      // turns pass exactly workspaceVariableSet?.values (byte-for-byte today).
      sandboxWorkspaceEnvironmentValues,
      {
        skipGitHubToken: activeSandboxBackend === "selfhosted",
        codemodeDelivery: activeSandboxBackend === "selfhosted" ? "transient_exec" : "managed_file",
        deferGitHubToken: activeSandboxBackend !== "selfhosted" && establishPolicy === "on-demand",
        scope: connectionScope,
        ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
        gitCredentials: connectionCredentials?.gitCredentials,
        personalGitHubCredentials: personalGitHubCredentials ?? undefined,
        authorizeGitHubTokenMint,
        codemodeAuthority,
      },
    ),
    cancellationSignal,
    undefined,
  );
  // Reserved, image-owned paths win over workspace/session variables. The
  // exact same merged object feeds both box manifest and agent declaration,
  // preserving the no-environment-delta invariant.
  const sandboxEnvironment = sandboxArtifactRuntime.available
    ? { ...baseSandboxEnvironment, ...sandboxArtifactRuntime.environment }
    : baseSandboxEnvironment;

  // One mutable in-memory bearer cell serves every Connected Machine route
  // in this attempt. SelfhostedSession snapshots it into each exact exec
  // request; it never enters the manifest, argv, filesystem, RunState, or
  // serialized session state. Managed renewal updates the same cell so a
  // later mid-turn swap sees the fresh bearer too.
  const codemodeTokenState = sandboxCodemodeToken ? { token: sandboxCodemodeToken } : undefined;
  const transientCodemodeEnvironment = codemodeTokenState
    ? (): Readonly<Record<string, string>> => ({
        OPENGENI_CODEMODE_URL: codemodeWorkspaceUrl(runSettings, input.workspaceId),
        OPENGENI_CODEMODE_TOKEN: codemodeTokenState.token,
        ...(runSettings.ogtoolPackageSpec
          ? { OPENGENI_OGTOOL_PACKAGE_SPEC: runSettings.ogtoolPackageSpec }
          : {}),
      })
    : undefined;

  const sandboxCodemodeTokenFile = sandboxCodemodeToken
    ? codemodeTokenFileFromEnvironment(sandboxEnvironment, input.sessionId)
    : undefined;

  const initialGitCredentials: MintedRunGitCredentials | undefined = sandboxGitCredentialBindings
    ? {
        bindings: sandboxGitCredentialBindings,
        gitTokens: sandboxGitTokens ?? {},
        expiresAt: sandboxGitTokenExpiresAt ?? {},
      }
    : undefined;
  // Lazy cloud provision mints the run-scoped git token while Modal create
  // runs. Chat-only turns never call get(), so this stays unstarted there.
  let runGitCredentialsMint: Promise<MintedRunGitCredentials | undefined> | undefined;
  const startRunGitCredentialsMint = (): Promise<MintedRunGitCredentials | undefined> => {
    if (activeSandboxBackend === "selfhosted") {
      return Promise.resolve(undefined);
    }
    runGitCredentialsMint ??= waitForTurnOperation(
      mintRunGitCredentials(runSettings, turnResources, {
        scope: connectionScope,
        ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
        gitCredentials: connectionCredentials?.gitCredentials,
        personalGitHubCredentials: personalGitHubCredentials ?? undefined,
        authorizeGitHubTokenMint,
      }),
      cancellationSignal,
      undefined,
    );
    return runGitCredentialsMint;
  };
  const attachGitCredentialRenewal = async (
    tokenSession: GitCredentialTokenWriterSession,
    initial: MintedRunGitCredentials | undefined,
    initialSandbox?: ResumedTurnSandbox,
  ): Promise<void> => {
    if (!initial || initial.bindings.length === 0) return;
    const previous = renewals.gitCredentialRenewals;
    renewals.gitCredentialRenewals = [];
    await Promise.all(previous.map(async (controller) => await controller.stop()));
    if (renewals.gitCredentialRenewalClosed) return;

    const controllers = initial.bindings.map((initialBinding) => {
      let pendingBinding: typeof initialBinding | undefined;
      return startGitCredentialRenewalLoop({
        expectedProviders: [initialBinding.provider],
        ...(initialBinding.transport?.kind === "http_broker" ? { expiryLeadMs: 60_000 } : {}),
        initialExpiresAt: initialBinding.expiresAt
          ? { [initialBinding.provider]: initialBinding.expiresAt }
          : {},
        mint: async () => {
          const binding = await mintRunGitCredentialBinding(
            runSettings,
            turnResources,
            initialBinding.provider,
            initialBinding.credentialBindingId,
            {
              scope: connectionScope,
              ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
              gitCredentials: connectionCredentials?.gitCredentials,
              personalGitHubCredentials: personalGitHubCredentials ?? undefined,
              authorizeGitHubTokenMint,
            },
          );
          if (binding) {
            assertGitCredentialRenewalTransportUnchanged(initialBinding, binding);
          }
          pendingBinding = binding;
          return binding
            ? {
                bindings: [binding],
                gitTokens: { [binding.provider]: binding.token },
                expiresAt: binding.expiresAt ? { [binding.provider]: binding.expiresAt } : {},
              }
            : undefined;
        },
        write: async () => {
          if (!pendingBinding) {
            throw new Error("credential renewal produced no binding token");
          }
          const runAs = sandboxRunAs(runSettings);
          const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
          if (!targetSandbox) {
            throw new Error("Git credential renewal has no exact sandbox lease target");
          }
          await runWorkspaceMutationForSandbox(
            targetSandbox,
            "gitCredentialRenewal",
            async () =>
              await refreshGitCredentialBindingTokenFiles(tokenSession, [pendingBinding!], {
                ...(runAs ? { runAs } : {}),
                ...(eventing.toolCancellationFenceRef.current
                  ? {
                      commandRunner:
                        eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                          eventing.toolCancellationFenceRef.current,
                        ),
                    }
                  : {}),
              }),
          );
        },
        onSuccess: ({ providers: renewedProviders }) => {
          for (const provider of renewedProviders) {
            observability.incrementCounter({
              name: "opengeni_git_credential_renewals_total",
              help: "Host-managed Git credential renewal attempts by provider and outcome.",
              labels: { provider, outcome: "completed" },
            });
          }
        },
        onFailure: ({ providers: failedProviders, retryDelayMs, errorClass }) => {
          for (const provider of failedProviders) {
            observability.incrementCounter({
              name: "opengeni_git_credential_renewals_total",
              help: "Host-managed Git credential renewal attempts by provider and outcome.",
              labels: { provider, outcome: "error" },
            });
          }
          observability.warn("Sandbox Git credential renewal failed; retry scheduled", {
            sessionId: input.sessionId,
            turnId: attempt.turnId,
            providers: failedProviders.join(","),
            errorClass,
            retryDelayMs,
          });
        },
      });
    });
    if (renewals.gitCredentialRenewalClosed) {
      await Promise.all(controllers.map(async (controller) => await controller.stop()));
      return;
    }
    renewals.gitCredentialRenewals = controllers;
  };

  const attachCodemodeTokenRenewal = async (
    tokenSession?: CodemodeTokenWriterSession,
    initialExpiresAt = sandboxCodemodeTokenExpiresAt,
    initialSandbox?: ResumedTurnSandbox,
  ): Promise<void> => {
    if (!codemodeTokenState || !initialExpiresAt) return;
    const previous = renewals.codemodeTokenRenewal;
    renewals.codemodeTokenRenewal = null;
    await previous?.stop();
    if (renewals.codemodeTokenRenewalClosed) return;

    const mint = async () => {
      const material = await mintSandboxCodemodeToken(
        runSettings,
        connectionScope,
        codemodeAuthority,
      );
      return material;
    };
    const write = async (material: NonNullable<Awaited<ReturnType<typeof mint>>>) => {
      if (tokenSession) {
        const runAs = sandboxRunAs(runSettings);
        const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
        if (!targetSandbox) {
          throw new Error("Codemode token renewal has no exact sandbox lease target");
        }
        await runWorkspaceMutationForSandbox(
          targetSandbox,
          "codemodeTokenRenewal",
          async () =>
            await refreshCodemodeTokenFile(tokenSession, material.token, {
              ...(runAs ? { runAs } : {}),
              ...(sandboxCodemodeTokenFile
                ? {
                    tokenFile: sandboxCodemodeTokenFile,
                    legacyTokenFile: sandboxEnvironment.OPENGENI_CODEMODE_TOKEN_FILE!,
                  }
                : {}),
              ...(eventing.toolCancellationFenceRef.current
                ? {
                    commandRunner: eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                      eventing.toolCancellationFenceRef.current,
                    ),
                  }
                : {}),
            }),
        );
      }
      codemodeTokenState.token = material.token;
    };
    let renewalExpiresAt = initialExpiresAt;
    if (renewalExpiresAt.getTime() <= Date.now() + CODEMODE_TOKEN_EXPIRY_LEAD_MS) {
      const fresh = await mint();
      if (!fresh) {
        throw new Error("Codemode token mint became unavailable during sandbox setup");
      }
      await write(fresh);
      renewalExpiresAt = fresh.expiresAt;
    }
    const controller = startCodemodeTokenRenewalLoop({
      initialExpiresAt: renewalExpiresAt,
      mint,
      write,
      onSuccess: () => {
        observability.incrementCounter({
          name: "opengeni_codemode_token_renewals_total",
          help: "Sandbox Codemode token renewal attempts by outcome.",
          labels: { outcome: "completed" },
        });
      },
      onFailure: ({ retryDelayMs, errorClass }) => {
        observability.incrementCounter({
          name: "opengeni_codemode_token_renewals_total",
          help: "Sandbox Codemode token renewal attempts by outcome.",
          labels: { outcome: "error" },
        });
        observability.warn("Sandbox Codemode token renewal failed; retry scheduled", {
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          errorClass,
          retryDelayMs,
        });
      },
    });
    if (renewals.codemodeTokenRenewalClosed) {
      await controller.stop();
      return;
    }
    renewals.codemodeTokenRenewal = controller;
  };

  // A Connected Machine needs renewal, but renewal is purely worker-local:
  // starting this loop performs no control-plane or machine operation.
  if (activeSandboxBackend === "selfhosted") {
    await attachCodemodeTokenRenewal();
  }

  const attachRunCredentialRenewal = async (
    credentialSession: RunCredentialCommandSession,
    initialMaterial: NormalizedRunCredentialMaterial | null,
    initialSandbox?: ResumedTurnSandbox,
  ): Promise<void> => {
    if (!runCredentialResolver) return;
    const previous = renewals.runCredentialRenewal;
    renewals.runCredentialRenewal = null;
    await previous?.stop();
    if (renewals.runCredentialRenewalClosed) return;
    renewals.runCredentialSession = credentialSession;

    const requireTargetSandbox = (): ResumedTurnSandbox => {
      const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
      if (!targetSandbox) {
        throw new Error("Run credential mutation has no exact sandbox lease target");
      }
      return targetSandbox;
    };

    if (!initialMaterial) {
      await runWorkspaceMutationForSandbox(
        requireTargetSandbox(),
        "runCredentialClear",
        async () =>
          await clearRunCredentials(
            credentialSession,
            input.sessionId,
            eventing.toolCancellationFenceRef.current
              ? eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                  eventing.toolCancellationFenceRef.current,
                )
              : undefined,
          ),
      );
      return;
    }

    const write = async (
      material: NormalizedRunCredentialMaterial | null,
      pruneOtherAttempts = false,
    ): Promise<void> => {
      if (!material) {
        await runWorkspaceMutationForSandbox(
          requireTargetSandbox(),
          "runCredentialAttemptClear",
          async () =>
            await clearRunCredentialsForAttempt(credentialSession, {
              sessionId: input.sessionId,
              attemptId: input.attemptId,
              executionGeneration: attempt.executionGeneration,
            }),
        );
        return;
      }

      await runWorkspaceMutationForSandbox(
        requireTargetSandbox(),
        "runCredentialMaterialization",
        async () =>
          await materializeRunCredentials(credentialSession, material, {
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            executionGeneration: attempt.executionGeneration,
            ...(pruneOtherAttempts ? { pruneOtherAttempts: true } : {}),
            ...(!pruneOtherAttempts ? { pruneSupersededGenerations: true } : {}),
            ...(material.authNeeded.length > 0 &&
            Object.keys(material.environment).length === 0 &&
            material.files.length === 0
              ? { prunePreviousGenerations: true }
              : {}),
            ...(eventing.toolCancellationFenceRef.current
              ? {
                  commandRunner: eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                    eventing.toolCancellationFenceRef.current,
                  ),
                }
              : {}),
          }),
      );
      for (const payload of runCredentialAuthNeededPayloads(material)) {
        const key = JSON.stringify(payload);
        if (renewals.publishedRunCredentialNotices.has(key)) continue;
        renewals.publishedRunCredentialNotices.add(key);
        await eventing.publish!([{ type: "credential.auth_needed", payload }], true);
      }
    };

    const initialExpiryMs = initialMaterial.expiresAt?.getTime() ?? null;
    const seed =
      initialExpiryMs !== null && initialExpiryMs <= Date.now() + RUN_CREDENTIAL_EXPIRY_LEAD_MS
        ? await runCredentialResolver.resolve({
            purpose: "provision",
            forceRefresh: true,
          })
        : initialMaterial;
    await write(seed, true);
    if (renewals.runCredentialRenewalClosed) return;
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: seed?.expiresAt ?? null,
      resolve: async () =>
        await runCredentialResolver.resolve({
          purpose: "renewal",
          forceRefresh: true,
        }),
      write: async (material) => await write(material),
      onSuccess: ({ authNeeded }) => {
        observability.incrementCounter({
          name: "opengeni_run_credential_renewals_total",
          help: "Host-managed run credential renewal attempts by outcome.",
          labels: { outcome: authNeeded ? "auth_needed" : "completed" },
        });
      },
      onFailure: ({ retryDelayMs, errorClass }) => {
        observability.incrementCounter({
          name: "opengeni_run_credential_renewals_total",
          help: "Host-managed run credential renewal attempts by outcome.",
          labels: { outcome: "error" },
        });
        observability.warn("Host run credential renewal failed; retry scheduled", {
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          errorClass,
          retryDelayMs,
        });
      },
    });
    if (renewals.runCredentialRenewalClosed) {
      await controller.stop();
      return;
    }
    renewals.runCredentialRenewal = controller;
  };

  return {
    runCredentialResolver,
    establishPolicy,
    initialRunCredentialMaterial,
    runCredentialsNote,
    authorizeGitHubTokenMint,
    hostCredentialRootSessionId,
    gitCredentialAuthority,
    codemodeAuthority,
    sandboxArtifactRuntime,
    sandboxEnvironment,
    sandboxGitToken,
    sandboxGitTokens,
    sandboxGitTokenExpiresAt,
    sandboxGitCredentialBindings,
    sandboxCodemodeToken,
    sandboxCodemodeTokenExpiresAt,
    sandboxCodemodeTokenFile,
    transientCodemodeEnvironment,
    initialGitCredentials,
    startRunGitCredentialsMint,
    attachGitCredentialRenewal,
    attachCodemodeTokenRenewal,
    attachRunCredentialRenewal,
  };
}

export type PrepareRunCredentialsOk = Awaited<ReturnType<typeof prepareRunCredentials>>;
