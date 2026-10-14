/**
 * The attempt's secret resolver: `{{secret:…}}` references in tool calls
 * resolve with this exact live attempt's vault reach (§10B.2). With the
 * `secrets` capability off the resolver is disabled and every surface passes
 * references through literally (AG-4).
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  VAULT_LIMITS,
  type ResolvedAgentConfig,
  type SecretPrincipal,
  type SecretResolver,
} from "@opengeni/contracts";
import {
  createSecretResolver,
  createWorkspaceVaultProviderRegistry,
  type OnePasswordVaultProviderFactory,
} from "@opengeni/core";
import { listVaultsForSubject, type Database } from "@opengeni/db";
import {
  createProviderCallBudget,
  type ProviderCallBudget,
  type VaultProvider,
  type VaultProviderRegistry,
} from "@opengeni/vaults";

/**
 * Q-17: a frozen configuration without the key reads `from === "all"` (the
 * contracts parse fills it); legacy null-config sessions get secrets on.
 */
export function secretsCapabilityEnabled(agentConfig: ResolvedAgentConfig | null | undefined) {
  return agentConfig ? agentConfig.capabilities.secrets === true : true;
}

/**
 * Connected-vault access for one attempt: the provider registry (1Password
 * tokens load for the acting human, host vaults use the embedder port) and a
 * single read budget shared by every resolver of the attempt (Q-18).
 */
export type AttemptVaultAccess = {
  providers: VaultProviderRegistry;
  attemptBudget: ProviderCallBudget;
};

export function createAttemptVaultAccess(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  subjectId: string | null;
  hostVaultProvider: VaultProvider | null | undefined;
  onePasswordVaultProvider: OnePasswordVaultProviderFactory | null | undefined;
}): AttemptVaultAccess {
  return {
    providers: createWorkspaceVaultProviderRegistry({
      db: input.db,
      settings: input.settings,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      hostVaultProvider: input.hostVaultProvider ?? null,
      onePasswordVaultProvider: input.onePasswordVaultProvider ?? null,
    }),
    attemptBudget: createProviderCallBudget(VAULT_LIMITS.providerReadsPerAttempt),
  };
}

type AttemptSecretInput = {
  db: Database;
  settings: Settings;
  agentConfig: ResolvedAgentConfig | null | undefined;
  vaultAccess?: AttemptVaultAccess | undefined;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function attemptPrincipal(
  input: Omit<AttemptSecretInput, "db" | "settings" | "agentConfig" | "vaultAccess">,
) {
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
    {
      db: input.db,
      encryptionKey: environmentsEncryptionKeyBytes(input.settings) ?? null,
      ...(input.vaultAccess ? { providers: input.vaultAccess.providers } : {}),
    },
    attemptPrincipal(input),
    {
      capabilityEnabled: secretsCapabilityEnabled(input.agentConfig),
      ...(input.vaultAccess ? { attemptBudget: input.vaultAccess.attemptBudget } : {}),
    },
  );
}

const SAVE_TO_OWNER = { user: "user", task: "task", workspace: "workspace" } as const;

/**
 * Ask-card vault check (Q-05): a named vault must be reachable by this
 * attempt, belong to the chosen saveTo scope, and be a writable Opengeni vault.
 * Returns a model-facing reason, or null when the vault can take the answer.
 */
export function attemptQuestionVaultValidator(
  input: Omit<AttemptSecretInput, "settings" | "agentConfig" | "vaultAccess">,
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
