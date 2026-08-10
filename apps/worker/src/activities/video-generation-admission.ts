import {
  VideoGenerationAcceptedReceipt,
  type GenerateVideoToolInput,
  type VideoGenerationCapabilities,
  type VideoGenerationPolicy,
} from "@opengeni/contracts";
import {
  normalizeVideoGenerationRequest,
  videoGenerationAdmissionKey,
  videoGenerationProviderIdempotencyKey,
  videoGenerationRequestDigest,
} from "@opengeni/core";
import { videoGenerationCapabilitiesForPolicy } from "@opengeni/core";
import {
  admitVideoGenerationOperation,
  encryptEnvironmentValue,
  getVideoGenerationOperation,
  markVideoGenerationPrepared,
  type Database,
  type VideoGenerationReference,
} from "@opengeni/db";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import {
  inspectSandboxVideoReferences,
  uploadAndVerifyVideoReferences,
  videoReferenceStagingKey,
  type SandboxCommandRunner,
} from "./video-reference-staging";

export type WorkspaceGatewayVideoCredentialLease = Readonly<{
  connectionId: string;
  version: number;
  credentialEncrypted: string;
  apiKey: string;
}>;

export type AcceptedVideoGeneration = Readonly<{
  receipt: ReturnType<typeof VideoGenerationAcceptedReceipt.parse>;
  operationId: string;
  requestDigest: string;
}>;

export function videoCapabilitiesForTurn(input: {
  policy: VideoGenerationPolicy;
  credential: WorkspaceGatewayVideoCredentialLease;
}): VideoGenerationCapabilities {
  return videoGenerationCapabilitiesForPolicy({
    policy: input.policy,
    credentialVersion: input.credential.version,
  });
}

export async function admitVideoGenerationRequest(input: {
  db: Database;
  storage: ObjectStorage;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  toolInput: GenerateVideoToolInput;
  policy: VideoGenerationPolicy;
  credential: WorkspaceGatewayVideoCredentialLease;
  runCommand?: SandboxCommandRunner;
  signal?: AbortSignal;
}): Promise<AcceptedVideoGeneration> {
  const capabilities = videoCapabilitiesForTurn({
    policy: input.policy,
    credential: input.credential,
  });
  const selectedModelId = input.toolInput.modelId ?? capabilities.defaultModelId;
  const model = capabilities.models.find((candidate) => candidate.modelId === selectedModelId);
  if (!model) throw new Error("The requested video model is not enabled for this workspace");

  const sourceMode = input.toolInput.source?.mode ?? "text";
  if (sourceMode !== "text" && !input.runCommand) {
    throw new Error("Video references require an active sandbox");
  }
  const inspected = input.runCommand
    ? await inspectSandboxVideoReferences({
        request: input.toolInput,
        runCommand: input.runCommand,
      })
    : [];
  const canonical = normalizeVideoGenerationRequest({
    toolInput: input.toolInput,
    model,
    sealedReferences: inspected.map((reference) => ({
      role: reference.role,
      contentSha256: reference.sha256,
      contentType: reference.contentType,
      byteSize: reference.sizeBytes,
    })),
  });
  const requestDigest = videoGenerationRequestDigest(canonical);
  const admissionKey = videoGenerationAdmissionKey(input);
  const candidateOperationId = randomUUID();
  const expectedArtifactId = randomUUID();
  const expectedFileId = randomUUID();
  const providerIdempotencyKey = videoGenerationProviderIdempotencyKey({
    operationId: candidateOperationId,
    requestDigest,
  });
  const encryptionKey = environmentsEncryptionKeyBytes(input.settings);
  if (!encryptionKey) {
    throw new Error("Video generation requires OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  const now = Date.now();
  const recoveryDeadlineAt = new Date(now + input.settings.videoGenerationRecoveryDeadlineMs);
  const stagingKeys = inspected.map((reference) =>
    videoReferenceStagingKey({
      workspaceId: input.workspaceId,
      operationId: candidateOperationId,
      ordinal: reference.ordinal,
      sha256: reference.sha256,
    }),
  );
  const admitted = await admitVideoGenerationOperation(input.db, {
    id: candidateOperationId,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    toolCallId: input.toolCallId,
    admissionKey,
    requestDigest,
    promptDigest: createHash("sha256").update(canonical.prompt).digest("hex"),
    requestEncrypted: encryptEnvironmentValue(encryptionKey, JSON.stringify(canonical)),
    modelId: canonical.modelId,
    sourceMode: canonical.sourceMode,
    capabilityRevision: capabilities.capabilityRevision,
    policyRevision: input.policy.revision,
    connectionId: input.credential.connectionId,
    credentialVersion: input.credential.version,
    credentialEncrypted: input.credential.credentialEncrypted,
    providerIdempotencyKey,
    expectedArtifactId,
    expectedFileId,
    workspaceQuotaBytes: input.settings.videoGenerationWorkspaceQuotaBytes,
    maxConcurrentPerWorkspace: input.settings.videoGenerationMaxConcurrentPerWorkspace,
    recoveryDeadlineAt,
    references: inspected.map((reference, index) => ({
      ordinal: reference.ordinal,
      role: reference.role,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes,
      sha256: reference.sha256,
      stagingObjectKey: stagingKeys[index]!,
      grantExpiresAt: null,
      cleanupAfter: recoveryDeadlineAt,
    })),
  });
  const operation = await getVideoGenerationOperation(
    input.db,
    input.workspaceId,
    admitted.operation.id,
  );
  if (!operation) throw new Error("Admitted video generation operation disappeared");
  if (operation.status === "preparing") {
    assertStoredReferencePlan(operation.references, inspected);
    if (inspected.length > 0) {
      if (!input.runCommand) throw new Error("Prepared video references lost their sandbox");
      await uploadAndVerifyVideoReferences({
        storage: input.storage,
        references: inspected,
        stagingKeys: operation.references.map((reference) => {
          if (!reference.stagingObjectKey) {
            throw new Error("Video reference staging key is missing");
          }
          return reference.stagingObjectKey;
        }),
        runCommand: input.runCommand,
        tempRoot: input.settings.videoGenerationTempDirectory,
        ffprobePath: input.settings.videoGenerationFfprobePath,
        uploadTtlSeconds: input.settings.videoGenerationReferenceUrlTtlSeconds,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    await markVideoGenerationPrepared(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: operation.id,
      requestDigest,
    });
  } else if (
    ![
      "prepared",
      "accepted",
      "submission_uncertain",
      "provider_started",
      "retaining",
      "completed",
    ].includes(operation.status)
  ) {
    throw new Error("The existing video generation request cannot be resumed");
  }
  return {
    receipt: VideoGenerationAcceptedReceipt.parse({
      schemaVersion: 1,
      status: "accepted",
      operationId: operation.id,
    }),
    operationId: operation.id,
    requestDigest,
  };
}

function assertStoredReferencePlan(
  stored: VideoGenerationReference[],
  inspected: Awaited<ReturnType<typeof inspectSandboxVideoReferences>>,
): void {
  if (
    stored.length !== inspected.length ||
    stored.some((reference, index) => {
      const source = inspected[index];
      return (
        !source ||
        reference.ordinal !== source.ordinal ||
        reference.role !== source.role ||
        reference.contentType !== source.contentType ||
        reference.sizeBytes !== source.sizeBytes ||
        reference.sha256 !== source.sha256
      );
    })
  ) {
    throw new Error("Video reference bytes changed across tool-call recovery");
  }
}
