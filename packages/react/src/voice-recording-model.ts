import type { VoiceRecordingManifest } from "./voice-recording-store";

export function createVoiceRecordingManifest(input: {
  recordingId: string;
  workspaceId: string;
  mimeType: string;
  createdAt: string;
  ownerId?: string | null | undefined;
}): VoiceRecordingManifest {
  return {
    version: 1,
    recordingId: input.recordingId,
    workspaceId: input.workspaceId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    mimeType: input.mimeType,
    codec: codecForMimeType(input.mimeType),
    captureState: "capturing",
    uploadState: "pending",
    transcriptionState: "pending",
    finalizationState: "pending",
    recoveryMode: "automatic",
    handoffMode: "append",
    ownerId: input.ownerId ?? null,
    ownerHeartbeatAt: input.ownerId ? input.createdAt : null,
    transcriptText: null,
    nextChunkNumber: 0,
    chunkCount: 0,
    totalBytes: 0,
    totalDurationMilliseconds: 0,
  };
}

function codecForMimeType(mimeType: string): string | null {
  const match = /(?:^|;)\s*codecs?\s*=\s*"?([^;"]+)/iu.exec(mimeType);
  return match?.[1]?.trim().toLowerCase() ?? null;
}
