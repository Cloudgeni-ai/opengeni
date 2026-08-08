import {
  beginImageGenerationOperation,
  completeImageGenerationOperation,
  getGeneratedImageArtifact,
  markImageGenerationOperationOutcomeUnknown,
  markImageGenerationOperationRetentionFailed,
  prepareImageGenerationOperation,
  type Database,
  type ImageGenerationOperationStatus,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";
import {
  generatedImageIdentity,
  recoverGeneratedImageArtifact,
  retainGeneratedImage,
  retainedGeneratedImageFromArtifact,
  verifyReadyGeneratedImageArtifact,
  type GeneratedImageOutput,
  type GeneratedImageReceipt,
} from "./generated-images";

export class ImageGenerationOutcomeUnknownError extends Error {
  constructor(readonly operationId: string) {
    super(
      "The image provider request may have completed, but no durable result was recovered. It was not retried to avoid duplicate work or charges.",
    );
    this.name = "ImageGenerationOutcomeUnknownError";
  }
}

export class ImageGenerationRetentionFailedError extends Error {
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      "The image was generated, but OpenGeni could not save it. The paid provider request was not repeated.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "ImageGenerationRetentionFailedError";
  }
}

export type ImageGenerationOperationPorts = {
  prepare: typeof prepareImageGenerationOperation;
  begin: typeof beginImageGenerationOperation;
  retain: typeof retainGeneratedImage;
  complete: typeof completeImageGenerationOperation;
  markOutcomeUnknown: typeof markImageGenerationOperationOutcomeUnknown;
  markRetentionFailed: typeof markImageGenerationOperationRetentionFailed;
  recover: typeof recoverCompletedImage;
};

const imageGenerationOperationPorts: ImageGenerationOperationPorts = {
  prepare: prepareImageGenerationOperation,
  begin: beginImageGenerationOperation,
  retain: retainGeneratedImage,
  complete: completeImageGenerationOperation,
  markOutcomeUnknown: markImageGenerationOperationOutcomeUnknown,
  markRetentionFailed: markImageGenerationOperationRetentionFailed,
  recover: recoverCompletedImage,
};

/**
 * Durable admission fence shared by every client-executed image provider.
 * Provider execution is permitted at most once after the prepared ->
 * provider_started transition. A crash at that boundary may conservatively
 * leave the outcome unknown; a retry may recover a ready artifact, but never
 * blindly replays the paid operation.
 */
export type ExecuteImageGenerationOperationInput = {
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  providerId: string;
  providerBindingHash: string;
  modelId: string;
  prompt: string;
  generate: () => Promise<GeneratedImageOutput>;
};

export async function executeImageGenerationOperation(
  input: ExecuteImageGenerationOperationInput,
  ports: ImageGenerationOperationPorts = imageGenerationOperationPorts,
): Promise<GeneratedImageReceipt> {
  const identity = imageGenerationOperationIdentity({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.providerId,
    providerBindingHash: input.providerBindingHash,
    modelId: input.modelId,
    prompt: input.prompt,
    toolCallId: input.toolCallId,
  });
  const prepared = await ports.prepare(input.db, {
    id: identity.operationId,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    operationKey: identity.operationKey,
    toolCallId: input.toolCallId,
    providerId: input.providerId,
    providerBindingHash: input.providerBindingHash,
    modelId: input.modelId,
    requestDigest: identity.requestDigest,
    expectedArtifactId: identity.artifactId,
  });

  if (prepared.operation.status !== "prepared") {
    const recovered = await ports.recover(input, {
      artifactId: identity.artifactId,
      operationId: identity.operationId,
      operationKey: identity.operationKey,
    });
    if (recovered) return recovered;
    throw unrecoveredOperationError(prepared.operation.status, identity.operationId);
  }

  const begun = await ports.begin(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    operationId: identity.operationId,
    operationKey: identity.operationKey,
  });
  if (!begun.started || begun.operation.status !== "provider_started") {
    const recovered = await ports.recover(input, {
      artifactId: identity.artifactId,
      operationId: identity.operationId,
      operationKey: identity.operationKey,
    });
    if (recovered) return recovered;
    throw unrecoveredOperationError(begun.operation.status, identity.operationId);
  }

  let output: GeneratedImageOutput;
  try {
    output = await input.generate();
  } catch (error) {
    await ports
      .markOutcomeUnknown(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }

  try {
    if (output.toolCallId !== input.toolCallId || output.providerItemId !== null) {
      throw new Error("Client image provider returned a mismatched operation identity");
    }
    const retained = await ports.retain({
      db: input.db,
      objectStorage: input.objectStorage,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      sourceStrategy: "provider_adapter",
      providerId: input.providerId,
      providerBindingHash: input.providerBindingHash,
      output,
    });
    await ports.complete(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: identity.operationId,
      operationKey: identity.operationKey,
    });
    return retained.receipt;
  } catch (error) {
    await ports
      .markRetentionFailed(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: identity.operationId,
        operationKey: identity.operationKey,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw new ImageGenerationRetentionFailedError(identity.operationId, error);
  }
}

function unrecoveredOperationError(
  status: ImageGenerationOperationStatus,
  operationId: string,
): Error {
  return status === "retention_failed"
    ? new ImageGenerationRetentionFailedError(operationId)
    : new ImageGenerationOutcomeUnknownError(operationId);
}

export function imageProviderBindingHash(providerId: string, credentialIdentity: string): string {
  if (!providerId.trim() || !credentialIdentity.trim()) {
    throw new Error("Image provider binding identity is empty");
  }
  return digest("opengeni:image-provider-binding:v1\0", providerId, credentialIdentity);
}

/** Stable across worker/Temporal attempt retries; the attempt id is provenance, not identity. */
export function imageGenerationOperationIdentity(input: {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  providerId: string;
  providerBindingHash: string;
  modelId: string;
  prompt: string;
}): {
  operationId: string;
  operationKey: string;
  requestDigest: string;
  artifactId: string;
} {
  const requestDigest = digest(
    "opengeni:image-generation-request:v1\0",
    input.modelId,
    input.prompt,
  );
  const operationKey = digest(
    "opengeni:image-generation-operation:v2\0",
    input.workspaceId,
    input.sessionId,
    input.turnId,
    input.toolCallId,
  );
  const artifact = generatedImageIdentity({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    sourceStrategy: "provider_adapter",
    providerId: input.providerId,
    providerBindingHash: input.providerBindingHash,
    providerItemId: null,
    toolCallId: input.toolCallId,
  });
  return {
    operationId: uuidFromDigest(operationKey),
    operationKey,
    requestDigest,
    artifactId: artifact.artifactId,
  };
}

async function recoverCompletedImage(
  input: Pick<
    Parameters<typeof executeImageGenerationOperation>[0],
    | "db"
    | "objectStorage"
    | "accountId"
    | "workspaceId"
    | "sessionId"
    | "turnId"
    | "toolCallId"
    | "providerId"
    | "providerBindingHash"
  >,
  identity: { artifactId: string; operationId: string; operationKey: string },
): Promise<GeneratedImageReceipt | null> {
  const artifact = await getGeneratedImageArtifact(
    input.db,
    input.workspaceId,
    identity.artifactId,
  );
  if (!artifact) return null;
  if (
    artifact.sourceStrategy !== "provider_adapter" ||
    artifact.sessionId !== input.sessionId ||
    artifact.turnId !== input.turnId ||
    artifact.toolCallId !== input.toolCallId ||
    artifact.providerId !== input.providerId ||
    artifact.providerBindingHash !== input.providerBindingHash ||
    artifact.providerItemId !== null
  ) {
    throw new Error("Recovered generated image does not match its provider operation");
  }
  if (!input.objectStorage) {
    throw new Error("Recovered generated image requires configured object storage");
  }
  const recovered = await recoverGeneratedImageArtifact({
    db: input.db,
    storage: input.objectStorage,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    artifact,
  });
  if (!recovered) return null;
  await verifyReadyGeneratedImageArtifact(input.objectStorage, recovered);
  await completeImageGenerationOperation(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    operationId: identity.operationId,
    operationKey: identity.operationKey,
  });
  return retainedGeneratedImageFromArtifact(recovered).receipt;
}

function digest(prefix: string, ...values: string[]): string {
  const hash = createHash("sha256").update(prefix);
  for (const value of values) hash.update(value).update("\0");
  return hash.digest("hex");
}

function uuidFromDigest(digestValue: string): string {
  const bytes = Uint8Array.from(Buffer.from(digestValue.slice(0, 32), "hex"));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
