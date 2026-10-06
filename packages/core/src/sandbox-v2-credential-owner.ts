import type { SandboxV2CredentialGenerationDefinition } from "@opengeni/contracts";
import {
  loadSandboxV2CredentialGeneration,
  loadSandboxV2CredentialGenerationMetadata,
  retainSandboxV2CredentialGeneration,
  type Database,
  type SandboxJournalControlAuthority,
} from "@opengeni/db";
import {
  createRetainedSandboxV2CredentialGenerationOwner,
  type RetainedSandboxV2CredentialOwnerOptions,
} from "./sandbox-v2-retained-credential-owner";

/** Host recovery owner for ONE exact immutable generation. The broker callback
 * runs only while no original has been retained. Concurrent candidates converge
 * before native stdin is used. Every read rechecks current credential grants and
 * live attempt/incarnation authority before decrypting. An expired, cleared or
 * incompatible original fails; recovery never replaces it with refreshed bytes.
 *
 * Encryption reuses the operator's existing AES-GCM envelope; the authenticated
 * payload includes complete original authority and nonsecret request definition.
 * The key stays outside Postgres. This owner does not activate a renewal, own
 * guest cleanup, or let a control worker launch a new setup command. */
export function createSandboxV2CredentialGenerationOwner(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxV2CredentialGenerationDefinition,
  options: Omit<RetainedSandboxV2CredentialOwnerOptions, "persistence">,
) {
  const context: SandboxJournalControlAuthority = {
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    attemptId: authority.attemptId,
    executionGeneration: authority.executionGeneration,
    machineId: authority.machineId,
    instance: structuredClone(authority.instance),
  };
  return createRetainedSandboxV2CredentialGenerationOwner(context, input, {
    ...options,
    persistence: {
      load: (definition) => loadSandboxV2CredentialGeneration(db, context, definition),
      retain: (definition, sealed) =>
        retainSandboxV2CredentialGeneration(db, context, definition, sealed),
      metadata: (definition) => loadSandboxV2CredentialGenerationMetadata(db, context, definition),
    },
  });
}
