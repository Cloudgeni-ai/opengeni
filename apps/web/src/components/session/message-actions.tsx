import { GitForkIcon } from "lucide-react";
import type { AgentMessageItem, UserMessageItem } from "@opengeni/react/session";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { SessionFeedback } from "@/components/feedback";

/** Host-owned actions share the timeline's existing Copy hover/focus row. */
export default function MessageActions(props: {
  item: AgentMessageItem | UserMessageItem;
  client: OpenGeniBrowserClient;
  workspaceId: string;
  sessionId: string;
  mayRate: boolean;
  mayFork: boolean;
  savedSentiment: "positive" | "negative" | null;
  onRated: (turnId: string, sentiment: "positive" | "negative") => void;
  onFork: (eventId: string) => void;
}) {
  const { item } = props;
  if (
    (item.kind === "agent-message" && item.streaming) ||
    (item.kind === "user-message" && item.delivery)
  )
    return null;
  const eventId = item.annotationSource?.eventId;
  return (
    <>
      {props.mayRate && item.kind === "agent-message" && item.turnId ? (
        <SessionFeedback
          compact
          client={props.client}
          workspaceId={props.workspaceId}
          sessionId={props.sessionId}
          turnId={item.turnId}
          savedSentiment={props.savedSentiment}
          onRated={(sentiment) => props.onRated(item.turnId!, sentiment)}
        />
      ) : null}
      {props.mayFork && eventId ? (
        <button
          type="button"
          aria-label="Fork from here"
          title="Fork from here"
          onClick={() => props.onFork(eventId)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-70"
        >
          <GitForkIcon className="size-3.5" />
        </button>
      ) : null}
    </>
  );
}
