import type { SessionHumanInputRequest, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
import { useEffect, useMemo, useRef } from "react";
import { cn } from "../lib/cn";
import {
  HumanInputForm,
  type HumanInputFormMessages,
  type HumanInputFormProps,
} from "./human-input-form";

export type HumanInputSurfaceProps = {
  requests: SessionHumanInputRequest[];
  onSubmit: (requestId: string, response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  respondingRequestId?: string | null | undefined;
  error?: string | null | undefined;
  messages?: Partial<HumanInputFormMessages> | undefined;
  className?: string | undefined;
  /** Forwarded to the active form. Defaults true. */
  autoFocus?: boolean | undefined;
};

/**
 * One decision shell for pending structured human-input requests. Parallel
 * freezes are shown one at a time (oldest first) as “N of M”; Continue/Skip
 * settles the active request and the next remaining set advances automatically
 * when the authoritative pending list updates.
 */
export function HumanInputSurface({
  requests,
  onSubmit,
  respondingRequestId = null,
  error,
  messages,
  className,
  autoFocus = true,
}: HumanInputSurfaceProps) {
  const batchTotalRef = useRef(0);

  const ordered = useMemo(() => {
    return [...requests].sort((a, b) => {
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
    submitting: respondingRequestId !== null,
    error: error ?? null,
    progressLabel,
    autoFocus,
    ...(messages ? { messages } : {}),
    onSubmit: (response) => onSubmit(active.id, response),
  };

  return (
    <div className={cn("w-full", className)} data-human-input-surface="">
      <HumanInputForm {...formProps} />
    </div>
  );
}
