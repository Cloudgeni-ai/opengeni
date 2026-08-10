import {
  GenerateVideoToolInput,
  VideoGenerationAspectRatio,
  VideoGenerationResolution,
  VideoGenerationSourceMode,
  type GenerateVideoToolInput as GenerateVideoToolInputType,
  type VideoGenerationModelCapability,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";

export const VIDEO_GENERATION_ADAPTER_VERSION = "gateway-video-v4/1" as const;

export type SealedVideoReferenceRole =
  | "first_frame"
  | "last_frame"
  | "image_reference"
  | "video_reference";

export type SealedVideoReference = Readonly<{
  role: SealedVideoReferenceRole;
  contentSha256: string;
  contentType: string;
  byteSize: number;
}>;

export type CanonicalVideoGenerationRequest = Readonly<{
  schemaVersion: 1;
  modelId: string;
  prompt: string;
  sourceMode: VideoGenerationSourceMode;
  references: readonly SealedVideoReference[];
  durationSeconds: number;
  aspectRatio: VideoGenerationAspectRatio;
  resolution: VideoGenerationResolution;
  generateAudio: boolean;
}>;

export type VideoGenerationOperationState =
  | "preparing"
  | "prepared"
  | "accepted"
  | "submission_uncertain"
  | "provider_started"
  | "retaining"
  | "completed"
  | "provider_failed"
  | "cancelled_before_submit"
  | "outcome_unknown"
  | "retention_failed";

const TERMINAL_STATES = new Set<VideoGenerationOperationState>([
  "completed",
  "provider_failed",
  "cancelled_before_submit",
  "outcome_unknown",
  "retention_failed",
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<VideoGenerationOperationState, readonly VideoGenerationOperationState[]>
> = Object.freeze({
  preparing: ["prepared", "cancelled_before_submit"],
  prepared: ["accepted", "cancelled_before_submit"],
  accepted: ["submission_uncertain", "provider_started", "cancelled_before_submit"],
  submission_uncertain: ["provider_started", "outcome_unknown"],
  provider_started: ["retaining", "provider_failed", "outcome_unknown"],
  retaining: ["completed", "retention_failed"],
  completed: [],
  provider_failed: [],
  cancelled_before_submit: [],
  outcome_unknown: [],
  retention_failed: [],
});

export function normalizeVideoGenerationRequest(input: {
  toolInput: GenerateVideoToolInputType;
  model: VideoGenerationModelCapability;
  sealedReferences: readonly SealedVideoReference[];
}): CanonicalVideoGenerationRequest {
  const toolInput = GenerateVideoToolInput.parse(input.toolInput);
  if (toolInput.modelId !== undefined && toolInput.modelId !== input.model.modelId) {
    throw new Error("Video generation model changed during admission");
  }
  const sourceMode = toolInput.source?.mode ?? "text";
  if (!input.model.sourceModes.includes(sourceMode)) {
    throw new Error(`Video generation source mode ${sourceMode} is unavailable`);
  }
  assertReferenceRoles(sourceMode, input.sealedReferences);

  const durationSeconds = toolInput.durationSeconds ?? input.model.duration.minSeconds;
  if (
    durationSeconds < input.model.duration.minSeconds ||
    durationSeconds > input.model.duration.maxSeconds ||
    (durationSeconds - input.model.duration.minSeconds) % input.model.duration.stepSeconds !== 0
  ) {
    throw new Error("Video generation duration is unavailable for the selected model");
  }
  const aspectRatio = toolInput.aspectRatio ?? input.model.aspectRatios[0];
  const resolution = toolInput.resolution ?? input.model.resolutions[0];
  if (!aspectRatio || !input.model.aspectRatios.includes(aspectRatio)) {
    throw new Error("Video generation aspect ratio is unavailable for the selected model");
  }
  if (!resolution || !input.model.resolutions.includes(resolution)) {
    throw new Error("Video generation resolution is unavailable for the selected model");
  }
  const generateAudio = toolInput.generateAudio ?? input.model.supportsAudio;
  if (generateAudio && !input.model.supportsAudio) {
    throw new Error("Audio generation is unavailable for the selected model");
  }

  return Object.freeze({
    schemaVersion: 1,
    modelId: input.model.modelId,
    prompt: toolInput.prompt,
    sourceMode,
    references: Object.freeze(
      input.sealedReferences.map((reference) => Object.freeze({ ...reference })),
    ),
    durationSeconds,
    aspectRatio,
    resolution,
    generateAudio,
  });
}

export function canonicalVideoGenerationRequestJson(
  request: CanonicalVideoGenerationRequest,
): string {
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    modelId: request.modelId,
    prompt: request.prompt,
    sourceMode: request.sourceMode,
    references: request.references.map((reference) => ({
      role: reference.role,
      contentSha256: reference.contentSha256,
      contentType: reference.contentType,
      byteSize: reference.byteSize,
    })),
    durationSeconds: request.durationSeconds,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    generateAudio: request.generateAudio,
  });
}

export function videoGenerationRequestDigest(request: CanonicalVideoGenerationRequest): string {
  return sha256(
    "opengeni:video-generation-request:v1\0",
    canonicalVideoGenerationRequestJson(request),
  );
}

/** Stable only for one logical tool call; intentional identical calls remain distinct. */
export function videoGenerationAdmissionKey(input: {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
}): string {
  return sha256(
    "opengeni:video-generation-admission:v1\0",
    input.workspaceId,
    input.sessionId,
    input.turnId,
    input.toolCallId,
  );
}

export function videoGenerationProviderIdempotencyKey(input: {
  operationId: string;
  requestDigest: string;
}): string {
  return `ogvid_${sha256(
    "opengeni:video-generation-provider-start:v1\0",
    input.operationId,
    input.requestDigest,
  ).slice(0, 48)}`;
}

export function videoGenerationCapabilityRevision(input: {
  policyRevision: number;
  credentialVersion: number;
  modelIds: readonly string[];
}): string {
  return sha256(
    "opengeni:video-generation-capability:v1\0",
    String(input.policyRevision),
    String(input.credentialVersion),
    JSON.stringify([...input.modelIds].sort()),
    VIDEO_GENERATION_ADAPTER_VERSION,
  );
}

export function assertVideoGenerationTransition(
  from: VideoGenerationOperationState,
  to: VideoGenerationOperationState,
): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid video generation transition ${from} -> ${to}`);
  }
}

export function isTerminalVideoGenerationState(state: VideoGenerationOperationState): boolean {
  return TERMINAL_STATES.has(state);
}

function assertReferenceRoles(
  sourceMode: VideoGenerationSourceMode,
  references: readonly SealedVideoReference[],
): void {
  const expected: readonly SealedVideoReferenceRole[] =
    sourceMode === "text"
      ? []
      : sourceMode === "first_frame"
        ? ["first_frame"]
        : sourceMode === "first_and_last_frames"
          ? ["first_frame", "last_frame"]
          : sourceMode === "image_reference"
            ? ["image_reference"]
            : ["video_reference"];
  if (
    references.length !== expected.length ||
    references.some((reference, index) => reference.role !== expected[index])
  ) {
    throw new Error(`Sealed references do not match video source mode ${sourceMode}`);
  }
  for (const reference of references) {
    if (!/^[0-9a-f]{64}$/u.test(reference.contentSha256)) {
      throw new Error("Video reference has an invalid SHA-256 digest");
    }
    if (!Number.isSafeInteger(reference.byteSize) || reference.byteSize <= 0) {
      throw new Error("Video reference has an invalid byte size");
    }
    if (!reference.contentType.includes("/")) {
      throw new Error("Video reference has an invalid content type");
    }
  }
}

function sha256(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(prefix);
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
