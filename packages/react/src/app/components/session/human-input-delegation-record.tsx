// The person's "Let the agent decide" message in the chat whose agent was
// handed a sub-session's question: the question, then what the agent chose
// once the sub-session's request settles. Polling stops once it is settled.
import type { OpenGeniClient, SessionHumanInputRequest } from "@opengeni/sdk";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { usePolledValue } from "../../../hooks/internal";
import { humanInputDelegationQuestionText } from "../../../human-input-delegation";
import { useOpenGeniText, type OpenGeniText } from "../../../messages/runtime";
import type { UserMessageItem } from "../../../timeline/types";
import { cn } from "../../lib/utils";

export type HumanInputDelegationRecordClient = Pick<OpenGeniClient, "getHumanInputRequest">;

export const HUMAN_INPUT_DELEGATION_POLL_MS = 10_000;

/** "main" or "Staging · Run the migrations": each answer, option ids shown as their labels. */
export function humanInputDecisionSummary(request: SessionHumanInputRequest): string {
  const response = request.response;
  if (response?.outcome !== "answered") return "";
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  return response.answers
    .map((answer) => {
      const question = questions.get(answer.questionId);
      const labels = answer.values.map(
        (value) => question?.options.find((option) => option.id === value)?.label ?? value,
      );
      const other = answer.other?.trim();
      return [...labels, ...(other ? [other] : [])].join(", ");
    })
    .filter(Boolean)
    .join(" · ");
}

function decisionLine(
  t: OpenGeniText,
  request: SessionHumanInputRequest | null,
): {
  settled: boolean;
  text: string;
} {
  if (!request || request.status === "pending") {
    return { settled: false, text: t("humanInputModel.yourAgentIsDeciding") };
  }
  const byAgent = request.respondedBy?.startsWith("agent_attempt:") ?? false;
  if (request.status === "answered") {
    const summary = humanInputDecisionSummary(request);
    const text = byAgent
      ? summary
        ? t("messageTimeline.agentDecidedSummary", { summary })
        : t("messageTimeline.agentDecided")
      : summary
        ? t("messageTimeline.answeredSummary", { summary })
        : t("messageTimeline.answered");
    return { settled: true, text };
  }
  if (request.status === "skipped") {
    return {
      settled: true,
      text: byAgent ? t("messageTimeline.agentSkipped") : t("messageTimeline.skipped"),
    };
  }
  return {
    settled: true,
    text:
      request.status === "expired" ? t("messageTimeline.expired") : t("messageTimeline.cancelled"),
  };
}

export function HumanInputDelegationRecord({
  client,
  workspaceId,
  item,
  viewerSubjectId,
  request: suppliedRequest,
}: {
  client: HumanInputDelegationRecordClient;
  workspaceId: string;
  item: UserMessageItem & {
    humanInputDelegation: NonNullable<UserMessageItem["humanInputDelegation"]>;
  };
  /**
   * The person viewing the chat. A hand-off someone else sent is not "You";
   * the sender line above the message names them.
   */
  viewerSubjectId?: string | undefined;
  /** Previews and tests may supply the request instead of reading it. */
  request?: SessionHumanInputRequest | null | undefined;
}) {
  const { sessionId, requestId } = item.humanInputDelegation;
  const load = useCallback(
    () => client.getHumanInputRequest(workspaceId, sessionId, requestId),
    [client, requestId, sessionId, workspaceId],
  );
  // Poll only until the request settles: its answer cannot change after that.
  const [readSettled, setReadSettled] = useState(false);
  const read = usePolledValue(load, {
    pollIntervalMs: readSettled ? undefined : HUMAN_INPUT_DELEGATION_POLL_MS,
    enabled: suppliedRequest === undefined,
  });
  const loadedSettled = read.data != null && read.data.status !== "pending";
  useEffect(() => {
    setReadSettled(loadedSettled);
  }, [loadedSettled]);
  const request = suppliedRequest === undefined ? read.data : suppliedRequest;
  const t = useOpenGeniText();
  const question = humanInputDelegationQuestionText(t, item.text);
  const line = decisionLine(t, request);
  const fromViewer =
    !item.sender || viewerSubjectId === undefined || item.sender.subjectId === viewerSubjectId;
  return (
    <div
      data-testid="timeline-user"
      data-human-input-delegation={requestId}
      data-human-input-delegation-settled={line.settled ? "" : undefined}
      className="flex min-w-0 flex-col gap-1"
    >
      <p className="m-0 text-xs font-medium text-fg-muted">
        {fromViewer
          ? t("messageTimeline.youLetTheAgentDecide")
          : t("humanInputModel.letTheAgentDecide")}
      </p>
      <p className="m-0 text-sm text-fg [overflow-wrap:anywhere]">{question}</p>
      <p
        role="status"
        className={cn(
          "m-0 inline-flex min-w-0 items-center gap-1.5 text-xs",
          line.settled ? "text-fg" : "text-fg-muted",
        )}
      >
        {line.settled ? (
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-status-success" />
        ) : (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-waiting" />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
      </p>
    </div>
  );
}
