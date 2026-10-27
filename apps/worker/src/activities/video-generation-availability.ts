import {
  VideoGenerationUnavailableResult,
  type GenerateVideoToolInput,
  type VideoGenerationCapabilities,
  type VideoGenerationPolicy,
  type VideoGenerationToolResult,
  type VideoGenerationUnavailableCode,
} from "@opengeni/contracts";
import {
  VIDEO_GENERATION_MODEL_CATALOG,
  videoGenerationModelSupportsFundingSource,
} from "@opengeni/core";
import {
  calculateVideoGenerationCreditCostMicros,
  environmentsEncryptionKeyBytes,
  type Settings,
} from "@opengeni/config";
import { VideoGenerationCapacityError, VideoGenerationCreditError } from "@opengeni/db";
import {
  videoCapabilitiesForTurn,
  videoGenerationCreditsCharged,
  type VideoGenerationCredentialLease,
} from "./video-generation-admission";

/** The clip length the price is quoted for. */
const QUOTED_CLIP_SECONDS = 5;
const PLAIN_ENDING = "Tell the person plainly; offer an image instead if that helps.";

export function videoGenerationPolicyEnabled(policy: VideoGenerationPolicy): boolean {
  return policy.defaultModelId !== null && policy.enabledModelIds.length > 0;
}

function unavailable(
  code: VideoGenerationUnavailableCode,
  message: string,
  turnOn?: VideoGenerationUnavailableResult["turnOn"],
): VideoGenerationUnavailableResult {
  return VideoGenerationUnavailableResult.parse({
    schemaVersion: 1,
    status: "unavailable",
    code,
    message,
    operationCreated: false,
    ...(turnOn ? { turnOn } : {}),
  });
}

function withoutFinalStop(text: string): string {
  return text.replace(/[.\s]+$/u, "");
}

function dollars(micros: number): string {
  return `$${(Math.round(micros / 10_000) / 100).toFixed(2)}`;
}

/**
 * Who reads the answer, for who can turn video on: whether this turn's app
 * actions can change the workspace's settings, and whether the sender uses
 * Opengeni through another product (and so has no Opengeni Settings page to
 * be pointed to).
 */
export type VideoGenerationActor = { canChangeSettings: boolean; external: boolean };

/** False when this deployment can't make a video for any workspace. */
export function videoGenerationSupported(settings: Settings): boolean {
  // Every funding source stores an encrypted credential with the operation.
  return environmentsEncryptionKeyBytes(settings) !== null;
}

/**
 * What the video tools return while the workspace can't make a video: off,
 * on without a usable way to pay, or not possible on this deployment. Only
 * when Opengeni credits can pay and this turn can change the workspace's
 * settings does it carry the price and the exact app action call that turns
 * video on, built from the live policy revision and the catalog's
 * credit-funded model, so the agent can offer it in one step.
 */
export function videoGenerationOffResult(input: {
  settings: Settings;
  workspaceId: string;
  policy: VideoGenerationPolicy;
  /** False when the workspace turned Opengeni credits off. */
  creditModelsAllowed: boolean;
  actor: VideoGenerationActor;
}): VideoGenerationUnavailableResult {
  const { settings, policy, actor } = input;
  const inSettings = actor.external ? "" : " in Settings";
  if (!videoGenerationSupported(settings)) {
    return unavailable(
      "video_generation_unsupported",
      `Video generation is not available on this deployment. ${PLAIN_ENDING}`,
    );
  }
  if (videoGenerationPolicyEnabled(policy)) {
    return unavailable(
      "video_generation_unfunded",
      `Video generation is on in this workspace, but its payment method can't be used right now. A workspace admin can fix it${inSettings}. ${PLAIN_ENDING}`,
    );
  }
  const externalOff = () =>
    unavailable(
      "video_generation_off",
      `Video generation is off in this workspace. A workspace admin can turn it on. ${PLAIN_ENDING}`,
    );
  if (actor.external && !actor.canChangeSettings) return externalOff();
  const creditModel = VIDEO_GENERATION_MODEL_CATALOG.find((model) =>
    videoGenerationModelSupportsFundingSource(model.modelId, "opengeni_credits"),
  );
  if (!creditModel || !settings.vercelAiGatewayApiKey || !input.creditModelsAllowed) {
    if (actor.external) return externalOff();
    const ways = settings.supergrokSubscriptionEnabled
      ? "the workspace's own Vercel AI Gateway key or a connected SuperGrok account"
      : "the workspace's own Vercel AI Gateway key";
    return unavailable(
      "video_generation_off",
      `Video generation is off in this workspace, and Opengeni credits can't pay for it here. A workspace admin can turn it on in Settings with ${ways}. ${PLAIN_ENDING}`,
    );
  }
  const clipPrice = (resolution: "480p" | "720p") =>
    dollars(
      calculateVideoGenerationCreditCostMicros(settings, {
        modelId: creditModel.modelId,
        resolution,
        durationSeconds: QUOTED_CLIP_SECONDS,
      }),
    );
  const payment = videoGenerationCreditsCharged(settings)
    ? `Opengeni credits can pay for it: a ${QUOTED_CLIP_SECONDS}-second 480p clip costs ${clipPrice("480p")} (720p: ${clipPrice("720p")}).`
    : "It can run on this deployment's video gateway, at no charge to this workspace.";
  if (!actor.canChangeSettings) {
    return unavailable(
      "video_generation_off",
      `Video generation is off in this workspace. ${payment} A workspace admin can turn it on in Settings. ${PLAIN_ENDING}`,
    );
  }
  return unavailable(
    "video_generation_off",
    `Video generation is off in this workspace. ${payment} Ask the person whether to turn it on for every chat in this workspace; if they agree, run the app action in turnOn, then call this tool again. If you can't run it, they can turn it on${inSettings}.`,
    {
      id: "updateVideoGenerationPolicy",
      pathParameters: { workspaceId: input.workspaceId },
      body: {
        expectedRevision: policy.revision,
        fundingSource: "opengeni_credits",
        enabledModelIds: [creditModel.modelId],
        defaultModelId: creditModel.modelId,
      },
    },
  );
}

/**
 * Plain result for an admission that credits or workspace limits refused
 * before any provider request; the operation rolled back with it.
 */
export function videoGenerationAdmissionRefusedResult(
  error: unknown,
): VideoGenerationUnavailableResult | null {
  if (error instanceof VideoGenerationCreditError) {
    return unavailable(
      "insufficient_credits",
      `This video can't be paid for: ${withoutFinalStop(error.message)}. Nothing was generated or charged.`,
    );
  }
  if (error instanceof VideoGenerationCapacityError) {
    return error.limit === "storage"
      ? unavailable(
          "video_storage_full",
          "Video generation can't start: this workspace's video storage is full. Deleting videos it no longer needs frees space. Nothing was generated or charged.",
        )
      : unavailable(
          "generation_limit_reached",
          "Video generation can't start: this workspace is already making as many videos as it can at once. Try again when one finishes. Nothing was generated or charged.",
        );
  }
  return null;
}

export type VideoGenerationToolAdapter = {
  capabilities: () => Promise<VideoGenerationCapabilities | VideoGenerationUnavailableResult>;
  execute: (
    toolInput: GenerateVideoToolInput,
    context: { toolCallId: string },
  ) => Promise<VideoGenerationToolResult>;
};

/**
 * The video tools' adapter. Each call reads the workspace's live policy and
 * credential, so the tools can stay attached whatever the policy is, and a
 * turn that turns video on can use it right away.
 */
export function createVideoGenerationToolAdapter(deps: {
  settings: Settings;
  workspaceId: string;
  creditModelsAllowed: boolean;
  /** The sender uses Opengeni through another product. */
  external: boolean;
  /**
   * Whether this turn can change the workspace's settings, read only while
   * video is off and possible here, to say who can turn it on.
   */
  canChangeSettings: () => Promise<boolean>;
  readPolicy: () => Promise<VideoGenerationPolicy>;
  resolveCredential: (
    policy: VideoGenerationPolicy,
  ) => Promise<VideoGenerationCredentialLease | null>;
  admit: (input: {
    policy: VideoGenerationPolicy;
    credential: VideoGenerationCredentialLease;
    toolInput: GenerateVideoToolInput;
    toolCallId: string;
  }) => Promise<VideoGenerationToolResult>;
}): VideoGenerationToolAdapter {
  // A failed read answers by who sent the message instead of failing the call.
  const canChangeSettings = async () =>
    videoGenerationSupported(deps.settings) && (await deps.canChangeSettings().catch(() => false));
  const current = async () => {
    const policy = await deps.readPolicy();
    const credential = videoGenerationPolicyEnabled(policy)
      ? await deps.resolveCredential(policy)
      : null;
    if (!credential) {
      return {
        off: videoGenerationOffResult({
          settings: deps.settings,
          workspaceId: deps.workspaceId,
          policy,
          creditModelsAllowed: deps.creditModelsAllowed,
          actor: { canChangeSettings: await canChangeSettings(), external: deps.external },
        }),
      } as const;
    }
    return { policy, credential } as const;
  };
  return {
    capabilities: async () => {
      const state = await current();
      return "off" in state ? state.off : videoCapabilitiesForTurn(state);
    },
    execute: async (toolInput, { toolCallId }) => {
      const state = await current();
      if ("off" in state) return state.off;
      try {
        return await deps.admit({ ...state, toolInput, toolCallId });
      } catch (error) {
        const refused = videoGenerationAdmissionRefusedResult(error);
        if (refused) return refused;
        throw error;
      }
    },
  };
}
