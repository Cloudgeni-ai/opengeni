import { AlertTriangleIcon, ArrowLeftIcon, AudioLinesIcon, TerminalIcon } from "lucide-react";
import {
  UserMessageBody as CollapsibleUserMessageBody,
  type UserMessageItem,
} from "@opengeni/react";
import { lazy, Suspense } from "react";

import { MarkdownText } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/format";
import type { Session } from "@/types";
import { MessageFileSkeletons, MessageRepositoryChips } from "./message-resource-placeholders";

const MessageResourceAttachments = lazy(() => import("./message-resource-attachments"));

export function TerminalSessionBanner(props: { session: Session; onNewSession: () => void }) {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-status-cancelled/30 bg-status-cancelled/10 p-3 text-status-cancelled sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-cancelled" />
        <div className="min-w-0">
          <div className="text-sm font-medium">
            This session was cancelled and cannot be continued.
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            Started {formatTimestamp(props.session.createdAt)}.
          </div>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={props.onNewSession}
        className="shrink-0"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to sessions
      </Button>
    </div>
  );
}

export function TerminalSessionArchive(props: { session: Session; eventCount: number }) {
  return (
    <div className="grid min-h-[18rem] place-items-center rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <TerminalIcon className="size-4" />
        </div>
        <div className="text-sm font-medium">Cancelled session (read-only)</div>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          This is a saved event log from {formatTimestamp(props.session.createdAt)}, not a current
          run. Sanitized debug metadata is available in the inspector.
        </p>
        <div className="mt-3 text-2xs uppercase tracking-wide text-fg-subtle">
          {props.eventCount} timeline item{props.eventCount === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

/** Attachment previews/chips + repository chips + markdown body inside the user bubble. */
export function UserMessageBody({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: UserMessageItem;
}) {
  const hasFiles = item.resources.some((resource) => resource.kind === "file");
  const repositoryChips = item.resources.some((resource) => resource.kind === "repository") ? (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <MessageRepositoryChips resources={item.resources} />
    </div>
  ) : null;

  return (
    <div data-testid="timeline-user">
      {item.presentation ? (
        <div className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-fg-muted">
          <AudioLinesIcon className="size-3.5" />
          {item.presentation.kind === "realtime_voice_handoff" ? "Voice handoff" : "Voice request"}
        </div>
      ) : null}
      {hasFiles ? (
        <Suspense
          fallback={
            <>
              <MessageFileSkeletons resources={item.resources} />
              {repositoryChips}
            </>
          }
        >
          <MessageResourceAttachments workspaceId={workspaceId} resources={item.resources} />
        </Suspense>
      ) : (
        repositoryChips
      )}

      <CollapsibleUserMessageBody messageId={item.id} text={item.text}>
        <MarkdownText text={item.text} compact />
      </CollapsibleUserMessageBody>

      {item.presentation ? (
        <details className="group mt-2 border-t border-border/60 pt-1.5 text-xs text-fg-muted">
          <summary className="cursor-pointer select-none list-none hover:text-fg [&::-webkit-details-marker]:hidden">
            Context sent to agent
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-fg-muted">
            {item.presentation.context}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
