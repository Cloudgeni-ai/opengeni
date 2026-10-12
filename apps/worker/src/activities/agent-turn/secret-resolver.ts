/**
 * The attempt's secret resolver: `{{secret:…}}` references in tool calls
 * resolve with this exact live attempt's vault reach (§10B.2). With the
 * `secrets` capability off the resolver is disabled and every surface passes
 * references through literally (AG-4).
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { ResolvedAgentConfig, SecretPrincipal, SecretResolver } from "@opengeni/contracts";
import { createSecretResolver } from "@opengeni/core";
import { listVaultsForSubject, type Database } from "@opengeni/db";

/**
 * Q-17: a frozen configuration without the key reads `from === "all"` (the
 * contracts parse fills it); legacy null-config sessions get secrets on.
 */
export function secretsCapabilityEnabled(agentConfig: ResolvedAgentConfig | null | undefined) {
  return agentConfig ? agentConfig.capabilities.secrets === true : true;
}

type AttemptSecretInput = {
  db: Database;
  settings: Settings;
  agentConfig: ResolvedAgentConfig | null | undefined;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function attemptPrincipal(input: Omit<AttemptSecretInput, "db" | "settings" | "agentConfig">) {
  return {
    kind: "attempt",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration,
  } satisfies SecretPrincipal;
}

export function attemptSecretResolver(input: AttemptSecretInput): SecretResolver {
  return createSecretResolver(
    { db: input.db, encryptionKey: environmentsEncryptionKeyBytes(input.settings) ?? null },
    attemptPrincipal(input),
    { capabilityEnabled: secretsCapabilityEnabled(input.agentConfig) },
  );
}

const SAVE_TO_OWNER = { user: "user", task: "task", workspace: "workspace" } as const;

/**
 * Ask-card vault check (Q-05): a named vault must be reachable by this
 * attempt, belong to the chosen saveTo scope, and be a writable OpenGeni vault.
 * Returns a model-facing reason, or null when the vault can take the answer.
 */
export function attemptQuestionVaultValidator(
  input: Omit<AttemptSecretInput, "settings" | "agentConfig">,
) {
  return async ({
    vault,
    saveTo,
  }: {
    vault: string;
    saveTo: "user" | "task" | "workspace";
  }): Promise<string | null> => {
    const vaults = await listVaultsForSubject(
      input.db,
      { kind: "principal", principal: attemptPrincipal(input) },
      { workspaceId: input.workspaceId },
    );
    const wanted = vault.trim().toLowerCase();
    const match = vaults.find((row) => row.name.trim().toLowerCase() === wanted);
    if (!match) return "No vault with that name is reachable from this task.";
    if (match.source !== "opengeni" || match.mode !== "read_write") {
      return "It is a connected or read-only vault, so answers cannot be saved there.";
    }
    if (match.ownerKind !== SAVE_TO_OWNER[saveTo]) {
      return `It is not a "${saveTo}" vault.`;
    }
    return null;
  };
}

/**
 * Exec-boundary resolver (W1 delivery). Same attempt principal and capability
 * gate as every other surface; kept as a named entry point for the sandbox
 * tool wiring in agent-build.
 */
export function createAttemptSecretResolver(
  input: Omit<AttemptSecretInput, "agentConfig"> & {
    agent: ResolvedAgentConfig | null | undefined;
  },
): SecretResolver {
  const { agent, ...rest } = input;
  return attemptSecretResolver({ ...rest, agentConfig: agent });
}
