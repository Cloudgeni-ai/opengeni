import type { SessionEvent } from "@opengeni/contracts";
import { listSessionEvents } from "@opengeni/db";

import type { EvalStack, EvalWorkspace } from "./stack";

export type HumanInputQuestionView = {
  id: string;
  kind: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
};

/** Returns the answer text for one question, or null to leave the request pending. */
export type HumanInputResponder = (question: HumanInputQuestionView) => string | null;

export type DriveOptions = {
  /** Hard bound on model turns (initial turn + goal continuations + resumes). */
  maxTurns: number;
  /** Bound on goal continuations materialized by `maybeContinueGoal`. */
  maxGoalContinuations: number;
  humanInput?: HumanInputResponder;
  /** Auto-approve tool approvals (default true; approvals are human-only in production). */
  approveTools?: boolean;
  signal?: AbortSignal;
};

export type DriveOutcome = {
  turns: number;
  goalContinuations: number;
  humanInputAnswered: number;
  approvalsGranted: number;
  /** Why the driver stopped. */
  stop:
    | "idle"
    | "max_turns"
    | "awaiting_human"
    | "held"
    | "stuck"
    | "aborted"
    | "turn_failed_terminal";
  errors: string[];
};

export async function apiRequest<T = unknown>(
  stack: EvalStack,
  workspace: EvalWorkspace,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${stack.apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: workspace.authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 800)}`);
  }
  return (text.length > 0 ? JSON.parse(text) : null) as T;
}

export async function createSessionViaApi(
  stack: EvalStack,
  workspace: EvalWorkspace,
  request: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  return await apiRequest(
    stack,
    workspace,
    "POST",
    `/v1/workspaces/${workspace.workspaceId}/sessions`,
    request,
  );
}

export async function sendMessageViaApi(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
  text: string,
): Promise<void> {
  await apiRequest(
    stack,
    workspace,
    "POST",
    `/v1/workspaces/${workspace.workspaceId}/sessions/${sessionId}/events`,
    { type: "user.message", clientEventId: crypto.randomUUID(), payload: { text } },
  );
}

const SETTLE_POLL_MS = 500;
const MAX_WAIT_POLLS = 120;

/**
 * Run the same activity sequence the Temporal session workflow runs
 * (apps/worker/src/workflows/session.ts): peek durable work, run the exact
 * turn/approval trigger, materialize goal continuations at idle, and settle
 * waits. Human input and tool approvals are answered through the public API.
 */
export async function driveSession(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
  options: DriveOptions,
): Promise<DriveOutcome> {
  const outcome: DriveOutcome = {
    turns: 0,
    goalContinuations: 0,
    humanInputAnswered: 0,
    approvalsGranted: 0,
    stop: "idle",
    errors: [],
  };
  const workflowId = `session-${sessionId}`;
  const workflowRunId = crypto.randomUUID();
  let waitPolls = 0;
  const handledHumanInput = new Set<string>();
  const handledApprovals = new Set<string>();
  const { activities } = stack;
  while (true) {
    if (options.signal?.aborted) {
      outcome.stop = "aborted";
      return outcome;
    }
    const peek = await activities.peekSessionWork({
      workspaceId: workspace.workspaceId,
      sessionId,
      includeAdmissionFence: true,
      observerAccountId: workspace.accountId,
    });
    switch (peek.kind) {
      case "runnable":
      case "approval-pending": {
        if (outcome.turns >= options.maxTurns) {
          outcome.stop = "max_turns";
          return outcome;
        }
        outcome.turns += 1;
        waitPolls = 0;
        try {
          const result = await activities.runAgentTurn({
            accountId: workspace.accountId,
            workspaceId: workspace.workspaceId,
            sessionId,
            workflowId,
            workflowRunId,
            attemptId: crypto.randomUUID(),
            trigger:
              peek.kind === "approval-pending"
                ? { kind: "approval", triggerEventId: peek.triggerEventId }
                : { kind: "next" },
          });
          if ("continueDelayMs" in result && result.continueDelayMs) {
            await Bun.sleep(Math.min(result.continueDelayMs, 5_000));
          }
          if (result.status === "failed") {
            outcome.errors.push(`turn ${outcome.turns} failed`);
          }
        } catch (error) {
          outcome.errors.push(
            `runAgentTurn threw: ${error instanceof Error ? error.message : String(error)}`,
          );
          // The workflow would run the failure-control activity; the durable
          // state usually already reflects the failure. Re-peek once more and
          // stop if the same error repeats.
          if (outcome.errors.length > 3) {
            outcome.stop = "turn_failed_terminal";
            return outcome;
          }
        }
        continue;
      }
      case "idle": {
        const continuation =
          outcome.goalContinuations < options.maxGoalContinuations
            ? await activities.maybeContinueGoal({
                accountId: workspace.accountId,
                workspaceId: workspace.workspaceId,
                sessionId,
                workflowId,
              })
            : { action: "none" as const };
        if (continuation.action === "continue" || continuation.action === "queue") {
          outcome.goalContinuations += 1;
          continue;
        }
        await activities.markSessionIdle({ workspaceId: workspace.workspaceId, sessionId });
        outcome.stop = "idle";
        return outcome;
      }
      case "approval-wait": {
        if (peek.humanInputRequestId && !handledHumanInput.has(peek.humanInputRequestId)) {
          handledHumanInput.add(peek.humanInputRequestId);
          const answered = await answerHumanInput(
            stack,
            workspace,
            sessionId,
            peek.humanInputRequestId,
            options.humanInput,
          );
          if (!answered) {
            outcome.stop = "awaiting_human";
            return outcome;
          }
          outcome.humanInputAnswered += 1;
          continue;
        }
        if (!peek.humanInputRequestId && !peek.interactionInterventionId) {
          if (options.approveTools === false) {
            outcome.stop = "awaiting_human";
            return outcome;
          }
          const approved = await approvePendingTools(stack, workspace, sessionId, handledApprovals);
          if (approved === 0) {
            outcome.stop = "awaiting_human";
            return outcome;
          }
          outcome.approvalsGranted += approved;
          continue;
        }
        outcome.stop = "awaiting_human";
        return outcome;
      }
      case "input-wait": {
        const settled = await activities.settleSessionInputWait({
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          sessionId,
          waitTurnId: peek.waitTurnId,
          disposition: peek.disposition,
        });
        if (settled.action === "held") {
          outcome.stop = "held";
          return outcome;
        }
        continue;
      }
      case "interruption-pending": {
        await activities.settleSessionInterruptions({
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          sessionId,
          attemptId: peek.attemptId,
          workflowId,
        });
        continue;
      }
      default: {
        // unavailable / attempt-owned / admission-blocked / capacity-wait /
        // cancellation-wait / sandbox-lifecycle-wait: transient for this harness.
        waitPolls += 1;
        if (waitPolls > MAX_WAIT_POLLS) {
          outcome.errors.push(`stuck in peek state ${peek.kind}`);
          outcome.stop = "stuck";
          return outcome;
        }
        await Bun.sleep(SETTLE_POLL_MS);
      }
    }
  }
}

type HumanInputRequestView = {
  id: string;
  status: string;
  questions: Array<{
    id: string;
    kind: string;
    prompt: string;
    options?: Array<{ id: string; label: string }>;
  }>;
};

async function answerHumanInput(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
  requestId: string,
  responder: HumanInputResponder | undefined,
): Promise<boolean> {
  if (!responder) return false;
  const request = await apiRequest<HumanInputRequestView>(
    stack,
    workspace,
    "GET",
    `/v1/workspaces/${workspace.workspaceId}/sessions/${sessionId}/human-input-requests/${requestId}`,
  );
  const answers: Array<{ questionId: string; values: string[]; other?: string | null }> = [];
  for (const question of request.questions) {
    const view: HumanInputQuestionView = {
      id: question.id,
      kind: question.kind,
      prompt: question.prompt,
      options: question.options ?? [],
    };
    const answer = responder(view);
    if (answer === null) return false;
    if (question.kind === "text") {
      answers.push({ questionId: question.id, values: [answer] });
      continue;
    }
    const lowered = answer.toLowerCase();
    const match =
      view.options.find((option) => lowered.includes(option.label.toLowerCase())) ??
      view.options.find((option) => option.label.toLowerCase().includes(lowered));
    answers.push(
      match
        ? { questionId: question.id, values: [match.id] }
        : { questionId: question.id, values: [], other: answer },
    );
  }
  await apiRequest(
    stack,
    workspace,
    "POST",
    `/v1/workspaces/${workspace.workspaceId}/sessions/${sessionId}/events`,
    {
      type: "user.humanInputResponse",
      clientEventId: crypto.randomUUID(),
      payload: { requestId, response: { outcome: "answered", answers } },
    },
  );
  return true;
}

async function approvePendingTools(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
  handled: Set<string>,
): Promise<number> {
  const events = await listAllSessionEvents(stack, workspace, sessionId);
  const latest = [...events].reverse().find((event) => event.type === "session.requiresAction");
  const approvals = (latest?.payload as { approvals?: Array<{ id?: unknown }> } | undefined)
    ?.approvals;
  let approved = 0;
  for (const approval of approvals ?? []) {
    if (typeof approval.id !== "string" || handled.has(approval.id)) continue;
    handled.add(approval.id);
    await apiRequest(
      stack,
      workspace,
      "POST",
      `/v1/workspaces/${workspace.workspaceId}/sessions/${sessionId}/events`,
      {
        type: "user.approvalDecision",
        clientEventId: crypto.randomUUID(),
        payload: { approvalId: approval.id, decision: "approve" },
      },
    );
    approved += 1;
  }
  return approved;
}

export async function listAllSessionEvents(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  let after = 0;
  while (true) {
    const page = await listSessionEvents(stack.db, workspace.workspaceId, sessionId, after, 500);
    all.push(...page);
    if (page.length < 500) return all;
    after = page.at(-1)!.sequence;
  }
}
