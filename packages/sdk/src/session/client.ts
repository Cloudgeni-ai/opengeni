import type { OpenGeniClient } from "../client";

export type SessionEventClientLike = Pick<
  OpenGeniClient,
  "getSession" | "listEvents" | "streamEvents"
>;

export type SessionClientLike = Pick<
  OpenGeniClient,
  | "getSession"
  | "listEvents"
  | "streamEvents"
  | "getComposerDraft"
  | "saveComposerDraft"
  | "submitComposerDraft"
  | "sendMessage"
  | "steerMessage"
  | "getQueue"
  | "moveQueueItem"
  | "editQueueItem"
  | "steerQueueItem"
  | "deleteQueueItem"
  | "pauseSession"
  | "resumeSession"
  | "sendApprovalDecision"
> & {
  setWorkspaceInferenceState?: OpenGeniClient["setWorkspaceInferenceState"] | undefined;
};

export type SessionReadClientLike = SessionEventClientLike &
  Pick<OpenGeniClient, "getSession" | "updateSession">;
export type GoalClientLike = SessionEventClientLike &
  Pick<OpenGeniClient, "getGoal" | "updateGoal" | "deleteGoal">;
export type SessionLineageClientLike = SessionEventClientLike &
  Pick<OpenGeniClient, "getSessionLineage">;
export type FileAttachmentClientLike = Pick<OpenGeniClient, "uploadFile">;
export type HumanInputSessionClientLike = SessionEventClientLike &
  Pick<OpenGeniClient, "listHumanInputRequests" | "submitHumanInputResponse">;
export type SessionMcpApprovalPolicyClientLike = SessionEventClientLike &
  Pick<OpenGeniClient, "updateSessionMcpApprovalPolicy">;

export type SessionRuntimeClientLike = SessionClientLike &
  SessionReadClientLike &
  GoalClientLike &
  SessionLineageClientLike &
  FileAttachmentClientLike &
  HumanInputSessionClientLike &
  SessionMcpApprovalPolicyClientLike;

export type ComposerDraftMapContext = {
  operation: "read" | "save" | "submit";
  workspaceId: string;
  sessionId: string;
};

export type CreateEmbeddedSessionClientOptions = {
  overrides?: Partial<SessionClientLike> | undefined;
  mapComposerDraft?:
    | ((
        draft: Awaited<ReturnType<SessionClientLike["getComposerDraft"]>>,
        context: ComposerDraftMapContext,
      ) => Awaited<ReturnType<SessionClientLike["getComposerDraft"]>>)
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
] as const satisfies readonly (keyof SessionClientLike)[];

export function createEmbeddedSessionClient(
  base: SessionClientLike,
  options: CreateEmbeddedSessionClientOptions = {},
): SessionClientLike {
  const overrides = options.overrides ?? {};
  const client = {} as SessionClientLike;
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
  client.getComposerDraft = async (workspaceId, sessionId, requestOptions) =>
    mapDraft(await getComposerDraft(workspaceId, sessionId, requestOptions), {
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
      draft: mapDraft(response.draft, { operation: "submit", workspaceId, sessionId }),
    };
  };
  return client;
}
