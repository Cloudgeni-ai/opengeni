// An agent's Test tab: a chat on its newest version (the draft) in the
// organization's Console test workspace. Only you can see or continue it, and
// only here (nobody is a member of that workspace). Servers that log in per
// user take a pasted test token, kept only as that chat's own login. The
// conversation is the app's own transcript component.
import type { OrgAgent, OrgToolServer } from "@opengeni/contracts";
import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import { RotateCcwIcon, SendIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { MessageTimeline } from "@opengeni/react/session-ui";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { Notice } from "@opengeni/react/ui/notice";

import type { OrgAgentsApi } from "@/lib/organization-agents";

const POLL_MS = 2_000;

type TestChat = { workspaceId: string; sessionId: string };

/**
 * The test chat's status and events, through the test chat routes: test
 * chats are yours alone, and nobody is a member of the test workspace.
 */
export async function loadTestChat(
  api: OrgAgentsApi,
  agentId: string,
  chat: TestChat,
  signal?: AbortSignal,
): Promise<{ events: SessionEvent[]; status: SessionStatus | null }> {
  const [session, page] = await Promise.all([
    api.getTestChat(agentId, chat.sessionId, signal),
    api.listTestChatEvents(agentId, chat.sessionId, { limit: 1_000, ...(signal ? { signal } : {}) }),
  ]);
  return { events: page.events, status: session.status };
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
  const [loadError, setLoadError] = useState<unknown>(null);
  const servers = perUserServers(agent, toolServers);
  const version = agent.latestVersion;

  useEffect(() => {
    if (!chat) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      loadTestChat(api, agent.id, chat, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setEvents(result.events);
          setStatus(result.status);
          setLoadError(null);
          timer = setTimeout(tick, POLL_MS);
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
    setStarting(true);
    try {
      await api.ensureTestWorkspace();
      const started = await api.startTestChat(agent.id, {
        version,
        message: text,
        ...(Object.keys(toolLogins).length > 0 ? { toolLogins } : {}),
      });
      setEvents([]);
      setStatus(null);
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
                onChange={(event) => setMessage(event.target.value)}
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
