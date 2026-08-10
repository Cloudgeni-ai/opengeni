import { z } from "zod";
import {
  GENERATED_VIDEO_MAX_BYTES,
  RETAINED_OUTPUT_MAX_PAGE_BYTES,
  RetainedArtifactReferenceSchema,
} from "./retained-output";

export const VIDEO_GENERATION_SCHEMA_VERSION = 1 as const;
export const SEEDANCE_2_5_MODEL_ID = "bytedance/seedance-2.5" as const;

export const VideoGenerationSourceMode = z.enum([
  "text",
  "first_frame",
  "first_and_last_frames",
  "image_reference",
  "video_reference",
]);
export type VideoGenerationSourceMode = z.infer<typeof VideoGenerationSourceMode>;

export const VideoGenerationResolution = z.enum(["480p", "720p"]);
export type VideoGenerationResolution = z.infer<typeof VideoGenerationResolution>;

export const VideoGenerationFundingSource = z.enum(["opengeni_credits", "workspace_gateway"]);
export type VideoGenerationFundingSource = z.infer<typeof VideoGenerationFundingSource>;

export const VideoGenerationAspectRatio = z.enum([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
  "adaptive",
]);
export type VideoGenerationAspectRatio = z.infer<typeof VideoGenerationAspectRatio>;

const SandboxVideoReferencePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/workspace/"), {
    message: "video references must use an absolute /workspace path",
  });

export const VideoGenerationSource = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text") }).strict(),
  z
    .object({
      mode: z.literal("first_frame"),
      imagePath: SandboxVideoReferencePath,
    })
    .strict(),
  z
    .object({
      mode: z.literal("first_and_last_frames"),
      firstFramePath: SandboxVideoReferencePath,
      lastFramePath: SandboxVideoReferencePath,
    })
    .strict()
    .refine((value) => value.firstFramePath !== value.lastFramePath, {
      path: ["lastFramePath"],
      message: "first and last frame paths must differ",
    }),
  z
    .object({
      mode: z.literal("image_reference"),
      imagePath: SandboxVideoReferencePath,
    })
    .strict(),
  z
    .object({
      mode: z.literal("video_reference"),
      videoPath: SandboxVideoReferencePath,
    })
    .strict(),
]);
export type VideoGenerationSource = z.infer<typeof VideoGenerationSource>;

/** Stable provider-neutral function-tool input. Dynamic capability facts never enter this schema. */
export const GenerateVideoToolInput = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => value.trim().length > 0),
    modelId: z.string().min(1).max(256).optional(),
    source: VideoGenerationSource.optional(),
    durationSeconds: z.number().int().min(4).max(30).optional(),
    aspectRatio: VideoGenerationAspectRatio.optional(),
    resolution: VideoGenerationResolution.optional(),
    generateAudio: z.boolean().optional(),
  })
  .strict();
export type GenerateVideoToolInput = z.infer<typeof GenerateVideoToolInput>;

export const GetVideoGenerationCapabilitiesToolInput = z.object({}).strict();
export type GetVideoGenerationCapabilitiesToolInput = z.infer<
  typeof GetVideoGenerationCapabilitiesToolInput
>;

export const VideoGenerationModelCapability = z
  .object({
    modelId: z.string().min(1).max(256),
    label: z.string().min(1).max(128),
    providerLabel: z.string().min(1).max(128),
    sourceModes: z.array(VideoGenerationSourceMode).min(1).max(5),
    resolutions: z.array(VideoGenerationResolution).min(1).max(2),
    aspectRatios: z.array(VideoGenerationAspectRatio).min(1).max(7),
    duration: z
      .object({
        minSeconds: z.number().int().positive(),
        maxSeconds: z.number().int().positive(),
        stepSeconds: z.number().int().positive(),
      })
      .strict()
      .refine((value) => value.maxSeconds >= value.minSeconds),
    supportsAudio: z.boolean(),
  })
  .strict();
export type VideoGenerationModelCapability = z.infer<typeof VideoGenerationModelCapability>;

export const VideoGenerationCapabilities = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    capabilityRevision: z.string().min(1).max(128),
    defaultModelId: z.string().min(1).max(256),
    models: z.array(VideoGenerationModelCapability).min(1).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.models.map((model) => model.modelId));
    if (ids.size !== value.models.length) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "model ids must be unique" });
    }
    if (!ids.has(value.defaultModelId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelId"],
        message: "default model must be present in the enabled model list",
      });
    }
  });
export type VideoGenerationCapabilities = z.infer<typeof VideoGenerationCapabilities>;

export const VideoGenerationPolicy = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().safe(),
    fundingSource: VideoGenerationFundingSource,
    enabledModelIds: z.array(z.string().min(1).max(256)).max(16),
    defaultModelId: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.enabledModelIds);
    if (ids.size !== value.enabledModelIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["enabledModelIds"],
        message: "enabled model ids must be unique",
      });
    }
    if (value.defaultModelId !== null && !ids.has(value.defaultModelId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelId"],
        message: "default model must be enabled",
      });
    }
  });
export type VideoGenerationPolicy = z.infer<typeof VideoGenerationPolicy>;

export const UpdateVideoGenerationPolicyRequest = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    fundingSource: VideoGenerationFundingSource,
    enabledModelIds: z.array(z.string().min(1).max(256)).max(16),
    defaultModelId: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type UpdateVideoGenerationPolicyRequest = z.infer<typeof UpdateVideoGenerationPolicyRequest>;

export const VideoGenerationFundingOption = z
  .object({
    source: VideoGenerationFundingSource,
    label: z.string().min(1).max(128),
    description: z.string().min(1).max(256),
    available: z.boolean(),
    unavailableReason: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.available !== (value.unavailableReason === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "available funding options cannot have an unavailable reason",
      });
    }
  });
export type VideoGenerationFundingOption = z.infer<typeof VideoGenerationFundingOption>;

export const WorkspaceVideoGenerationSettings = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    policy: VideoGenerationPolicy,
    fundingOptions: z.array(VideoGenerationFundingOption).length(2),
    availableModels: z.array(VideoGenerationModelCapability).max(16),
    capabilities: VideoGenerationCapabilities.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.fundingOptions.map((option) => option.source)).size !== 2 ||
      !value.fundingOptions.some((option) => option.source === "opengeni_credits") ||
      !value.fundingOptions.some((option) => option.source === "workspace_gateway")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fundingOptions"],
        message: "both funding sources must be described exactly once",
      });
    }
    const selected = value.fundingOptions.find(
      (option) => option.source === value.policy.fundingSource,
    );
    if (!selected) {
      ctx.addIssue({
        code: "custom",
        path: ["fundingOptions"],
        message: "the selected funding source must be described",
      });
    } else if (!selected.available && value.capabilities !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "unavailable funding cannot expose executable capabilities",
      });
    }
  });
export type WorkspaceVideoGenerationSettings = z.infer<typeof WorkspaceVideoGenerationSettings>;

export const VideoGenerationAcceptedReceipt = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    status: z.literal("accepted"),
    operationId: z.string().uuid(),
  })
  .strict();
export type VideoGenerationAcceptedReceipt = z.infer<typeof VideoGenerationAcceptedReceipt>;

export const GeneratedVideoFacts = z
  .object({
    durationSeconds: z.number().positive().max(120),
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    fps: z.number().positive().max(120),
    hasAudio: z.boolean(),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac").nullable(),
  })
  .strict();
export type GeneratedVideoFacts = z.infer<typeof GeneratedVideoFacts>;

export const GeneratedVideoReceipt = z
  .object({
    type: z.literal("generated_video"),
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    operationId: z.string().uuid(),
    artifact: RetainedArtifactReferenceSchema,
    video: GeneratedVideoFacts,
    sandboxPath: z
      .string()
      .max(256)
      .regex(
        /^\/workspace\/generated-videos\/generated-video-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/,
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.artifact.kind !== "generated_video" ||
      value.artifact.contentType !== "video/mp4" ||
      value.artifact.originalBytes <= 0 ||
      value.artifact.originalBytes > GENERATED_VIDEO_MAX_BYTES ||
      value.artifact.retention.policy !== "workspace_file" ||
      value.artifact.retrieval.maxRangeBytes !== RETAINED_OUTPUT_MAX_PAGE_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "generated-video artifact metadata is invalid",
      });
    }
    if (
      value.artifact.dimensions?.width !== value.video.width ||
      value.artifact.dimensions?.height !== value.video.height
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["video"],
        message: "video dimensions must match the retained artifact",
      });
    }
    if (
      value.sandboxPath !==
      `/workspace/generated-videos/generated-video-${value.artifact.artifactId}.mp4`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sandboxPath"],
        message: "generated-video sandbox path does not match its artifact",
      });
    }
  });
export type GeneratedVideoReceipt = z.infer<typeof GeneratedVideoReceipt>;

export const VideoGenerationTerminalFailureStatus = z.enum([
  "provider_failed",
  "retention_failed",
  "cancelled_before_submit",
  "outcome_unknown",
]);
export type VideoGenerationTerminalFailureStatus = z.infer<
  typeof VideoGenerationTerminalFailureStatus
>;

export const MediaGenerationResult = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("media_generation_result"),
      schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
      status: z.literal("ready"),
      operationId: z.string().uuid(),
      receipt: GeneratedVideoReceipt,
    })
    .strict()
    .refine((value) => value.receipt.operationId === value.operationId, {
      path: ["receipt", "operationId"],
      message: "terminal receipt must match its operation",
    }),
  z
    .object({
      type: z.literal("media_generation_result"),
      schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
      status: VideoGenerationTerminalFailureStatus,
      operationId: z.string().uuid(),
      boundedPublicReason: z.string().min(1).max(1_000),
    })
    .strict(),
]);
export type MediaGenerationResult = z.infer<typeof MediaGenerationResult>;

export const VideoGenerationPublicStatus = z.enum([
  "preparing",
  "prepared",
  "accepted",
  "provider_started",
  "retaining",
  "completed",
  "provider_failed",
  "cancelled_before_submit",
  "outcome_unknown",
  "retention_failed",
]);
export type VideoGenerationPublicStatus = z.infer<typeof VideoGenerationPublicStatus>;

export const VideoGenerationOperationSummary = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    operationId: z.string().uuid(),
    modelId: z.string().min(1).max(256),
    status: VideoGenerationPublicStatus,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    terminal: MediaGenerationResult.nullable(),
  })
  .strict();
export type VideoGenerationOperationSummary = z.infer<typeof VideoGenerationOperationSummary>;

export const VideoArtifactPlaybackSource = z
  .object({
    schemaVersion: z.literal(VIDEO_GENERATION_SCHEMA_VERSION),
    artifactId: z.string().uuid(),
    url: z.string().url().max(8_192),
    expiresAt: z.string().datetime({ offset: true }),
    contentType: z.literal("video/mp4"),
    sizeBytes: z.number().int().positive().max(GENERATED_VIDEO_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    acceptRanges: z.literal("bytes"),
  })
  .strict();
export type VideoArtifactPlaybackSource = z.infer<typeof VideoArtifactPlaybackSource>;
