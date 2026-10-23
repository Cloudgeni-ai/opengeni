import { SessionConversation, type TimelineItem } from "@opengeni/react";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { Archive, Gauge, Menu, MoreHorizontal, Pin, PinOff, Shapes, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../lib/agents";
import { appApi, client, EFFORT_LABELS, type EffortLevel } from "../lib/app-api";
import { useAppEvents } from "../lib/app-events";
import { buildModelContext, type ReplyLength } from "../lib/context";
import { AgentAvatar } from "./AgentAvatar";
import { IconPicker } from "./IconPicker";
import { renderConnectionCard } from "./ConnectionCard";
import { renderMessageBody } from "./MessageBody";

export type ChatViewProps = {
  workspaceId: string;
  agent: Agent;
  agents: Agent[];
  effort: EffortLevel;
  defaultEffort: EffortLevel;
  replyLength: ReplyLength;
  connections: string[];
  catalog: CapabilityCatalogItem[];
  onOpenAgent: (sessionId: string) => void;
  onOpenSidebar: () => void;
};

export function ChatView(props: ChatViewProps) {
  const { agent, workspaceId } = props;
  const events = useAppEvents();
  const [behind, setBehind] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => setBehind(null), [agent.id]);

  const context = useCallback(
    (tellMore?: string) =>
      buildModelContext({
        self: latest.current.agent,
        agents: latest.current.agents,
        connections: latest.current.connections,
        replyLength: latest.current.replyLength,
        tellMore: tellMore ?? null,
      }),
    [],
  );

  const conversationRef = useRef<HTMLDivElement>(null);
  const send = useCallback(
    async (text: string, tellMore?: string) => {
      void appApi.usage(workspaceId, agent.id, "send");
      await client.sendMessage(workspaceId, agent.id, {
        text,
        modelContext: context(tellMore),
      });
      followBottom(conversationRef.current);
    },
    [agent.id, context, workspaceId],
  );

  const agentsById = useMemo(
    () => new Map(props.agents.map((entry) => [entry.id, entry])),
    [props.agents],
  );
  const resolveSessionTitle = useCallback(
    (sessionId: string) =>
      latest.current.agents.find((entry) => entry.id === sessionId)?.name ?? null,
    [],
  );
  const onOpenSession = useCallback(
    (sessionId: string) => {
      if (latest.current.agents.some((entry) => entry.id === sessionId))
        props.onOpenAgent(sessionId);
      else setBehind(sessionId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props read through the ref
    [],
  );

  const messageContext = useMemo(
    () => ({
      workspaceId,
      sessionId: agent.id,
      onOpenAgent: props.onOpenAgent,
      onTellMore: (excerpt: string) => void send("Tell me more", excerpt),
      findAgent: (id: string) => latest.current.agents.find((entry) => entry.id === id),
    }),
    [agent.id, props.onOpenAgent, send, workspaceId],
  );

  const catalog = props.catalog;
  const fresh = neverTalked(agent);
  const timelineProps = useMemo(
    () => ({
      turnSummary: { rolling: true },
      renderAuthNeeded: (item: Parameters<typeof renderConnectionCard>[0]) =>
        renderConnectionCard(item, {
          workspaceId,
          sessionId: agent.id,
          catalog,
          onComputerReady: () => void send("My computer is ready. Go ahead."),
          onChromeReady: () => void send("My Chrome is connected. Go ahead."),
        }),
      // History streams in after mount; only a chat that never had a turn gets
      // the welcome, so an existing conversation never flashes it.
      emptyState: fresh ? <EmptyState agent={agent} onPick={(text) => void send(text)} /> : <div />,
      shouldRenderItem: chatOnly,
      trailingState: agent.working ? <WorkingRow key={agent.id} /> : null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the empty state only needs identity
    [agent.id, agent.name, agent.profile?.icon, agent.working, fresh, catalog, send, workspaceId],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header {...props} onChanged={events.changed} />
      <div className="relative flex min-h-0 flex-1">
        <div ref={conversationRef} className="min-w-0 flex-1">
          <SessionConversation
            key={agent.id}
            sessionId={agent.id}
            className="h-full"
            renderMessageText={(text, item) => renderMessageBody(text, item, messageContext)}
            onOpenSession={onOpenSession}
            resolveSessionTitle={resolveSessionTitle}
            timelineProps={timelineProps}
            composerProps={{ placeholder: `Message ${agent.name}` }}
            composerOptions={{
              busySend: "steer",
              sendExtras: () => ({ modelContext: context() }),
              onSent: () => void appApi.usage(workspaceId, agent.id, "send"),
            }}
            goalChrome={false}
            genieLoading={{ messages: { status: "Thinking…" } }}
          />
        </div>
        {behind ? (
          <BehindTheScenes
            sessionId={behind}
            title={agentsById.get(behind)?.name ?? null}
            onClose={() => setBehind(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function Header({
  workspaceId,
  agent,
  effort,
  defaultEffort,
  onOpenSidebar,
  onChanged,
}: ChatViewProps & { onChanged: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const isMain = agent.role === "main";
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const run = (action: () => Promise<unknown>) => {
    setMenuOpen(false);
    void action().then(onChanged, (error) =>
      window.alert(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3 py-2.5 md:px-5">
      <button
        type="button"
        onClick={onOpenSidebar}
        className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:hidden"
        aria-label="Open agents"
      >
        <Menu size={18} />
      </button>
      <AgentAvatar agent={agent} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold">{agent.name}</h1>
          {agent.working ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> Working
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-[var(--app-muted)]">
          {agent.description ??
            (isMain
              ? "Your main agent. Ask for anything."
              : agent.shared
                ? "Workspace agent"
                : "Personal agent")}
        </p>
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setPicking(false);
            setMenuOpen((open) => !open);
          }}
          className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
          aria-label="Agent options"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={18} />
        </button>
        {menuOpen ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div className="card-in absolute right-0 z-40 mt-1 w-64 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-1.5 text-sm shadow-xl">
              {!isMain ? (
                <MenuItem
                  icon={agent.session.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                  label={agent.session.pinned ? "Unpin" : "Pin to top"}
                  onClick={() =>
                    run(() =>
                      client.updateSessionPin(workspaceId, agent.id, {
                        pinned: !agent.session.pinned,
                      }),
                    )
                  }
                />
              ) : null}
              {!isMain ? (
                <MenuItem
                  icon={<Shapes size={15} />}
                  label="Change icon"
                  onClick={() => setPicking((open) => !open)}
                />
              ) : null}
              {picking && !isMain ? (
                <IconPicker
                  current={agent.profile?.icon ?? null}
                  onPick={(icon) =>
                    run(() => appApi.updateProfile(workspaceId, agent.id, { icon }))
                  }
                />
              ) : null}
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--app-muted)] uppercase">
                <Gauge size={12} className="mr-1 inline" /> Thinking
              </div>
              {(Object.keys(EFFORT_LABELS) as EffortLevel[]).map((level) => {
                const isDefault = !agent.profile?.effort && level === defaultEffort;
                const active = level === effort;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() =>
                      run(() =>
                        appApi.updateProfile(workspaceId, agent.id, {
                          effort: level === defaultEffort ? null : level,
                        }),
                      )
                    }
                    className={`flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left hover:bg-[var(--app-hover)] ${active ? "font-medium" : ""}`}
                  >
                    <span>
                      {EFFORT_LABELS[level].label}
                      <span className="ml-1.5 text-xs text-[var(--app-muted)]">
                        {EFFORT_LABELS[level].hint}
                      </span>
                    </span>
                    {active ? (
                      <span className="text-xs text-[var(--app-accent)]">
                        {isDefault ? "Default" : "✓"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {!isMain ? (
                <>
                  <div className="my-1 border-t border-[var(--app-border)]" />
                  <MenuItem
                    icon={<Archive size={15} />}
                    label="Archive agent"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Archive ${agent.name}? Its chat is kept but it leaves the sidebar.`,
                        )
                      )
                        return;
                      run(() =>
                        client.updateSessionArchive(workspaceId, agent.id, {
                          archived: true,
                        }),
                      );
                    }}
                  />
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left hover:bg-[var(--app-hover)]"
    >
      <span className="text-[var(--app-muted)]">{icon}</span>
      {label}
    </button>
  );
}

const MAIN_SUGGESTIONS = [
  "What can you do for me?",
  "Make me an agent that keeps an eye on my GitHub repos",
  "Build a small website for a weekend project",
  "Every morning at 8, send me a short news digest",
];

// A chat nobody has written in holds only its setup events (created, title,
// agent settings); the first message adds a user message, a queued turn and
// status changes. Token counts are no signal: compaction and failed turns
// leave them empty.
const SETUP_EVENTS = 4;

function neverTalked(agent: Agent) {
  const session = agent.session as typeof agent.session & {
    initialMessage?: string | null;
    lastSequence?: number | null;
  };
  return (
    !session.initialMessage &&
    session.activeTurnId == null &&
    (session.lastSequence ?? 0) <= SETUP_EVENTS
  );
}

const BLANK_SUGGESTIONS = [
  "A research assistant that digs into topics for me",
  "A writing partner for emails and posts",
  "A helper for one of my GitHub repos",
];

function EmptyState({ agent, onPick }: { agent: Agent; onPick: (text: string) => void }) {
  const blank =
    agent.session.metadata?.simpleApp &&
    (agent.session.metadata.simpleApp as { blank?: boolean }).blank;
  const suggestions = agent.role === "main" ? MAIN_SUGGESTIONS : blank ? BLANK_SUGGESTIONS : [];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 pt-[12vh] text-center">
      <AgentAvatar agent={agent} size={88} />
      <h2 className="mt-4 text-xl font-semibold tracking-tight">
        {agent.role === "main" ? "Hi, I'm Geni" : blank ? "What should this agent do?" : agent.name}
      </h2>
      <p className="mt-1 text-sm text-[var(--app-muted)]">
        {agent.role === "main"
          ? "Ask me anything. I can build sites, work on GitHub, schedule things and set up specialist agents."
          : blank
            ? "Describe it in your own words. It takes shape as you talk."
            : (agent.description ?? "Say hi to get started.")}
      </p>
      {suggestions.length ? (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="rounded-full border border-[var(--app-border)] bg-[var(--app-card)] px-3.5 py-2 text-sm hover:border-[var(--app-accent)]"
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BehindTheScenes({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title: string | null;
  onClose: () => void;
}) {
  return (
    <aside className="card-in absolute inset-0 z-20 flex flex-col border-l border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl md:static md:w-[44%] md:min-w-[360px] md:shadow-none">
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wide text-[var(--app-muted)] uppercase">
            Behind the scenes
          </div>
          <div className="truncate text-sm font-medium">{title ?? "Helper"}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
          aria-label="Close"
        >
          <X size={17} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <SessionConversation
          key={sessionId}
          sessionId={sessionId}
          className="h-full"
          composerProps={{ placeholder: "Nudge this helper" }}
          composerOptions={{ busySend: "steer" }}
        />
      </div>
    </aside>
  );
}

/** Three soft dots while the agent works; after a while, a word on why it takes long. */
function WorkingRow() {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLong(true), 25_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-6 pt-2 pb-6 text-sm text-[var(--app-muted)]">
      <span className="working-dots" aria-label="Working">
        <span />
        <span />
        <span />
      </span>
      {long ? <span className="card-in">Working on it</span> : null}
    </div>
  );
}

/**
 * The chat shows the conversation and the cards that need the person, never
 * the work behind it (tool calls, helpers, waits, summaries).
 */
function chatOnly(item: TimelineItem) {
  switch (item.kind) {
    case "user-message":
    case "human-input":
    case "auth-needed":
      return true;
    case "agent-message":
      return item.phase !== "commentary";
    default:
      return false;
  }
}

/**
 * Messages sent from outside the composer (suggestions, "Tell me more") don't
 * move the timeline, so follow the bottom while the reply starts streaming.
 */
function followBottom(root: HTMLElement | null) {
  if (!root) return;
  const scroller = () =>
    [...root.querySelectorAll<HTMLElement>("*")].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 4 &&
        /(auto|scroll)/.test(getComputedStyle(element).overflowY),
    );
  let ticks = 0;
  const timer = setInterval(() => {
    const element = scroller();
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    if (++ticks >= 12) clearInterval(timer);
  }, 250);
}
