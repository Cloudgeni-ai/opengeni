import type { SessionControlResponse, SessionEvent } from "../types";
import type { SessionClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import { asError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export type SessionControlStoreSnapshot = Readonly<{
  controlling: boolean;
  responding: boolean;
  error: Error | null;
}>;

export type SessionControlStore = OpenGeniExternalStore<SessionControlStoreSnapshot> & {
  pause(reason?: string): Promise<SessionControlResponse | null>;
  resume(reason?: string): Promise<SessionControlResponse | null>;
  approve(approvalId: string, message?: string): Promise<SessionEvent | null>;
  reject(approvalId: string, message?: string): Promise<SessionEvent | null>;
  clearError(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createSessionControlStore(options: {
  client: Pick<SessionClientLike, "pauseSession" | "resumeSession" | "sendApprovalDecision">;
  workspaceId: string;
  sessionId: string | null | undefined;
  environment?: SessionRuntimeEnvironment;
}): SessionControlStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  let pendingApproval: { decisionKey: string; clientEventId: string } | null = null;
  let controlError: Error | null = null;
  let approvalError: Error | null = null;
  const store = createExternalStore<SessionControlStoreSnapshot>({
    initialSnapshot: { controlling: false, responding: false, error: null },
  });
  const publish = (patch: Partial<SessionControlStoreSnapshot>) => {
    if (store.signal.aborted) return;
    store.publish((current) => ({
      ...current,
      ...patch,
      error: approvalError ?? controlError,
    }));
  };
  const control = async (
    action: "pause" | "resume",
    reason?: string,
  ): Promise<SessionControlResponse | null> => {
    const sessionId = options.sessionId;
    if (!sessionId || store.getSnapshot().controlling || store.signal.aborted) return null;
    controlError = null;
    publish({ controlling: true });
    try {
      const response = await options.client[action === "pause" ? "pauseSession" : "resumeSession"](
        options.workspaceId,
        sessionId,
        reason === undefined ? {} : { reason },
      );
      return store.signal.aborted ? null : response;
    } catch (cause) {
      if (store.signal.aborted) return null;
      controlError = asError(cause);
      publish({ controlling: false });
      return null;
    } finally {
      publish({ controlling: false });
    }
  };
  const decide = async (
    approvalId: string,
    decision: "approve" | "reject",
    message?: string,
  ): Promise<SessionEvent | null> => {
    const sessionId = options.sessionId;
    if (!sessionId || store.getSnapshot().responding || store.signal.aborted) return null;
    const decisionKey = JSON.stringify([approvalId, decision, message ?? null]);
    if (pendingApproval?.decisionKey !== decisionKey) {
      pendingApproval = { decisionKey, clientEventId: environment.ids.randomUUID() };
    }
    const clientEventId = pendingApproval.clientEventId;
    approvalError = null;
    publish({ responding: true });
    try {
      const event = await options.client.sendApprovalDecision(options.workspaceId, sessionId, {
        approvalId,
        decision,
        ...(message === undefined ? {} : { message }),
        clientEventId,
      });
      if (store.signal.aborted) return null;
      if (pendingApproval?.clientEventId === clientEventId) pendingApproval = null;
      return event;
    } catch (cause) {
      if (store.signal.aborted) return null;
      approvalError = asError(cause);
      publish({ responding: false });
      return null;
    } finally {
      publish({ responding: false });
    }
  };
  return Object.assign(store, {
    pause: async (reason?: string) => await control("pause", reason),
    resume: async (reason?: string) => await control("resume", reason),
    approve: async (approvalId: string, message?: string) =>
      await decide(approvalId, "approve", message),
    reject: async (approvalId: string, message?: string) =>
      await decide(approvalId, "reject", message),
    clearError() {
      controlError = null;
      approvalError = null;
      publish({ error: null });
    },
    diagnostics: store.diagnostics,
  });
}
