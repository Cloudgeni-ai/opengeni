import {
  Markdown,
  UserMessageBody,
  type AgentMessageItem,
  type UserMessageItem,
} from "@opengeni/react";
import { SESSION_SCOPE_HEADER } from "@opengeni/sdk";
import { Sparkles } from "lucide-react";
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { splitActionBlocks } from "../lib/blocks";
import { client } from "../lib/app-api";
import type { Agent } from "../lib/agents";
import { ActionCard } from "./ActionCard";

const ChatInteractiveBlock = lazy(() =>
  import("../../../../packages/react/src/components/artifacts/chat-interactive-block").then(
    (module) => ({ default: module.ChatInteractiveBlock }),
  ),
);

export type MessageBodyContext = {
  workspaceId: string;
  sessionId: string;
  onOpenAgent: (sessionId: string) => void;
  onTellMore: (excerpt: string) => void;
  findAgent: (sessionId: string) => Agent | undefined;
};

/** Agent replies with their action blocks swapped for cards, plus "Tell me more". */
export function renderMessageBody(
  text: string,
  item: AgentMessageItem | UserMessageItem,
  context: MessageBodyContext,
): ReactNode {
  if (item.kind === "user-message") {
    return (
      <UserMessageBody messageId={item.id} text={text}>
        <Markdown softLineBreaks>{text}</Markdown>
      </UserMessageBody>
    );
  }
  return <AgentMessage text={text} item={item} context={context} />;
}

function AgentMessage({
  text,
  item,
  context,
}: {
  text: string;
  item: AgentMessageItem;
  context: MessageBodyContext;
}) {
  const segments = useMemo(() => splitActionBlocks(text), [text]);
  const scoped = useMemo(
    () => client.withHeaders({ [SESSION_SCOPE_HEADER]: context.sessionId }),
    [context.sessionId],
  );
  const prose = segments
    .flatMap((segment) => (segment.type === "text" ? [segment.text] : []))
    .join("")
    .trim();
  const canTellMore =
    !item.streaming && item.phase !== "commentary" && prose.length > 0 && prose.length < 6000;
  return (
    <div className="group/msg">
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          segment.text.trim() ? (
            <Markdown
              key={segment.start}
              softLineBreaks
              streaming={item.streaming && index === segments.length - 1}
              renderInteractiveBlock={(block) => (
                <Suspense
                  fallback={<div className="h-40 animate-pulse rounded-xl bg-[var(--app-hover)]" />}
                >
                  <ChatInteractiveBlock
                    workspaceId={context.workspaceId}
                    client={scoped}
                    {...block}
                  />
                </Suspense>
              )}
            >
              {segment.text}
            </Markdown>
          ) : null
        ) : (
          <ActionCard
            key={segment.start}
            block={segment.block}
            workspaceId={context.workspaceId}
            sourceSessionId={context.sessionId}
            occurredAt={item.occurredAt}
            onOpenAgent={context.onOpenAgent}
            findAgent={context.findAgent}
          />
        ),
      )}
      {canTellMore ? (
        <button
          type="button"
          onClick={() => context.onTellMore(prose)}
          className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] px-2.5 py-1 text-xs text-[var(--app-muted)] opacity-0 transition-opacity group-hover/msg:opacity-100 hover:text-[var(--app-fg)] focus-visible:opacity-100 max-md:opacity-100"
        >
          <Sparkles size={12} />
          Tell me more
        </button>
      ) : null}
    </div>
  );
}
