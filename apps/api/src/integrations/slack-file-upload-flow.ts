/** Durability port: checkpoints must be lease-fenced before any provider write. */
export type SlackFileUploadPhase =
  | "pending"
  | "uploading"
  | "uploaded"
  | "completing"
  | "outcome_unknown"
  | "completed";

export type SlackFileUploadState = {
  phase: SlackFileUploadPhase;
  slackFileId: string | null;
};

export type SlackFileUploadProvider = {
  allocateFileUpload(input: {
    channelId: string;
    privateRecipientSlackUserId?: string;
    filename: string;
    sizeBytes: number;
  }): Promise<{ fileId: string; uploadUrl: URL }>;
  transferFileUpload(input: {
    channelId: string;
    privateRecipientSlackUserId?: string;
    uploadUrl: URL;
    bytes: Uint8Array;
  }): Promise<unknown>;
  completeFileUpload(input: {
    channelId: string;
    privateRecipientSlackUserId?: string;
    threadTimestamp: string;
    fileId: string;
    title: string;
  }): Promise<unknown>;
  reconcileFileUpload(input: {
    channelId: string;
    privateRecipientSlackUserId?: string;
    threadTimestamp: string;
    fileId: string;
  }): Promise<{ shared: boolean }>;
};

export class SlackFileUploadClaimLostError extends Error {
  constructor() {
    super("Slack file upload claim was lost; retry with the same operationId");
    this.name = "SlackFileUploadClaimLostError";
  }
}

export class SlackFileUploadOutcomeUnknownError extends Error {
  constructor() {
    super(
      "Slack file delivery is not yet confirmed; retry with the same operationId. Do not start a new upload.",
    );
    this.name = "SlackFileUploadOutcomeUnknownError";
  }
}

/** No automatic retries. An uncertain completion is reconciled, never resent. */
export async function runSlackFileUpload(input: {
  state: SlackFileUploadState;
  provider: SlackFileUploadProvider;
  checkpoint: (update: {
    expectedPhase: SlackFileUploadPhase;
    phase: SlackFileUploadPhase;
    slackFileId?: string;
  }) => Promise<boolean>;
  channelId: string;
  privateRecipientSlackUserId?: string;
  threadTimestamp: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<{ slackFileId: string; replayed: boolean }> {
  let phase = input.state.phase;
  let fileId = input.state.slackFileId;
  const checkpoint = async (next: SlackFileUploadPhase, allocatedFileId?: string) => {
    if (
      !(await input.checkpoint({
        expectedPhase: phase,
        phase: next,
        ...(allocatedFileId ? { slackFileId: allocatedFileId } : {}),
      }))
    ) {
      throw new SlackFileUploadClaimLostError();
    }
    phase = next;
    if (allocatedFileId) fileId = allocatedFileId;
  };
  const requireFileId = () => {
    if (!fileId) throw new Error("Slack upload checkpoint is missing its provider file identity");
    return fileId;
  };

  if (phase === "completed") return { slackFileId: requireFileId(), replayed: true };
  if (phase === "completing" || phase === "outcome_unknown") {
    const id = requireFileId();
    const result = await input.provider.reconcileFileUpload({
      channelId: input.channelId,
      ...(input.privateRecipientSlackUserId
        ? { privateRecipientSlackUserId: input.privateRecipientSlackUserId }
        : {}),
      threadTimestamp: input.threadTimestamp,
      fileId: id,
    });
    if (!result.shared) throw new SlackFileUploadOutcomeUnknownError();
    await checkpoint("completed");
    return { slackFileId: id, replayed: true };
  }

  if (phase === "pending" || phase === "uploading") {
    // A lost byte-transfer response may leave an unshared temporary file.
    // Replacement is safe ONLY before the completing checkpoint. The old
    // worker is fenced from completing it, and Slack discards unfinished files.
    const allocated = await input.provider.allocateFileUpload({
      channelId: input.channelId,
      ...(input.privateRecipientSlackUserId
        ? { privateRecipientSlackUserId: input.privateRecipientSlackUserId }
        : {}),
      filename: input.filename,
      sizeBytes: input.bytes.byteLength,
    });
    await checkpoint("uploading", allocated.fileId);
    await input.provider.transferFileUpload({
      channelId: input.channelId,
      ...(input.privateRecipientSlackUserId
        ? { privateRecipientSlackUserId: input.privateRecipientSlackUserId }
        : {}),
      uploadUrl: allocated.uploadUrl,
      bytes: input.bytes,
    });
    await checkpoint("uploaded");
  }

  const id = requireFileId();
  await checkpoint("completing");
  await input.provider.completeFileUpload({
    channelId: input.channelId,
    ...(input.privateRecipientSlackUserId
      ? { privateRecipientSlackUserId: input.privateRecipientSlackUserId }
      : {}),
    threadTimestamp: input.threadTimestamp,
    fileId: id,
    title: input.filename,
  });
  await checkpoint("completed");
  return { slackFileId: id, replayed: false };
}
