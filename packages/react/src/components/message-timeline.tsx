import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  SquareTerminalIcon,
  TargetIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../lib/cn";
import { formatRelativeTime, stringifyPayload, truncate } from "../lib/format";
import { Markdown } from "./markdown";
import {
  buildTimeline,
  compactPayloadPreview,
  groupTimeline,
  toolDisplayName,
  type AgentMessageItem,
  type GoalItem,
  type NoticeItem,
  type ReasoningItem,
  type SandboxItem,
  type TimelineItem,
  type ToolCallItem,
  type UserMessageItem,
  type WorkerItem,
} from "../timeline";
import { SESSION_STATUS_META, StatusDot } from "./session-status";

export type MessageTimelineProps = {
  /** Raw session events (projected internally) … */
  events?: SessionEvent[] | undefined;
  /** … or pre-projected items (e.g. from `useSessionEvents().timeline`). */
  items?: TimelineItem[] | undefined;
  /** Current session status; drives the live "working" indicator. */
  status?: SessionStatus | null | undefined;
  /** Plug a markdown renderer for message bodies (e.g. streamdown). */
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  /** Drill into a spawned worker session. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** Follow new events when pinned to the bottom. Defaults to true. */
  autoFollow?: boolean | undefined;
  emptyState?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * The session timeline: chat messages with streaming deltas, collapsed
 * activity clusters (reasoning, tool calls, sandbox work), spawned-worker
 * cards, goal markers, and status transitions. Owns stick-to-bottom scrolling
 * with a "jump to latest" affordance when the reader scrolls back.
 */
export function MessageTimeline({
  events,
  items,
  status,
  renderMessageText,
  onOpenSession,
  autoFollow = true,
  emptyState,
  className,
}: MessageTimelineProps) {
  const resolvedItems = useMemo(() => items ?? buildTimeline(events ?? []), [items, events]);
  const groups = useMemo(() => groupTimeline(resolvedItems), [resolvedItems]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const lastItem = resolvedItems[resolvedItems.length - 1];
  const streaming = lastItem !== undefined && (lastItem.kind === "agent-message" || lastItem.kind === "reasoning") && lastItem.streaming;
  const working = status === "running" && !streaming;

  // Follow the stream while pinned to the bottom; never fight the reader.
  useEffect(() => {
    const node = scrollRef.current;
    if (node && autoFollow && pinned) {
      node.scrollTop = node.scrollHeight;
    }
  }, [resolvedItems, working, autoFollow, pinned]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
  };

  return (
    <div className={cn("og-root relative flex min-h-0 flex-col", className)}>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {groups.length === 0 && !working
            ? (emptyState ?? <p className="py-10 text-center text-sm text-og-fg-subtle">No activity yet.</p>)
            : null}
          {groups.map((group) =>
            group.kind === "activity" ? (
              <ActivityCluster key={group.id} items={group.items} onOpenSession={onOpenSession} />
            ) : (
              <TimelineRow key={group.item.id} item={group.item} renderMessageText={renderMessageText} />
            ),
          )}
          {working ? (
            <div className="animate-og-enter flex items-center gap-2 text-sm">
              <span className="og-shimmer-text font-medium">Working…</span>
            </div>
          ) : null}
        </div>
      </div>
      <AnimatePresence>
        {!pinned && autoFollow ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onClick={() => {
              const node = scrollRef.current;
              if (node) {
                node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
              }
              setPinned(true);
            }}
            className={cn(
              "absolute bottom-4 left-1/2 -translate-x-1/2",
              "inline-flex items-center gap-1.5 rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1.5",
              "text-xs font-medium text-og-fg shadow-og-md backdrop-blur",
              "hover:border-og-border-strong",
            )}
          >
            <ArrowDownIcon className="size-3.5" />
            Jump to latest
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* --- single rows ------------------------------------------------------------ */

function TimelineRow({
  item,
  renderMessageText,
}: {
  item: TimelineItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  switch (item.kind) {
    case "user-message":
      return <UserMessageRow item={item} renderMessageText={renderMessageText} />;
    case "agent-message":
      return <AgentMessageRow item={item} renderMessageText={renderMessageText} />;
    case "session-status":
      return <SessionStatusRow item={item} />;
    case "goal":
      return <GoalRow item={item} />;
    case "notice":
      return <NoticeRow item={item} />;
    default:
      return null;
  }
}

function UserMessageRow({
  item,
  renderMessageText,
}: {
  item: UserMessageItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  return (
    <div className="animate-og-enter flex justify-end">
      <div className="max-w-[85%] min-w-0 rounded-og-lg rounded-br-og-xs border border-og-border bg-og-surface-2 px-4 py-2.5 text-[15px] leading-6 text-og-fg">
        {renderMessageText ? renderMessageText(item.text, item) : <Markdown>{item.text}</Markdown>}
      </div>
    </div>
  );
}

function AgentMessageRow({
  item,
  renderMessageText,
}: {
  item: AgentMessageItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  const caret = item.streaming ? (
    <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-og-blink rounded-full bg-og-accent" aria-hidden />
  ) : null;
  return (
    <div className="animate-og-enter min-w-0 text-[15px] leading-7 text-og-fg">
      {renderMessageText ? (
        <>
          {renderMessageText(item.text, item)}
          {caret}
        </>
      ) : (
        // While streaming, let the caret ride the end of the last rendered line:
        // the trailing block (usually a <p>) flows inline so the caret sits on
        // its baseline instead of dropping to a new line.
        <div className={item.streaming ? "[&_>div>:last-child]:inline" : undefined}>
          <Markdown>{item.text}</Markdown>
          {caret}
        </div>
      )}
    </div>
  );
}

function SessionStatusRow({ item }: { item: { status: SessionStatus; occurredAt: string } }) {
  const meta = SESSION_STATUS_META[item.status];
  return (
    <div className="animate-og-enter flex items-center gap-3 text-[11px] text-og-fg-subtle" role="status">
      <span className="h-px flex-1 bg-og-border" />
      <span className="inline-flex items-center gap-1.5">
        <StatusDot status={item.status} className="size-1" />
        {meta.label.toLowerCase()} · {formatRelativeTime(item.occurredAt)}
      </span>
      <span className="h-px flex-1 bg-og-border" />
    </div>
  );
}

function GoalRow({ item }: { item: GoalItem }) {
  const label =
    item.action === "set"
      ? "Goal set"
      : item.action === "updated"
        ? "Goal updated"
        : item.action === "completed"
          ? "Goal completed"
          : item.action === "paused"
            ? "Goal paused"
            : item.action === "resumed"
              ? "Goal resumed"
              : "Continuing toward the goal";
  return (
    <div className="animate-og-enter flex justify-center">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-og-border bg-og-surface-1 px-3 py-1 text-xs text-og-fg-muted">
        <TargetIcon className="size-3.5 shrink-0 text-og-accent" />
        <span className="truncate">
          {label}
          {item.text ? `: ${truncate(item.text, 90)}` : ""}
        </span>
      </span>
    </div>
  );
}

function NoticeRow({ item }: { item: NoticeItem }) {
  const tone =
    item.tone === "failed"
      ? "border-og-status-failed/35 bg-og-status-failed/10 text-og-status-failed"
      : item.tone === "waiting"
        ? "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting"
        : "border-og-border bg-og-surface-1 text-og-fg-muted";
  return (
    <div className={cn("animate-og-enter flex items-start gap-2.5 rounded-og-md border px-3.5 py-2.5 text-sm", tone)} role="status">
      <TriangleAlertIcon className={cn("mt-0.5 size-4 shrink-0", item.tone === "cancelled" && "opacity-60")} />
      <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
    </div>
  );
}

/* --- activity cluster -------------------------------------------------------- */

type ActivityItem = ReasoningItem | ToolCallItem | WorkerItem | SandboxItem;

function ActivityCluster({
  items,
  onOpenSession,
}: {
  items: ActivityItem[];
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  return (
    <div className="animate-og-enter flex flex-col gap-1.5 border-l-2 border-og-border pl-3 sm:pl-4">
      {items.map((item) => {
        switch (item.kind) {
          case "reasoning":
            return <ReasoningRow key={item.id} item={item} />;
          case "tool-call":
            return <ToolCallRow key={item.id} item={item} />;
          case "worker":
            return <WorkerRow key={item.id} item={item} onOpenSession={onOpenSession} />;
          case "sandbox":
            return <SandboxRow key={item.id} item={item} />;
        }
      })}
    </div>
  );
}

function ActivityDisclosure({
  icon,
  title,
  running,
  failed,
  preview,
  children,
}: {
  icon: ReactNode;
  title: string;
  running: boolean;
  failed?: boolean | undefined;
  preview?: string | undefined;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-og-sm px-1.5 py-1 text-left text-[13px]",
          "text-og-fg-muted transition-colors duration-150 hover:bg-og-surface-1 hover:text-og-fg",
        )}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-150 group-data-[state=open]:rotate-90" />
        <span className={cn("shrink-0", failed ? "text-og-status-failed" : running ? "text-og-status-running" : "text-og-fg-subtle")}>{icon}</span>
        <span className={cn("shrink-0 font-medium", running && "og-shimmer-text", failed && "text-og-status-failed")}>{title}</span>
        {preview ? <span className="min-w-0 flex-1 truncate font-og-mono text-xs text-og-fg-subtle">{preview}</span> : null}
        {running ? <span className="ml-auto size-1.5 shrink-0 animate-og-pulse rounded-full bg-og-status-running" /> : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden">
        <div className="mt-1 mb-1.5 ml-7 flex flex-col gap-2">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const text = stringifyPayload(value);
  if (!text) {
    return null;
  }
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-og-fg-subtle">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-og-sm border border-og-border bg-og-bg/60 p-2.5 font-og-mono text-xs leading-5 text-og-fg-muted">
        {text}
      </pre>
    </div>
  );
}

function ReasoningRow({ item }: { item: ReasoningItem }) {
  return (
    <ActivityDisclosure
      icon={<BrainIcon className="size-3.5" />}
      title={item.streaming ? "Thinking" : "Thought"}
      running={item.streaming}
      preview={truncate(item.text, 110)}
    >
      <p className="whitespace-pre-wrap text-[13px] leading-6 text-og-fg-muted">{item.text}</p>
    </ActivityDisclosure>
  );
}

function ToolCallRow({ item }: { item: ToolCallItem }) {
  return (
    <ActivityDisclosure
      icon={<WrenchIcon className="size-3.5" />}
      title={toolDisplayName(item.name)}
      running={item.status === "running"}
      preview={compactPayloadPreview(item.arguments)}
    >
      <PayloadBlock label="Arguments" value={item.arguments} />
      {item.status === "complete" ? <PayloadBlock label="Output" value={item.output} /> : null}
    </ActivityDisclosure>
  );
}

function SandboxRow({ item }: { item: SandboxItem }) {
  return (
    <ActivityDisclosure
      icon={<SquareTerminalIcon className="size-3.5" />}
      title={toolDisplayName(item.name)}
      running={item.status === "running"}
      failed={item.status === "failed"}
      preview={item.command ?? undefined}
    >
      {item.command ? <PayloadBlock label="Command" value={item.command} /> : null}
      {item.output ? <PayloadBlock label="Output" value={item.output} /> : null}
    </ActivityDisclosure>
  );
}

/** Spawned/messaged worker sessions get a first-class card, not a tool row. */
function WorkerRow({ item, onOpenSession }: { item: WorkerItem; onOpenSession?: ((sessionId: string) => void) | undefined }) {
  const running = item.status === "running";
  const title = item.action === "spawn" ? (running ? "Spawning worker" : "Worker spawned") : running ? "Messaging worker" : "Worker messaged";
  return (
    <div className="my-0.5 flex items-start gap-3 rounded-og-md border border-og-border bg-og-surface-1 p-3 shadow-og-sm">
      <span
        className={cn(
          "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
          "bg-og-accent-soft text-og-accent",
        )}
      >
        <BotIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-[13px] font-medium", running ? "og-shimmer-text" : "text-og-fg")}>{title}</span>
          {running ? <span className="size-1.5 animate-og-pulse rounded-full bg-og-status-running" /> : null}
        </div>
        {item.prompt ? <p className="mt-0.5 truncate text-xs text-og-fg-muted">{truncate(item.prompt, 140)}</p> : null}
        {item.workerSessionId ? (
          <p className="mt-1 font-og-mono text-[11px] text-og-fg-subtle">{item.workerSessionId.slice(0, 8)}</p>
        ) : null}
      </div>
      {item.workerSessionId && onOpenSession ? (
        <button
          type="button"
          onClick={() => item.workerSessionId && onOpenSession(item.workerSessionId)}
          className={cn(
            "shrink-0 self-center rounded-og-sm border border-og-border px-2.5 py-1 text-xs font-medium text-og-fg-muted",
            "transition-colors duration-150 hover:border-og-border-strong hover:text-og-fg",
          )}
        >
          Open session
        </button>
      ) : null}
    </div>
  );
}
