import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  SandboxV2CredentialSelection,
  type RunCredentialsRequest,
  type SandboxV2PreparationPlan,
} from "@opengeni/contracts";
import {
  getSession,
  getSessionRootId,
  getSessionTurnForAttempt,
  loadSandboxV2PreparationPlan,
  withSandboxV2TurnMachineFence,
  SandboxV2CredentialGenerationError,
} from "@opengeni/db";
import {
  createSandboxV2CredentialLifecycleOwner,
  createSandboxV2CredentialGenerationOwner,
  type SandboxV2ActiveCredentials,
  type SandboxV2TurnMachine,
} from "@opengeni/core";
import {
  bindRunCredentialResolver,
  buildRunCredentialsRequest,
  type RunCredentialResolutionContext,
} from "./activities/run-credentials";
import { normalizeRunCredentialsResolution } from "@opengeni/runtime";

type NativeCredentialContext = Omit<
  RunCredentialResolutionContext,
  "effectiveSandboxBackend" | "nativeMachineProvider" | "settings"
> & {
  settings: NonNullable<RunCredentialResolutionContext["settings"]>;
};
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}
function requestDigest(input: RunCredentialsRequest): string {
  try {
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) fail();
    let remaining = 65536;
    const canonical = (value: unknown, depth = 0): unknown => {
      if (--remaining < 0 || depth > 64) fail();
      if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item, depth + 1)]),
        );
      return value;
    };
    return createHash("sha256")
      .update(JSON.stringify(canonical(JSON.parse(encoded))))
      .digest("hex");
  } catch {
    fail();
  }
}
function capture(input: NativeCredentialContext): NativeCredentialContext {
  return {
    ...input,
    session: structuredClone(input.session),
    turn: structuredClone(input.turn),
    variableSet: structuredClone(input.variableSet),
    effectiveTools: structuredClone(input.effectiveTools),
    localMcpServerIds: [...(input.localMcpServerIds ?? [])],
    settings: { ...input.settings, mcpServers: structuredClone(input.settings.mcpServers) },
  };
}

/** Load ordinary canonical turn/session inputs under native ownership. No mint
 * occurs here. The retained provider is independent of legacy backend defaults. */
async function bindCurrent(
  input: NativeCredentialContext,
  machine: SandboxV2TurnMachine,
  variableSet: NativeCredentialContext["variableSet"],
): Promise<{
  context: RunCredentialResolutionContext;
  request: RunCredentialsRequest;
  selection: SandboxV2CredentialSelection;
  resolver: Awaited<ReturnType<typeof bindRunCredentialResolver>>;
}> {
  const authority = machine.authority;
  if (
    input.accountId !== authority.accountId ||
    input.workspaceId !== authority.workspaceId ||
    input.session.id !== authority.sessionId ||
    input.turn.id !== authority.turnId ||
    input.attemptId !== authority.attemptId ||
    input.turn.executionGeneration !== authority.executionGeneration
  )
    fail();
  await withSandboxV2TurnMachineFence(input.db, authority, async () => undefined);
  const [session, turn] = await Promise.all([
    getSession(input.db, authority.workspaceId, authority.sessionId),
    getSessionTurnForAttempt(
      input.db,
      authority.workspaceId,
      authority.sessionId,
      authority.attemptId,
    ),
  ]);
  if (
    !session ||
    session.accountId !== authority.accountId ||
    !turn ||
    turn.id !== authority.turnId ||
    turn.executionGeneration !== authority.executionGeneration
  )
    fail();
  const context: RunCredentialResolutionContext = {
    ...input,
    session,
    turn,
    variableSet: structuredClone(variableSet),
    effectiveSandboxBackend: "machine-v2",
    nativeMachineProvider: machine.provider,
  };
  const resolver = await bindRunCredentialResolver(context);
  const rootSessionId =
    resolver?.request?.rootSessionId ??
    (await getSessionRootId(input.db, authority.workspaceId, authority.sessionId));
  if (!rootSessionId) fail();
  const request =
    resolver?.request ??
    buildRunCredentialsRequest({
      ...context,
      rootSessionId,
      purpose: "provision",
      forceRefresh: false,
    });
  // A host callback without its stable identity/authorization leg cannot enter
  // native recovery. Absence stays none; it never borrows a later provider.
  if (resolver && !resolver.provider) fail();
  const parsed = SandboxV2CredentialSelection.safeParse({
    requestDigest: requestDigest(request),
    provider: resolver?.provider ?? { kind: "none" },
    variableSet,
    mcpServers: (resolver?.mcpServers ?? []).map(({ id, url }) => ({
      id,
      urlDigest: createHash("sha256").update(url).digest("hex"),
    })),
  });
  if (!parsed.success) fail();
  await withSandboxV2TurnMachineFence(input.db, authority, async () => undefined);
  return { context, request, selection: parsed.data, resolver };
}

/** Retain this selection in the host plan BEFORE any broker resolution. The
 * digest protects arbitrary accepted initiator context without persisting it.
 * No key, URL signature, header, returned environment or file is included. */
export async function planSandboxV2RunCredentialSelection(
  input: NativeCredentialContext,
  machine: SandboxV2TurnMachine,
): Promise<SandboxV2CredentialSelection> {
  const context = capture(input);
  const current = await bindCurrent(context, machine, context.variableSet);
  if (
    current.selection.provider.kind === "host" &&
    typeof context.connectionCredentials?.runCredentialAuthority?.authorize !== "function"
  )
    fail();
  return structuredClone(current.selection);
}

/** Real ordinary broker composition for the retained native lifecycle. Every
 * use checks exact live attempt/incarnation, original request/provider/targets
 * and host authorization without minting. Workspace HTTP selection checks the
 * current enabled original registration; issuer-internal grants remain owned
 * by that broker and its API. No new authorization endpoint is invented. */
export function createSandboxV2RunCredentialOwner(
  input: NativeCredentialContext,
  machine: SandboxV2TurnMachine,
  plan: SandboxV2PreparationPlan,
  options: {
    encryptionKey?: Uint8Array;
    environment: () => Promise<Record<string, string>>;
    /** Independently authorized workspace values. Seal with the generation;
     * never put these values into a manifest, command or preparation plan. */
    workspaceEnvironment?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    onActivate?: (value: SandboxV2ActiveCredentials) => void;
  },
) {
  machine = {
    ...machine,
    authority: structuredClone(machine.authority),
    capabilities: { ...machine.capabilities },
  };
  options = {
    ...options,
    ...(options.encryptionKey ? { encryptionKey: Uint8Array.from(options.encryptionKey) } : {}),
  };
  const context = capture(input);
  plan = structuredClone(plan);
  const parsed = SandboxV2CredentialSelection.safeParse(plan.credentialSelection);
  const key = options.encryptionKey ?? environmentsEncryptionKeyBytes(context.settings);
  if (!parsed.success || !plan.credentialGenerationId || !key) fail();
  const expected = parsed.data;
  const workspaceEnvironment = normalizeRunCredentialsResolution(
    {
      status: "ok",
      accountId: machine.authority.accountId,
      workspaceId: machine.authority.workspaceId,
      sessionId: machine.authority.sessionId,
      environment: { ...options.workspaceEnvironment },
    },
    machine.authority,
  ).environment;
  const authorize = async () => {
    options.signal?.throwIfAborted();
    const original = await loadSandboxV2PreparationPlan(
      context.db,
      machine.authority,
      plan.setupId,
    );
    if (
      !original ||
      original.credentialGenerationId !== plan.credentialGenerationId ||
      !isDeepStrictEqual(original.credentialSelection, expected)
    )
      fail();
    const current = await bindCurrent(context, machine, expected.variableSet);
    if (!isDeepStrictEqual(current.selection, expected)) fail();
    if (expected.provider.kind === "host") {
      const host = context.connectionCredentials?.runCredentialAuthority;
      if (
        !host ||
        host.identity !== expected.provider.identity ||
        typeof host.authorize !== "function"
      )
        fail();
      await host.authorize(structuredClone(current.request), {
        mcpServers: structuredClone(current.resolver?.mcpServers ?? []),
      });
    }
    options.signal?.throwIfAborted();
    return current;
  };
  // Freeze the independently selected workspace inputs separately from broker
  // output. Recovery of a later renewal must keep the original base values,
  // including an originally empty environment. The reference is deterministic
  // and nonsecret; only the encrypted generation contains those values.
  const workspaceInputs =
    options.workspaceEnvironment === undefined
      ? null
      : createSandboxV2CredentialGenerationOwner(
          context.db,
          machine.authority,
          {
            generationId: `workspace-inputs:${createHash("sha256").update(plan.credentialGenerationId).digest("hex")}`,
            purpose: "provision",
            forceRefresh: false,
          },
          {
            encryptionKey: key,
            authorize: async () => {
              await authorize();
            },
            resolve: async () => ({
              status: "ok",
              accountId: context.accountId,
              workspaceId: context.workspaceId,
              sessionId: context.session.id,
              environment: workspaceEnvironment,
            }),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
  return createSandboxV2CredentialLifecycleOwner(
    context.db,
    machine,
    { setupId: plan.setupId, initialGenerationId: plan.credentialGenerationId },
    {
      encryptionKey: key,
      authorize: async () => {
        await authorize();
      },
      resolve: async (definition) => {
        const current = await authorize();
        const inputs = await workspaceInputs?.resolveGeneration();
        if (inputs && inputs.status !== "ok") fail();
        const originalEnvironment = inputs?.environment ?? {};
        const resolution = !current.resolver
          ? ({
              status: "not_applicable",
              accountId: context.accountId,
              workspaceId: context.workspaceId,
              sessionId: context.session.id,
            } as const)
          : await (() => {
              if (!current.resolver.resolveResolution) fail();
              return current.resolver.resolveResolution({
                purpose: definition.purpose,
                forceRefresh: definition.forceRefresh,
              });
            })();
        normalizeRunCredentialsResolution(resolution, machine.authority);
        if (!Object.keys(originalEnvironment).length) return resolution;
        // Broker opt-out contributes no host material. Independently selected
        // workspace values still have their ordinary permission boundary.
        // Broker values take the same precedence as the legacy composition.
        return {
          ...resolution,
          status: "ok",
          environment: {
            ...originalEnvironment,
            ...(resolution.status === "ok" ? resolution.environment : {}),
          },
        };
      },
      environment: options.environment,
      ...(plan.workspaceRoot ? { workspaceRoot: plan.workspaceRoot } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onActivate ? { onActivate: options.onActivate } : {}),
    },
  );
}
