// The person's "Let the agent decide" message in the chat whose agent was
// handed a sub-session's question: the question, then what the agent chose
// once the sub-session's request settles.
import type { OpenGeniClient, SessionHumanInputRequest } from "@opengeni/sdk";
import { CheckIcon } from "lucide-react";
import { useCallback } from "react";

import { usePolledValue } from "../../../hooks/internal";
import { useOpenGeniText } from "../../../messages/runtime";
import type { UserMessageItem } from "../../../timeline/types";
import { cn } from "../../lib/utils";

export type HumanInputDelegationRecordClient = Pick<OpenGeniClient, "getHumanInputRequest">;

const POLL_MS = 10_000;
const VISIBLE_PREFIX = "Let the agent decide: ";

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
  request: SessionHumanInputRequest | null,
  deciding: string,
): {
  settled: boolean;
  text: string;
} {
  if (!request || request.status === "pending") {
    return { settled: false, text: deciding };
  }
  const byAgent = request.respondedBy?.startsWith("agent_attempt:") ?? false;
  if (request.status === "answered") {
    const summary = humanInputDecisionSummary(request);
    const who = byAgent ? "Agent decided" : "Answered";
    return { settled: true, text: summary ? `${who}: ${summary}` : who };
  }
  if (request.status === "skipped") {
    return { settled: true, text: byAgent ? "Agent skipped" : "Skipped" };
  }
  return { settled: true, text: request.status === "expired" ? "Expired" : "Cancelled" };
}

export function HumanInputDelegationRecord({
  client,
  workspaceId,
  item,
  request: suppliedRequest,
}: {
  client: HumanInputDelegationRecordClient;
  workspaceId: string;
  item: UserMessageItem & {
    humanInputDelegation: NonNullable<UserMessageItem["humanInputDelegation"]>;
  };
  /** Previews and tests may supply the request instead of reading it. */
  request?: SessionHumanInputRequest | null | undefined;
}) {
  const { sessionId, requestId } = item.humanInputDelegation;
  const load = useCallback(
    () => client.getHumanInputRequest(workspaceId, sessionId, requestId),
    [client, requestId, sessionId, workspaceId],
  );
  const read = usePolledValue(load, {
    pollIntervalMs: POLL_MS,
    enabled: suppliedRequest === undefined,
  });
  const request = suppliedRequest === undefined ? read.data : suppliedRequest;
  const question = item.text.startsWith(VISIBLE_PREFIX)
    ? item.text.slice(VISIBLE_PREFIX.length)
    : item.text;
  const t = useOpenGeniText();
  const line = decisionLine(request, t("humanInputModel.yourAgentIsDeciding"));
  return (
    <div
      data-testid="timeline-user"
      data-human-input-delegation={requestId}
      data-human-input-delegation-settled={line.settled ? "" : undefined}
      className="flex min-w-0 flex-col gap-1"
    >
      <p className="m-0 text-xs font-medium text-fg-muted">
        {t("messageTimeline.youLetTheAgentDecide")}
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
