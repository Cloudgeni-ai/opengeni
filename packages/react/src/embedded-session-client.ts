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

function bindRequiredMethod<K extends keyof EmbeddedSessionClientLike>(
  base: EmbeddedSessionClientLike,
  overrides: Partial<EmbeddedSessionClientLike>,
  key: K,
): NonNullable<EmbeddedSessionClientLike[K]> {
  const override = overrides[key];
  const value = override ?? base[key];
  if (typeof value !== "function") {
    throw new TypeError(`Embedded session client method is required: ${String(key)}`);
  }
  const receiver = override === undefined ? base : overrides;
  return value.bind(receiver) as NonNullable<EmbeddedSessionClientLike[K]>;
}

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
  const client: EmbeddedSessionClientLike = {
    getSession: bindRequiredMethod(base, overrides, "getSession"),
    listEvents: bindRequiredMethod(base, overrides, "listEvents"),
    streamEvents: bindRequiredMethod(base, overrides, "streamEvents"),
    getComposerDraft: bindRequiredMethod(base, overrides, "getComposerDraft"),
    saveComposerDraft: bindRequiredMethod(base, overrides, "saveComposerDraft"),
    submitComposerDraft: bindRequiredMethod(base, overrides, "submitComposerDraft"),
    sendMessage: bindRequiredMethod(base, overrides, "sendMessage"),
    steerMessage: bindRequiredMethod(base, overrides, "steerMessage"),
    getQueue: bindRequiredMethod(base, overrides, "getQueue"),
    moveQueueItem: bindRequiredMethod(base, overrides, "moveQueueItem"),
    editQueueItem: bindRequiredMethod(base, overrides, "editQueueItem"),
    steerQueueItem: bindRequiredMethod(base, overrides, "steerQueueItem"),
    deleteQueueItem: bindRequiredMethod(base, overrides, "deleteQueueItem"),
    pauseSession: bindRequiredMethod(base, overrides, "pauseSession"),
    resumeSession: bindRequiredMethod(base, overrides, "resumeSession"),
    sendApprovalDecision: bindRequiredMethod(base, overrides, "sendApprovalDecision"),
  };

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
