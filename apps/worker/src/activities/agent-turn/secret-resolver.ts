import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  agentCapabilityEnabled,
  type ResolvedAgentCapabilities,
  type SecretResolver,
} from "@opengeni/contracts";
import { createSecretResolver } from "@opengeni/core";
import type { Database } from "@opengeni/db";

/**
 * The attempt's secret resolver (W1 delivery, §10B.2). Every `{{secret:…}}`
 * reference a sandbox tool carries resolves at the physical exec boundary
 * under this exact attempt principal. `agent.capabilities.secrets` gates it;
 * sessions without an agent configuration default on (D25).
 */
export function createAttemptSecretResolver(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  agent: { capabilities: ResolvedAgentCapabilities } | null | undefined;
}): SecretResolver {
  return createSecretResolver(
    { db: input.db, encryptionKey: environmentsEncryptionKeyBytes(input.settings) ?? null },
    {
      kind: "attempt",
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
    },
    {
      capabilityEnabled: input.agent
        ? agentCapabilityEnabled(input.agent.capabilities, "secrets")
        : true,
    },
  );
}
