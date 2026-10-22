import { useMemo, useRef, type CSSProperties } from "react";
import { cn } from "../lib/cn";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";
import { useOpenGeniText } from "../messages/runtime";
import { EMBEDDED_GENIE_LOADING, type GenieLoadingOptions } from "../timeline/genie-loading";
import type { TimelineItem } from "../timeline/types";
import { MessageTimeline, type MessageTimelineProps } from "./message-timeline";

export type PendingConversationProps = {
  /** The prompt exactly as the person sent it. */
  text: string;
  /** When the person sent it (ISO 8601). Anchors the startup row's clock. */
  sentAt: string;
  /** Same option as `SessionConversationView`; defaults to the neutral embedded copy. */
  genieLoading?: GenieLoadingOptions | undefined;
  renderMessageText?: MessageTimelineProps["renderMessageText"];
  theme?: HostThemePreference | undefined;
  surface?: HostSurfacePreference | undefined;
  className?: string | undefined;
  /** Defaults to filling the host. */
  height?: CSSProperties["height"];
};

/**
 * A prompt whose session the host is still creating, shown exactly as the
 * conversation will show it: the sent message and the same startup row
 * `SessionConversationView` keeps until the turn's own work row takes over.
 * Render it in the conversation's place while your create call runs, then
 * swap in the conversation; nothing moves and no second loading style shows.
 */
export function PendingConversation({
  text,
  sentAt,
  genieLoading,
  renderMessageText,
  theme,
  surface,
  className,
  height = "100%",
}: PendingConversationProps) {
  const t = useOpenGeniText();
  const region = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(region, { theme, surface });
  const items = useMemo(() => pendingConversationTimeline(text, sentAt), [text, sentAt]);
  const loading = useMemo(
    () => ({
      ...EMBEDDED_GENIE_LOADING(t),
      ...genieLoading,
      phrases: genieLoading?.phrases?.length
        ? genieLoading.phrases
        : EMBEDDED_GENIE_LOADING(t).phrases,
      messages: { ...EMBEDDED_GENIE_LOADING(t).messages, ...genieLoading?.messages },
    }),
    [genieLoading, t],
  );
  return (
    <div
      className={cn(
        "og-root flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-og-bg text-og-base text-og-fg",
        className,
      )}
      ref={region}
      style={{ ...hostTheme.style, height }}
      data-og-theme={hostTheme.attribute}
      data-og-host-theme=""
      data-og-conversation=""
      data-og-pending-conversation=""
    >
      <MessageTimeline
        className="isolate min-h-0 flex-1 overflow-hidden"
        items={items}
        events={[]}
        status="queued"
        genieLoading={loading}
        turnSummary={{ rolling: true }}
        {...(renderMessageText ? { renderMessageText } : {})}
      />
    </div>
  );
}

/** The sent prompt and its running startup row, as the live projection renders them. */
export function pendingConversationTimeline(text: string, sentAt: string): TimelineItem[] {
  return [
    {
      kind: "user-message",
      id: "pending-conversation:message",
      text,
      resources: [],
      tools: [],
      occurredAt: sentAt,
    },
    {
      kind: "startup-phase",
      id: "pending-conversation:startup",
      turnId: "pending-conversation",
      phase: "queue",
      status: "running",
      startedAt: sentAt,
      occurredAt: sentAt,
      completedAt: null,
      durationMs: null,
      outcome: null,
    },
  ];
}
