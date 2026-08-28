import type { ComposerDraft } from "@opengeni/sdk";
import type { EmbeddedSessionClientLike } from "./client";

export type ComposerDraftMapContext = {
  operation: "read" | "save" | "submit";
  workspaceId: string;
  sessionId: string;
};

export type CreateEmbeddedSessionClientOptions = {
  /**
   * Explicit host-owned method replacements. Methods inherited from `base`
   * retain `base` as their receiver; overrides retain this object as theirs.
   */
  overrides?: Partial<EmbeddedSessionClientLike> | undefined;
  /** Presentation/policy projection for every draft entering the React layer. */
  mapComposerDraft?:
    | ((draft: ComposerDraft, context: ComposerDraftMapContext) => ComposerDraft)
    | undefined;
};

const requiredMethods = [
  "getSession",
  "listEvents",
  "streamEvents",
  "getComposerDraft",
  "saveComposerDraft",
  "submitComposerDraft",
  "sendMessage",
  "steerMessage",
  "getQueue",
  "moveQueueItem",
  "editQueueItem",
  "steerQueueItem",
  "deleteQueueItem",
  "pauseSession",
  "resumeSession",
  "sendApprovalDecision",
] as const satisfies readonly (keyof EmbeddedSessionClientLike)[];

/**
 * Build the exact client required by `@opengeni/react/session` from a full SDK
 * client or host proxy. The constructor binds every delegated method once,
 * supports a host-owned atomic composer-submit override, and fails at creation
 * time instead of waiting for a missing method to be exercised by a hook.
 */
export function createEmbeddedSessionClient(
  base: EmbeddedSessionClientLike,
  options: CreateEmbeddedSessionClientOptions = {},
): EmbeddedSessionClientLike {
  const overrides = options.overrides ?? {};
  const client = {} as EmbeddedSessionClientLike;
  for (const key of requiredMethods) {
    const override = overrides[key];
    const method = override ?? base[key];
    if (typeof method !== "function") {
      throw new TypeError(`Embedded session client method is required: ${key}`);
    }
    client[key] = method.bind(override === undefined ? base : overrides) as never;
  }

  const inferenceOverride = overrides.setWorkspaceInferenceState;
  const inferenceBase = base.setWorkspaceInferenceState;
  const inferenceMethod = inferenceOverride ?? inferenceBase;
  if (typeof inferenceMethod === "function") {
    client.setWorkspaceInferenceState = inferenceMethod.bind(
      inferenceOverride === undefined ? base : overrides,
    );
  }

  const mapDraft = options.mapComposerDraft;
  if (!mapDraft) return client;

  const getComposerDraft = client.getComposerDraft;
  client.getComposerDraft = async (workspaceId, sessionId) =>
    mapDraft(await getComposerDraft(workspaceId, sessionId), {
      operation: "read",
      workspaceId,
      sessionId,
    });

  const saveComposerDraft = client.saveComposerDraft;
  client.saveComposerDraft = async (workspaceId, sessionId, request) =>
    mapDraft(await saveComposerDraft(workspaceId, sessionId, request), {
      operation: "save",
      workspaceId,
      sessionId,
    });

  const submitComposerDraft = client.submitComposerDraft;
  client.submitComposerDraft = async (workspaceId, sessionId, request) => {
    const response = await submitComposerDraft(workspaceId, sessionId, request);
    return {
      ...response,
      draft: mapDraft(response.draft, {
        operation: "submit",
        workspaceId,
        sessionId,
      }),
    };
  };

  return client;
}
