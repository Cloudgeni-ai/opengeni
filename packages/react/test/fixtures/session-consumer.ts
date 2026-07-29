import {
  buildTimeline,
  type FileAttachmentClientLike,
  type GoalClientLike,
  type HumanInputSessionClientLike,
  type SessionLineageClientLike,
  type SessionReadClientLike,
  type SessionClientLike,
  useFileAttachments,
  useGoal,
  useComposer,
  useHumanInputRequests,
  useSession,
  useSessionControl,
  useSessionEvents,
  useSessionLineage,
  useTurnQueue,
} from "@opengeni/react/session";

const unused = (..._input: unknown[]): never => {
  throw new Error("type-only session client fixture");
};

// This deliberately implements no billing, workspace administration, rigs,
// files, terminal, or workbench APIs. The public session entry must accept a
// tenant-safe structural proxy with only its documented operations.
export const sessionClient = {
  getSession: unused,
  listEvents: unused,
  streamEvents: unused,
  getComposerDraft: unused,
  saveComposerDraft: unused,
  sendMessage: unused,
  steerMessage: unused,
  getQueue: unused,
  moveQueueItem: unused,
  editQueueItem: unused,
  steerQueueItem: unused,
  deleteQueueItem: unused,
  pauseSession: unused,
  resumeSession: unused,
  sendApprovalDecision: unused,
} satisfies SessionClientLike;

export const humanInputSessionClient = {
  ...sessionClient,
  listHumanInputRequests: unused,
  getHumanInputRequest: unused,
  submitHumanInputResponse: unused,
} satisfies HumanInputSessionClientLike;

const eventClient = {
  getSession: unused,
  streamEvents: unused,
};

export const sessionReadClient = {
  ...eventClient,
  getSession: unused,
  updateSession: unused,
} satisfies SessionReadClientLike;

export const goalClient = {
  ...eventClient,
  getGoal: unused,
  updateGoal: unused,
  deleteGoal: unused,
} satisfies GoalClientLike;

export const lineageClient = {
  ...eventClient,
  getSessionLineage: unused,
} satisfies SessionLineageClientLike;

export const fileAttachmentClient = {
  uploadFile: unused,
} satisfies FileAttachmentClientLike;

export function SessionHookConsumerProof() {
  useSession("session-proof", { client: sessionReadClient, workspaceId: "workspace-proof" });
  useGoal("session-proof", { client: goalClient, workspaceId: "workspace-proof" });
  useSessionLineage("session-proof", {
    client: lineageClient,
    workspaceId: "workspace-proof",
  });
  useFileAttachments({ client: fileAttachmentClient, workspaceId: "workspace-proof" });
  return null;
}

export const sessionSurface = [
  sessionClient,
  humanInputSessionClient,
  sessionReadClient,
  goalClient,
  lineageClient,
  fileAttachmentClient,
  SessionHookConsumerProof,
  buildTimeline,
  useComposer,
  useFileAttachments,
  useGoal,
  useHumanInputRequests,
  useSession,
  useSessionControl,
  useSessionEvents,
  useSessionLineage,
  useTurnQueue,
];
