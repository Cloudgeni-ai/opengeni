import type { SessionHumanInputRequest, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
import { useEffect, useMemo, useRef } from "react";
import { isActionableHumanInputRequest } from "../human-input";
import { cn } from "../lib/cn";
import {
  HumanInputForm,
  type HumanInputFormMessages,
  type HumanInputFormProps,
} from "./human-input-form";

export type HumanInputSurfaceProps = {
  loadSkillReview?: HumanInputFormProps["loadSkillReview"];
  requests: SessionHumanInputRequest[];
  onSubmit: (requestId: string, response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  respondingRequestId?: string | null | undefined;
  error?: string | null | undefined;
  messages?: Partial<HumanInputFormMessages> | undefined;
  className?: string | undefined;
  /** Forwarded to the active form. Defaults true. */
  autoFocus?: boolean | undefined;
  /** Forwarded to the active form: yes/no decisions as two buttons. */
  decisionButtons?: boolean | undefined;
  /** Forwarded to the active form: where secret answers may be saved. */
  allowedSaveTo?: HumanInputFormProps["allowedSaveTo"];
  /** Forwarded to the active form: start as its compact bar (drafts kept). */
  defaultCollapsed?: boolean | undefined;
  /**
   * Hand the active request to another agent instead of letting the asking
   * agent decide (see HumanInputForm `onLetAgentDecide`); `false` hides it.
   */
  onLetAgentDecide?:
    | ((request: SessionHumanInputRequest) => void | Promise<void>)
    | false
    | undefined;
  /** Requests an agent was asked to decide: their card says so. */
  agentDecidingRequestIds?: ReadonlySet<string> | undefined;
};

/**
 * One decision shell for pending structured human-input requests. Parallel
 * freezes are shown one at a time (oldest first) as “N of M”; Send answers/Skip
 * settles the active request and the next remaining set advances automatically
 * when the authoritative pending list updates.
 */
export function HumanInputSurface({
  requests,
  onSubmit,
  loadSkillReview,
  respondingRequestId = null,
  error,
  messages,
  className,
  autoFocus = true,
  decisionButtons,
  allowedSaveTo,
  defaultCollapsed,
  onLetAgentDecide,
  agentDecidingRequestIds,
}: HumanInputSurfaceProps) {
  const batchTotalRef = useRef(0);

  const ordered = useMemo(() => {
    const now = Date.now();
    return requests
      .filter((request) => isActionableHumanInputRequest(request, now))
      .sort((a, b) => {
        const aAt = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bAt = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (aAt !== bAt) return aAt - bAt;
        return a.id.localeCompare(b.id);
      });
  }, [requests]);

  useEffect(() => {
    if (ordered.length === 0) {
      batchTotalRef.current = 0;
      return;
    }
    batchTotalRef.current =
      batchTotalRef.current === 0
        ? ordered.length
        : Math.max(batchTotalRef.current, ordered.length);
  }, [ordered]);

  if (ordered.length === 0) return null;

  const active = ordered[0]!;
  const batchTotal = Math.max(batchTotalRef.current, ordered.length);
  const position = batchTotal - ordered.length + 1;
  const progressLabel = batchTotal > 1 ? `${position} of ${batchTotal}` : null;

  const formProps: HumanInputFormProps = {
    request: active,
    loadSkillReview,
    submitting: respondingRequestId !== null,
    error: error ?? null,
    progressLabel,
    autoFocus,
    decisionButtons,
    allowedSaveTo,
    defaultCollapsed,
    ...(messages ? { messages } : {}),
    ...(onLetAgentDecide === false
      ? { onLetAgentDecide: false }
      : onLetAgentDecide
        ? { onLetAgentDecide: () => onLetAgentDecide(active) }
        : {}),
    agentDeciding: agentDecidingRequestIds?.has(active.id) ?? false,
    onSubmit: (response) => onSubmit(active.id, response),
  };

  return (
    <div className={cn("w-full", className)} data-human-input-surface="">
      <HumanInputForm {...formProps} />
    </div>
  );
}
