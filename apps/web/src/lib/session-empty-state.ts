import type { SessionStatus } from "@opengeni/contracts";

export type SessionTimelineEmptyStateCopy = {
  title: string;
  description: string;
};

/** Truthful zero-step copy from lifecycle facts already held by the client. */
export function sessionTimelineEmptyStateCopy(
  status: SessionStatus,
  paused: boolean,
): SessionTimelineEmptyStateCopy {
  if (paused) {
    return {
      title: "Workstream paused",
      description: "Queued work stays saved. Resume the workstream when you want it to continue.",
    };
  }
  switch (status) {
    case "queued":
      return {
        title: "Queued to start",
        description: "Your prompt is saved and will start when this session is admitted.",
      };
    case "running":
      return {
        title: "Starting the agent",
        description: "Preparing its tools, files, and conversation before the first step.",
      };
    case "requires_action":
      return {
        title: "Waiting for your response",
        description: "Answer the request below so the agent can continue.",
      };
    case "recovering":
      return {
        title: "Restoring this session",
        description: "Reconnecting the session and its workspace before work continues.",
      };
    case "waiting_capacity":
      return {
        title: "Waiting for capacity",
        description: "Your work is saved and will start when a worker becomes available.",
      };
    case "failed":
      return {
        title: "No step was produced",
        description: "The last run failed before its first step. Send a follow-up to try again.",
      };
    case "cancelled":
      return {
        title: "Run cancelled",
        description: "No step was produced. Send a follow-up whenever you want to continue.",
      };
    case "idle":
      return {
        title: "Waiting for the first step",
        description: "Send a prompt to start working in this session.",
      };
  }
}
