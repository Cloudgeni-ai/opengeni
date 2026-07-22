import {
  buildTimeline,
  type SessionClientLike,
  useComposer,
  useSessionControl,
  useSessionEvents,
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

export const sessionSurface = [
  sessionClient,
  buildTimeline,
  useComposer,
  useSessionControl,
  useSessionEvents,
  useTurnQueue,
];
