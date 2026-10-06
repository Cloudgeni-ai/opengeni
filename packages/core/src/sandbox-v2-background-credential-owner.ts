import type {
  SandboxV2CredentialGenerationDefinition,
  RunCredentialsResolution,
} from "@opengeni/contracts";
import {
  loadSandboxV2BackgroundCredentialGeneration,
  loadSandboxV2BackgroundCredentialGenerationMetadata,
  retainSandboxV2BackgroundCredentialGeneration,
  SandboxV2CredentialGenerationError,
  type Database,
  type SandboxV2BackgroundCredentialAuthority,
} from "@opengeni/db";
import {
  createRetainedSandboxV2CredentialGenerationOwner,
  type RetainedSandboxV2CredentialOwnerOptions,
} from "./sandbox-v2-retained-credential-owner";
import { journalSpecificationDigest } from "@opengeni/runtime/sandbox";
import { buildSandboxV2BackgroundCredentialCleanupRequest } from "./sandbox-v2-credential-cleanup";

/** One original job generation. Initial creation requires its original live
 * prelaunch authority; recovery checks current job and resource grants before
 * decryption. The job ID participates in the authenticated body. This installs
 * fixed cleanup custody before delivery, with no renewal, background execution
 * or admission. It accepts no replacement broker for an ended turn. */
export function createSandboxV2BackgroundCredentialGenerationOwner(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxV2CredentialGenerationDefinition,
  options: Omit<RetainedSandboxV2CredentialOwnerOptions, "persistence" | "resolve"> & {
    /** Already-authorized original material. No broker or renewal callback is
     * accepted; a recovering observer needs only the existing sealed original. */
    source?: RunCredentialsResolution;
  },
) {
  const { source: suppliedSource, ...ownerOptions } = options;
  const source = suppliedSource === undefined ? undefined : structuredClone(suppliedSource);
  const context: SandboxV2BackgroundCredentialAuthority = {
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    attemptId: authority.attemptId,
    executionGeneration: authority.executionGeneration,
    machineId: authority.machineId,
    instance: structuredClone(authority.instance),
    jobId: authority.jobId,
  };
  return createRetainedSandboxV2CredentialGenerationOwner(context, input, {
    ...ownerOptions,
    resolve: async () => {
      if (source === undefined) throw new SandboxV2CredentialGenerationError();
      return structuredClone(source);
    },
    persistence: {
      load: (definition) => loadSandboxV2BackgroundCredentialGeneration(db, context, definition),
      retain: (definition, sealed) =>
        retainSandboxV2BackgroundCredentialGeneration(
          db,
          context,
          definition,
          sealed,
          (operationId) =>
            journalSpecificationDigest(
              buildSandboxV2BackgroundCredentialCleanupRequest(context, operationId),
            ),
        ),
      metadata: (definition) =>
        loadSandboxV2BackgroundCredentialGenerationMetadata(db, context, definition),
    },
  });
}
