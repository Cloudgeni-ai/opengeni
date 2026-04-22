import { BotIcon, UserIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type {
  AssistantTurn,
  Conversation,
  ConversationTurn,
  TerminalMarker,
  UserTurn,
} from "@/lib/conversation";
import { cn } from "@/lib/utils";

export function ConversationStream({
  conversation,
  autoScroll = true,
}: {
  conversation: Conversation;
  autoScroll?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.turns.length, conversation.terminal, autoScroll]);

  return (
    <div className="flex flex-col gap-6">
      {conversation.turns.map((turn) => (
        <TurnBlock key={turn.id} turn={turn} />
      ))}
      {conversation.terminal ? <TerminalMark marker={conversation.terminal} /> : null}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

function TurnBlock({ turn }: { turn: ConversationTurn }) {
  if (turn.kind === "user") {
    return <UserMessage turn={turn} />;
  }
  return <AssistantMessage turn={turn} />;
}

function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <div className="message-in flex justify-end gap-3">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-[15px] leading-relaxed",
          "bg-[color:var(--color-surface-2)] text-[color:var(--color-fg)]",
          "border border-[color:var(--color-border)]",
        )}
      >
        <Prose content={turn.content} />
      </div>
      <AvatarBubble variant="user" />
    </div>
  );
}

function AssistantMessage({ turn }: { turn: AssistantTurn }) {
  return (
    <div className="message-in flex justify-start gap-3">
      <AvatarBubble variant="agent" />
      <div
        className={cn(
          "max-w-[80%] text-[15px] leading-relaxed text-[color:var(--color-fg)]",
        )}
      >
        {turn.status === "pending" ? (
          <PendingBubble />
        ) : (
          <Prose content={turn.content ?? ""} />
        )}
      </div>
    </div>
  );
}

function AvatarBubble({ variant }: { variant: "user" | "agent" }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
        "border-[color:var(--color-border)] bg-[color:var(--color-surface)]",
        variant === "agent" && "text-[color:var(--color-brand)]",
        variant === "user" && "text-[color:var(--color-fg-muted)]",
      )}
    >
      {variant === "agent" ? (
        <BotIcon className="size-3.5" />
      ) : (
        <UserIcon className="size-3.5" />
      )}
    </div>
  );
}

function Prose({ content }: { content: string }) {
  if (!content) {
    return (
      <p className="whitespace-pre-wrap italic text-[color:var(--color-fg-subtle)]">
        (empty response)
      </p>
    );
  }
  return <p className="whitespace-pre-wrap break-words">{content}</p>;
}

function PendingBubble() {
  return (
    <div
      aria-label="Agent is thinking"
      role="status"
      className="inline-flex h-7 items-center gap-1.5 rounded-2xl rounded-bl-sm border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3"
    >
      <Dot delay="0s" />
      <Dot delay="0.15s" />
      <Dot delay="0.3s" />
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      aria-hidden="true"
      className="pending-dot inline-block size-1.5 rounded-full bg-[color:var(--color-fg-muted)]"
      style={{ animationDelay: delay }}
    />
  );
}

function TerminalMark({ marker }: { marker: TerminalMarker }) {
  const label =
    marker.kind === "succeeded"
      ? "Done"
      : marker.kind === "cancelled"
        ? "Cancelled"
        : "Failed";
  const tone =
    marker.kind === "succeeded"
      ? "text-[color:var(--color-status-success)]"
      : marker.kind === "cancelled"
        ? "text-[color:var(--color-status-cancelled)]"
        : "text-[color:var(--color-status-failed)]";

  return (
    <div
      role="status"
      className="my-2 flex items-center gap-3 text-[11px] uppercase tracking-widest"
    >
      <span className="h-px flex-1 bg-[color:var(--color-border)]" />
      <span className={cn("font-medium", tone)}>{label}</span>
      {"message" in marker && marker.message ? (
        <span className="truncate text-[color:var(--color-fg-subtle)] normal-case tracking-normal">
          {marker.message}
        </span>
      ) : null}
      <span className="h-px flex-1 bg-[color:var(--color-border)]" />
    </div>
  );
}
