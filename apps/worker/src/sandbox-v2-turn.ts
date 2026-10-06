import {
  loadSandboxV2PreparationPlan,
  retainSandboxV2PreparationPlan,
  type SandboxSessionEngineRoute,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  RunCredentialsResolution,
  SandboxV2PreparationPlan,
  SandboxV2PreparationFile,
  SandboxV2PreparationRepository,
} from "@opengeni/contracts";
import {
  deliverSandboxV2File,
  executeSandboxV2SetupStep,
  installSandboxV2CredentialGeneration,
  type SandboxV2FileDelivery,
  type SandboxV2TurnMachine,
  type SandboxV2CredentialLifecycleOwner,
} from "@opengeni/core";
import { JournalBindingError, withRunCredentialEnvironment } from "@opengeni/runtime/sandbox";
import {
  buildSandboxFileDownloadStep,
  buildSandboxV2PreparedFileManifest,
} from "@opengeni/runtime";
import { createSandboxV2ShellBinding } from "./sandbox-v2-shell";

/** Normal SDK shell composition after exact machine establishment. Environment
 * is resolved at a fresh command boundary, never persisted into the manifest or
 * rebuilt for an ambiguous Start. Machine lifetime stays with durable demand. */
export function createSandboxV2TurnShell(
  db: Parameters<typeof createSandboxV2ShellBinding>[0],
  machine: SandboxV2TurnMachine,
  options: {
    environment: () => Promise<Record<string, string>>;
    workspaceRoot?: string;
    useRunCredentials?: boolean;
    preparedFiles?: readonly SandboxV2PreparationFile[];
    preparedRepositories?: readonly SandboxV2PreparationRepository[];
    authorizeResources?: () => Promise<void>;
    backgroundCommands?: Parameters<typeof createSandboxV2ShellBinding>[2]["backgroundCommands"];
  },
  outputPolicy: Parameters<typeof createSandboxV2ShellBinding>[3] = {},
) {
  return createSandboxV2ShellBinding(
    db,
    machine.authority,
    {
      provider: machine.provider,
      machineId: machine.authority.machineId,
      instance: machine.authority.instance,
      transport: machine.transport,
      capabilities: machine.capabilities,
      environment: options.environment,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      ...(options.useRunCredentials ? { useRunCredentials: true } : {}),
      ...(options.preparedFiles ? { preparedFiles: options.preparedFiles } : {}),
      ...(options.preparedRepositories
        ? { preparedRepositories: options.preparedRepositories }
        : {}),
      ...(options.authorizeResources ? { authorizeResources: options.authorizeResources } : {}),
      ...(options.backgroundCommands ? { backgroundCommands: options.backgroundCommands } : {}),
    },
    outputPolicy,
  );
}

export type SandboxV2TurnPreparationPlan = SandboxV2PreparationPlan;

/** Recover the frozen host plan before resolving current setup inputs. The
 * builder runs outside the admission transaction and must produce nonsecret
 * commands plus recoverable generation/file references. Concurrent builders
 * converge only when they describe the same plan. */
export async function loadOrCreateSandboxV2TurnPreparationPlan(
  db: Parameters<typeof createSandboxV2ShellBinding>[0],
  machine: SandboxV2TurnMachine,
  setupId: string,
  buildPlan: () => Promise<SandboxV2TurnPreparationPlan>,
): Promise<SandboxV2TurnPreparationPlan> {
  const authority = structuredClone(machine.authority);
  const original = await loadSandboxV2PreparationPlan(db, authority, setupId);
  if (original) return original;
  const plan = structuredClone(await buildPlan());
  if (plan.setupId !== setupId) throw new JournalBindingError("Preparation plan identity changed");
  return await retainSandboxV2PreparationPlan(db, authority, plan);
}

/** Compose a retained host preparation plan with the ordinary SDK shell.
 * Database retention precedes every side effect. The host owns recoverable
 * credential generations, resource grants and renewal.
 * Plan keys are explicit, not traversal counters or hashes of current commands.
 * This preparer owns no legacy lease/archive and grants no fresh admission. */
export async function prepareSandboxV2TurnShell(
  db: Parameters<typeof createSandboxV2ShellBinding>[0],
  machine: SandboxV2TurnMachine,
  input: SandboxV2TurnPreparationPlan,
  options: {
    environment: () => Promise<Record<string, string>>;
    resolveCredentialGeneration?: (generationId: string) => Promise<RunCredentialsResolution>;
    authorizeCredentialGeneration?: (generationId: string) => Promise<void>;
    credentialLifecycle?: SandboxV2CredentialLifecycleOwner;
    backgroundCommands?: Parameters<typeof createSandboxV2ShellBinding>[2]["backgroundCommands"];
    resolveDownloadUrl?: (file: SandboxV2FileDelivery) => Promise<string>;
    authorizeFileResources?: (files: readonly SandboxV2PreparationFile[]) => Promise<void>;
    authorizeRepositoryResources?: (
      repositories: readonly SandboxV2PreparationRepository[],
    ) => Promise<void>;
    /** Install finalization ownership before the first preparation write. The
     * binding refuses agent dispatch until every retained input is ready. */
    onBinding?: (binding: ReturnType<typeof createSandboxV2TurnShell>) => void;
    signal?: AbortSignal;
  },
  outputPolicy: Parameters<typeof createSandboxV2ShellBinding>[3] = {},
) {
  let plan = structuredClone(input);
  options = { ...options };
  machine = {
    ...machine,
    authority: structuredClone(machine.authority),
    capabilities: { ...machine.capabilities },
  };
  if (
    !plan.setupId ||
    plan.workspaceOperation !== undefined ||
    plan.setupId.length > 512 ||
    (plan.workspaceRoot !== undefined &&
      (!posix.isAbsolute(plan.workspaceRoot) || posix.normalize(plan.workspaceRoot) === "/")) ||
    (plan.credentialGenerationId !== undefined &&
      (!plan.credentialGenerationId || plan.credentialGenerationId.length > 512))
  )
    throw new JournalBindingError("Invalid retained preparation plan identity or root");
  options.signal?.throwIfAborted();
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!/^[a-zA-Z0-9_./:-]{1,128}$/u.test(step.stepId) || ids.has(step.stepId))
      throw new JournalBindingError("Preparation steps require unique retained identities");
    ids.add(step.stepId);
  }
  if (
    plan.credentialGenerationId &&
    !options.credentialLifecycle &&
    !options.resolveCredentialGeneration
  )
    throw new JournalBindingError("Credential generation resolver is unavailable");
  if (
    plan.credentialGenerationId &&
    !options.credentialLifecycle &&
    !options.authorizeCredentialGeneration
  )
    throw new JournalBindingError("Credential generation requires its live authorization owner");
  if (
    options.credentialLifecycle &&
    (options.credentialLifecycle.setupId !== plan.setupId ||
      options.credentialLifecycle.initialGenerationId !== plan.credentialGenerationId)
  )
    throw new JournalBindingError("Credential lifecycle and frozen preparation identity changed");
  if (plan.files.length && !options.resolveDownloadUrl)
    throw new JournalBindingError("Authorized file resolver is unavailable");
  if (plan.files.length && !options.authorizeFileResources)
    throw new JournalBindingError("Prepared file resources require their live authorization owner");
  if (plan.repositories?.length && !options.authorizeRepositoryResources)
    throw new JournalBindingError(
      "Prepared repository resources require their live authorization owner",
    );
  const fileIds = new Set<string>();
  buildSandboxV2PreparedFileManifest(plan.files, plan.workspaceRoot ?? "/workspace");
  for (const file of plan.files) {
    if (!file.fileId || fileIds.has(file.fileId))
      throw new JournalBindingError("Preparation files require unique retained identities");
    fileIds.add(file.fileId);
    // Validate every delivery target before credentials or earlier hooks may
    // run. The shared materializer remains the authority for path normalization.
    buildSandboxFileDownloadStep(file, plan.workspaceRoot ?? "/workspace", {
      urlEnvironmentVariable: "OPENGENI_ATTACHMENT_DOWNLOAD_URL",
    });
  }
  plan = await retainSandboxV2PreparationPlan(db, machine.authority, plan);
  options.signal?.throwIfAborted();
  let credentialsReady = false;
  const authorizePreparedInputs = async () => {
    options.signal?.throwIfAborted();
    await options.authorizeFileResources?.(structuredClone(plan.files));
    await options.authorizeRepositoryResources?.(structuredClone(plan.repositories ?? []));
    if (options.credentialLifecycle) {
      if (credentialsReady) await options.credentialLifecycle.authorizeCurrent();
    } else if (plan.credentialGenerationId)
      await options.authorizeCredentialGeneration!(plan.credentialGenerationId);
    options.signal?.throwIfAborted();
  };
  const setupOptions = {
    environment: options.environment,
    authorizeWrite: authorizePreparedInputs,
    ...(plan.workspaceRoot ? { workspaceRoot: plan.workspaceRoot } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const useRunCredentials = Boolean(plan.credentialGenerationId);
  let preparationComplete = false;
  const binding = createSandboxV2TurnShell(
    db,
    machine,
    {
      ...setupOptions,
      ...(useRunCredentials ? { useRunCredentials: true } : {}),
      preparedFiles: plan.files,
      preparedRepositories: plan.repositories ?? [],
      ...(options.backgroundCommands ? { backgroundCommands: options.backgroundCommands } : {}),
      authorizeResources: async () => {
        if (!preparationComplete)
          throw new JournalBindingError("Native preparation has not completed");
        await authorizePreparedInputs();
      },
    },
    outputPolicy,
  );
  options.onBinding?.(binding);
  await authorizePreparedInputs();
  options.signal?.throwIfAborted();
  if (plan.credentialGenerationId) {
    if (options.credentialLifecycle) {
      await options.credentialLifecycle.ensure();
    } else
      await installSandboxV2CredentialGeneration(
        db,
        machine,
        {
          setupId: plan.setupId,
          generationId: plan.credentialGenerationId,
        },
        { ...setupOptions, resolveGeneration: options.resolveCredentialGeneration! },
      );
    // A configured owner always has a pointer, including empty versions.
    // Later renewal may introduce material after initial not_applicable.
    credentialsReady = true;
  }
  for (const step of plan.steps) {
    options.signal?.throwIfAborted();
    await authorizePreparedInputs();
    await executeSandboxV2SetupStep(
      db,
      machine,
      {
        setupId: plan.setupId,
        stepId: `hook:${createHash("sha256").update(step.stepId).digest("hex")}`,
        command: useRunCredentials
          ? {
              ...step.command,
              cmd: withRunCredentialEnvironment(step.command.cmd, machine.authority.sessionId),
            }
          : step.command,
      },
      setupOptions,
    );
  }
  for (const file of plan.files) {
    options.signal?.throwIfAborted();
    await deliverSandboxV2File(
      db,
      machine,
      { setupId: plan.setupId, file },
      {
        ...setupOptions,
        resolveDownloadUrl: options.resolveDownloadUrl!,
      },
    );
  }
  preparationComplete = true;
  return binding;
}

export class SandboxV2TurnUnavailableError extends Error {
  readonly code = "SANDBOX_V2_TURN_UNAVAILABLE";
  constructor(readonly route: Extract<SandboxSessionEngineRoute, { engine: "machine-v2" }>) {
    super("Workspace compute is unavailable");
  }
}

/** Guard entry points that implement only the legacy engine. The main turn
 * runner selects its installed native preparer separately; a flag change
 * cannot reinterpret a retained group as a legacy workspace. */
export function assertLegacySandboxTurnRoute(route: SandboxSessionEngineRoute): void {
  if (route.engine === "machine-v2")
    throw new SandboxV2TurnUnavailableError(structuredClone(route));
}
