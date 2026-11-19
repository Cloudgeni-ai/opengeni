// An agent's Test tab: a chat on its newest version (the draft) in the
// organization's Console test workspace. Only you can see or continue it, and
// only here (nobody is a member of that workspace). Servers that log in per
// user take a pasted test token, kept only as that chat's own login. The
// conversation is the app's own transcript component, with its approval
// cards for "Ask first" tools and a Stop control.
import type { OrgAgent, OrgToolServer } from "@opengeni/contracts";
import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import { PauseIcon, PlayIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { approvalsDecidable, projectPendingApprovals } from "@opengeni/react/session";
import {
  ApprovalSurface,
  MessageTimeline,
  type ApprovalSurfaceProps,
} from "@opengeni/react/session-ui";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { Notice } from "@opengeni/react/ui/notice";

import type { OrgAgentsApi } from "@/lib/organization-agents";

const POLL_MS = 2_000;
const PAGE_SIZE = 500;
/** Statuses with a turn under way, which Stop interrupts. */
const WORKING: ReadonlySet<SessionStatus> = new Set([
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
]);

type TestChat = { workspaceId: string; sessionId: string };

/**
 * The test chat's status and its events after `after` (oldest first),
 * through the test chat routes: test chats are yours alone, and nobody is a
 * member of the test workspace. Each poll reads only what is new.
 */
export async function loadTestChat(
  api: OrgAgentsApi,
  agentId: string,
  chat: TestChat,
  options: { after?: number; signal?: AbortSignal } = {},
): Promise<{
  events: SessionEvent[];
  status: SessionStatus | null;
  paused: boolean;
  nextAfter: number;
  hasMore: boolean;
}> {
  const { signal } = options;
  const after = options.after ?? 0;
  const [session, page] = await Promise.all([
    api.getTestChat(agentId, chat.sessionId, signal),
    api.listTestChatEvents(agentId, chat.sessionId, {
      after,
      limit: PAGE_SIZE,
      ...(signal ? { signal } : {}),
    }),
  ]);
  return {
    events: page.events,
    status: session.status,
    paused: session.paused === true,
    nextAfter: page.nextAfter ?? after,
    hasMore: page.hasMore,
  };
}

/** `events` with `more` appended, each event once. */
export function appendEvents(events: SessionEvent[], more: SessionEvent[]): SessionEvent[] {
  if (more.length === 0) return events;
  const seen = new Set(events.map((event) => event.id));
  const fresh = more.filter((event) => !seen.has(event.id));
  return fresh.length === 0 ? events : [...events, ...fresh];
}

/** Per-user servers the agent uses: each takes an optional pasted test token. */
export function perUserServers(
  agent: OrgAgent,
  toolServers: readonly OrgToolServer[] | null,
): OrgToolServer[] {
  const version = agent.draft ?? agent.published;
  const keys = new Set(version?.config.toolServers.map((server) => server.server) ?? []);
  return (toolServers ?? []).filter(
    (server) => server.authMode === "per_user" && keys.has(server.key),
  );
}

export function AgentTestChat({
  agent,
  api,
  toolServers,
  unsaved,
}: {
  agent: OrgAgent;
  api: OrgAgentsApi;
  toolServers: readonly OrgToolServer[] | null;
  /** The Settings tab has changes that aren't saved yet. */
  unsaved: boolean;
}) {
  const [message, setMessage] = useState("");
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<TestChat | null>(null);
  const [starting, setStarting] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  // One key per start, so a double click or retry starts one chat.
  const startKey = useRef<string | null>(null);
  const servers = perUserServers(agent, toolServers);
  const version = agent.latestVersion;
  const approvals = useMemo(() => projectPendingApprovals(events), [events]);

  useEffect(() => {
    if (!chat) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let after = 0;
    const tick = () => {
      loadTestChat(api, agent.id, chat, { after, signal: controller.signal }).then(
        (result) => {
          if (controller.signal.aborted) return;
          after = result.nextAfter;
          setEvents((current) => appendEvents(current, result.events));
          setStatus(result.status);
          setPaused(result.paused);
          setLoadError(null);
          // A long chat catches up page by page, then polls.
          timer = setTimeout(tick, result.hasMore ? 0 : POLL_MS);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setLoadError(error);
          timer = setTimeout(tick, POLL_MS * 3);
        },
      );
    };
    tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [chat, api, agent.id]);

  const toolLogins = Object.fromEntries(
    Object.entries(tokens)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );

  const start = async () => {
    const text = message.trim();
    if (!text) return;
    if (starting) return;
    setStarting(true);
    startKey.current ??= crypto.randomUUID();
    try {
      await api.ensureTestWorkspace();
      const started = await api.startTestChat(agent.id, {
        version,
        message: text,
        idempotencyKey: startKey.current,
        ...(Object.keys(toolLogins).length > 0 ? { toolLogins } : {}),
      });
      startKey.current = null;
      setEvents([]);
      setStatus(null);
      setPaused(false);
      setChat(started);
      setMessage("");
    } catch (error) {
      toast.error("Couldn't start the test chat", { description: userErrorText(error) });
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const text = message.trim();
    if (!chat || !text) return;
    setStarting(true);
    try {
      await api.sendTestChatMessage(agent.id, chat.sessionId, { message: text });
      setMessage("");
    } catch (error) {
      toast.error("Couldn't send the message", { description: userErrorText(error) });
    } finally {
      setStarting(false);
    }
  };

  const decide = async (
    approvalId: string,
    decision: "approve" | "reject",
    answer?: Parameters<ApprovalSurfaceProps["onApprove"]>[1],
  ) => {
    if (!chat) return;
    try {
      await api.decideTestChatApproval(agent.id, chat.sessionId, approvalId, {
        decision,
        ...answer,
      });
    } catch (error) {
      toast.error("Couldn't submit the decision", { description: userErrorText(error) });
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  const control = async (action: "pause" | "resume") => {
    if (!chat) return;
    setControlling(true);
    try {
      const result = await api.controlTestChat(agent.id, chat.sessionId, {
        action,
        clientEventId: crypto.randomUUID(),
      });
      setPaused(result.paused);
    } catch (error) {
      toast.error(action === "pause" ? "Couldn't stop the chat" : "Couldn't resume the chat", {
        description: userErrorText(error),
      });
    } finally {
      setControlling(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 py-8">
      {unsaved ? <Notice tone="waiting">Save draft to test your latest changes.</Notice> : null}
      {chat ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="m-0 text-sm text-fg-muted">
              Testing v{version} in your test workspace. Only you can see this chat.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChat(null);
                setEvents([]);
                setPaused(false);
              }}
            >
              <RotateCcwIcon aria-hidden="true" />
              New test chat
            </Button>
          </div>
          {loadError ? (
            <Notice tone="failed">Couldn't load the chat: {userErrorText(loadError)}</Notice>
          ) : null}
          <div className="h-[480px] overflow-hidden rounded-[12px] border border-border">
            <MessageTimeline events={events} status={status} className="h-full" />
          </div>
          {approvals.length > 0 && approvalsDecidable(status) ? (
            <ApprovalSurface
              approvals={approvals}
              onApprove={(approval, answer) => decide(approval.id, "approve", answer)}
              onReject={(approval) => decide(approval.id, "reject")}
            />
          ) : null}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <TextArea
              aria-label="Message"
              className="min-w-0 flex-1"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            {paused ? (
              <Button
                type="button"
                variant="secondary"
                disabled={controlling}
                onClick={() => void control("resume")}
              >
                <PlayIcon aria-hidden="true" />
                Resume
              </Button>
            ) : status && WORKING.has(status) ? (
              <Button
                type="button"
                variant="secondary"
                disabled={controlling}
                onClick={() => void control("pause")}
              >
                <PauseIcon aria-hidden="true" />
                Stop
              </Button>
            ) : null}
            <Button type="submit" disabled={starting || !message.trim()}>
              <SendIcon aria-hidden="true" />
              Send
            </Button>
          </form>
        </>
      ) : (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <FieldStack>
            <Field
              label="Message"
              hint={`Runs v${version}${agent.draft ? " (draft)" : ""} in your test workspace.`}
            >
              <TextArea
                rows={3}
                value={message}
                onChange={(event) => {
                  // A different start is a new chat.
                  startKey.current = null;
                  setMessage(event.target.value);
                }}
              />
            </Field>
            {servers.map((server) => (
              <Field
                key={server.key}
                label={`Test token for ${server.name}`}
                optional
                hint="Used only by this test chat. Without one, its tools are unavailable."
              >
                <TextInput
                  type="password"
                  autoComplete="off"
                  value={tokens[server.key] ?? ""}
                  onChange={(event) =>
                    setTokens((current) => ({ ...current, [server.key]: event.target.value }))
                  }
                />
              </Field>
            ))}
          </FieldStack>
          <div>
            <Button type="submit" disabled={starting || !message.trim()}>
              {starting ? "Starting…" : "Start test chat"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
