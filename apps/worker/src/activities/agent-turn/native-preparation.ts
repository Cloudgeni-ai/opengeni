import {
  environmentsEncryptionKeyBytes,
  sandboxLifecycleHookIds,
  type Settings,
} from "@opengeni/config";
import { isDeepStrictEqual } from "node:util";
import type {
  RigVersion,
  SandboxV2PreparationRepository,
  SandboxV2PreparationPlan,
} from "@opengeni/contracts";
import {
  createSandboxV2BackgroundCommandTools,
  establishSandboxV2MachineForAttempt,
} from "@opengeni/core";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import {
  normalizeRunCredentialsResolution,
  RunMcpCredentials,
  repositoryCloneCommand,
  sandboxV2PreparedRepositoryFor,
  selectedSessionRemoteMcpTargets,
  type NormalizedRunCredentialMaterial,
} from "@opengeni/runtime";
import type { SandboxV2ControlProviders } from "../../sandbox-v2-control";
import { createSandboxV2TurnExecution } from "../../sandbox-v2-execution";
import { startSandboxV2CredentialRenewalLoop } from "../../sandbox-v2-credential-renewal";
import {
  createSandboxV2RunCredentialOwner,
  planSandboxV2RunCredentialSelection,
} from "../../sandbox-v2-run-credentials";
import {
  assertSandboxV2TurnFileResourcesAuthorized,
  createSandboxV2TurnFileUrlResolver,
  planSandboxV2TurnFileResources,
  planSandboxV2TurnRepositoryResources,
  assertSandboxV2TurnRepositoryResourcesAuthorized,
} from "../../sandbox-v2-resources";
import {
  loadOrCreateSandboxV2TurnPreparationPlan,
  prepareSandboxV2TurnShell,
} from "../../sandbox-v2-turn";
import { runCredentialAuthNeededPayloads, runCredentialModelNote } from "../run-credentials";
import { expandMcpAccountRoutes } from "../mcp-account-routes";
import type { TurnActivityServices } from "../types";
import type { EventingState, RenewalState, SandboxRuntimeState } from "./turn-context";
import type { prepareRunCredentials } from "./run-credentials";
import type { runtimeResourcesForTurn } from "./file-resources";
import { publishDurableSessionEvents } from "../../session-event-fanout";

type NativeCredentialContext = Parameters<typeof planSandboxV2RunCredentialSelection>[0];
type LegacyCredentials = Awaited<ReturnType<typeof prepareRunCredentials>>;
type CommonCredentialFields = Pick<
  LegacyCredentials,
  | "runCredentialResolver"
  | "runMcpCredentials"
  | "initialRunCredentialMaterial"
  | "runCredentialsNote"
  | "sandboxArtifactRuntime"
  | "sandboxEnvironment"
  | "sandboxGitToken"
  | "sandboxGitTokens"
  | "sandboxGitCredentialBindings"
  | "sandboxCodemodeToken"
  | "sandboxCodemodeTokenExpiresAt"
  | "initialGitCredentials"
  | "attachGitCredentialRenewal"
  | "attachCodemodeTokenRenewal"
  | "attachRunCredentialRenewal"
>;

function repositorySteps(
  repositories: readonly SandboxV2PreparationRepository[],
): SandboxV2PreparationPlan["steps"] {
  if (!repositories.length) return [];
  return [
    {
      stepId: "repositories:v1",
      command: {
        cmd:
          "set +x\nOPENGENI_GIT_PROVISIONING_TARGET=sandbox\n" +
          repositoryCloneCommand(
            repositories.map((repository) => ({ kind: "repository" as const, ...repository })),
            [],
            [],
            { credentialsAlreadyPrepared: true, preserveExisting: true },
          ),
        workdir: "/workspace",
        shell: "/bin/bash",
        login: false,
        yieldTimeMs: 30_000,
        maxOutputTokens: 4_000,
      },
    },
  ];
}

/** Concrete main-runner composition. A retained group uses only its installed
 * native provider, original plan, ordinary grants and encrypted material. This
 * does not enable admission or qualify a provider. Unsupported preparation
 * contracts fail before establishment or credential minting. */
export async function prepareNativeTurnSandbox(deps: {
  context: NativeCredentialContext;
  providers: SandboxV2ControlProviders | undefined;
  settings: Settings;
  objectStorage: TurnActivityServices["objectStorage"];
  bus?: TurnActivityServices["bus"];
  sandboxState: SandboxRuntimeState;
  eventing: EventingState;
  renewals: RenewalState;
  runtimeResources: ReturnType<typeof runtimeResourcesForTurn>;
  mcpAccountBindings?: Parameters<typeof expandMcpAccountRoutes>[0]["bindings"];
  workspaceEnvironment: Readonly<Record<string, string>>;
  rigVersion: RigVersion | null;
  hasGeneratedVideoInputs: boolean;
  signal?: AbortSignal;
}): Promise<CommonCredentialFields> {
  const { context, settings, sandboxState, eventing, renewals, signal } = deps;
  signal?.throwIfAborted();
  const rig = deps.rigVersion;
  if (
    (rig &&
      (rig.image !== null ||
        Boolean(rig.setupScript?.trim()) ||
        rig.credentialHooks.length > 0 ||
        rig.checks.length > 0 ||
        Object.keys(rig.providerImages).length > 0)) ||
    deps.hasGeneratedVideoInputs ||
    deps.runtimeResources.some(
      (resource) => resource.kind !== "file" && resource.kind !== "repository",
    ) ||
    sandboxLifecycleHookIds(context.settings).length ||
    (context.turn.sandboxOs ?? context.session.sandboxOs) !== "linux"
  )
    throw new JournalBindingError(
      "Native turn preparation does not yet support this rig, resource or OS contract",
    );
  for (const resource of deps.runtimeResources)
    if (resource.kind === "repository") sandboxV2PreparedRepositoryFor(resource);
  const providers = deps.providers ?? new Map();
  const machine = await establishSandboxV2MachineForAttempt(
    context.db,
    {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.session.id,
      turnId: context.turn.id,
      attemptId: context.attemptId,
      executionGeneration: context.turn.executionGeneration,
    },
    providers,
    { idleGraceMs: settings.sandboxIdleGraceMs, ...(signal ? { signal } : {}) },
  );
  if (machine.engine !== "machine-v2")
    throw new JournalBindingError("Retained native engine changed during preparation");
  const installation = providers.get(machine.provider)!;
  const accountRoutes = expandMcpAccountRoutes({
    settings: context.settings,
    tools: [...context.effectiveTools],
    bindings: deps.mcpAccountBindings,
  });
  const credentialContext = {
    ...context,
    settings: accountRoutes.settings,
    effectiveTools: accountRoutes.tools,
  };
  const plan = await loadOrCreateSandboxV2TurnPreparationPlan(
    context.db,
    machine,
    "normal-turn:v1",
    async () => {
      const files = await planSandboxV2TurnFileResources(context.db, machine);
      const repositories = await planSandboxV2TurnRepositoryResources(context.db, machine);
      return {
        setupId: "normal-turn:v1",
        workspaceRoot: "/workspace",
        credentialGenerationId: "normal-turn:credentials:v1",
        credentialSelection: await planSandboxV2RunCredentialSelection(credentialContext, machine),
        steps: repositorySteps(repositories),
        ...(repositories.length ? { repositories } : {}),
        files: files.files,
      };
    },
  );
  if (
    !isDeepStrictEqual(plan.steps, repositorySteps(plan.repositories ?? [])) ||
    plan.workspaceRoot !== "/workspace"
  )
    throw new JournalBindingError("Native normal-turn preparation contract changed");
  if (plan.files.length && (!deps.objectStorage || !installation.fileDownloadAudience))
    throw new JournalBindingError(
      "Native file preparation requires its installed storage network contract",
    );
  const runMcpCredentials = new RunMcpCredentials(
    selectedSessionRemoteMcpTargets(
      accountRoutes.settings,
      context.session.mcpServers ?? [],
      accountRoutes.tools,
      (context.localMcpServerIds ?? []).map((id) => ({ id })),
    ),
    { ...(signal ? { signal } : {}) },
  );
  let renewal: ReturnType<typeof startSandboxV2CredentialRenewalLoop> | null = null;
  let material: NormalizedRunCredentialMaterial | null = null;
  const credentialRenewal = {
    stop: async () => {
      await renewal?.stop();
    },
    refreshNow: async () => {
      if (!renewal)
        throw new JournalBindingError("Native credential preparation has not completed");
      sandboxState.nativeTurn!.invocations.assertOpen();
      await renewal.refreshNow();
    },
  };
  // These holders exist before the first native writer. The early binding
  // callback gives every later failure the same finalization owner.
  try {
    const owner = createSandboxV2RunCredentialOwner(credentialContext, machine, plan, {
      environment: async () => ({}),
      workspaceEnvironment: deps.workspaceEnvironment,
      ...(signal ? { signal } : {}),
      onActivate: (value) => {
        const candidate = normalizeRunCredentialsResolution(value.resolution, machine.authority);
        if (
          runMcpCredentials.replaceGeneration(
            {
              attemptId: machine.authority.attemptId,
              generationId: value.ticket.definition.generationId,
              ordinal: value.ticket.ordinal,
            },
            candidate,
          )
        )
          material = candidate;
      },
    });
    const encryptionKey = environmentsEncryptionKeyBytes(context.settings);
    if (!encryptionKey)
      throw new JournalBindingError("Native credential encryption is unavailable");
    const backgroundCommands = installation.authorizeBackgroundJobControl
      ? createSandboxV2BackgroundCommandTools(context.db, machine, {
          encryptionKey,
          resolveOriginal: async () => (await owner.ensure()).resolution,
          authorizeResources: async () => {
            await owner.authorizeCurrent();
            await assertSandboxV2TurnFileResourcesAuthorized(context.db, machine, plan.files);
            await assertSandboxV2TurnRepositoryResourcesAuthorized(
              context.db,
              machine,
              plan.repositories ?? [],
            );
          },
          authorizeJob: installation.authorizeBackgroundJobControl,
          controlTransport: installation.transport,
          workspaceRoot: plan.workspaceRoot!,
          publishEvents: (events) =>
            publishDurableSessionEvents(deps.bus, context.workspaceId, events),
        })
      : undefined;
    await prepareSandboxV2TurnShell(context.db, machine, plan, {
      environment: async () => ({}),
      credentialLifecycle: owner,
      ...(backgroundCommands ? { backgroundCommands } : {}),
      authorizeFileResources: (files) =>
        assertSandboxV2TurnFileResourcesAuthorized(context.db, machine, files),
      authorizeRepositoryResources: (repositories) =>
        assertSandboxV2TurnRepositoryResourcesAuthorized(context.db, machine, repositories),
      ...(plan.files.length
        ? {
            resolveDownloadUrl: createSandboxV2TurnFileUrlResolver(
              context.db,
              machine,
              deps.objectStorage!,
              { audience: installation.fileDownloadAudience! },
            ),
          }
        : {}),
      ...(signal ? { signal } : {}),
      onBinding: (binding) => {
        sandboxState.nativeTurn = createSandboxV2TurnExecution(
          context.db,
          machine,
          binding,
          providers,
          {
            ...(signal ? { signal } : {}),
            runMcpCredentials,
            credentialRenewal,
          },
        );
      },
    });
    const initial = await owner.ensure();
    const publishNotices = async () => {
      if (!material) return;
      for (const payload of runCredentialAuthNeededPayloads(material)) {
        const key = JSON.stringify(payload);
        if (renewals.publishedRunCredentialNotices.has(key)) continue;
        await eventing.publish!([{ type: "credential.auth_needed", payload }], true);
        renewals.publishedRunCredentialNotices.add(key);
      }
    };
    await publishNotices();
    renewal = startSandboxV2CredentialRenewalLoop({
      owner,
      initial,
      onSuccess: ({ authNeeded }) => {
        renewals.runCredentialRenewalOutcome = authNeeded ? "auth_needed" : "completed";
        // Publication is owned local work too. Closure refuses a notification
        // that starts after cancellation and joins one already in progress.
        void sandboxState.nativeTurn!.invocations.run(publishNotices).catch(() => undefined);
      },
      onFailure: () => {
        renewals.runCredentialRenewalOutcome = "error";
      },
    });
    // The ordinary refresh tool and finalizer must use this exact owner too.
    // No legacy command session or credential delivery callback is installed.
    renewals.runCredentialRenewal = credentialRenewal;
    renewals.runMcpCredentials = runMcpCredentials;
    const rejectLegacyRenewal = async (): Promise<never> => {
      throw new JournalBindingError("Native credentials require their retained lifecycle owner");
    };
    return {
      runCredentialResolver: null,
      runMcpCredentials,
      initialRunCredentialMaterial: null,
      runCredentialsNote: material ? runCredentialModelNote(material) : undefined,
      sandboxArtifactRuntime: { available: false, environment: {} },
      sandboxEnvironment: {},
      sandboxGitToken: undefined,
      sandboxGitTokens: undefined,
      sandboxGitCredentialBindings: undefined,
      sandboxCodemodeToken: undefined,
      sandboxCodemodeTokenExpiresAt: undefined,
      initialGitCredentials: undefined,
      attachGitCredentialRenewal: rejectLegacyRenewal,
      attachCodemodeTokenRenewal: rejectLegacyRenewal,
      attachRunCredentialRenewal: rejectLegacyRenewal,
    };
  } catch (error) {
    // Once installed, finalization closes the holders and reconciles the exact
    // original writer. Before installation no native writer has been issued.
    if (!sandboxState.nativeTurn) {
      runMcpCredentials.close();
      await renewal?.stop();
    }
    throw error;
  }
}
