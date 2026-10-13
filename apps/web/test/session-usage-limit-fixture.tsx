// Per-task usage limits: production components and styles with
// synthetic tasks, amounts and a scripted client. No API, no database.
import {
  ChatComposer,
  conversationTimeline,
  isSessionUsageLimitSubmissionError,
  MessageTimeline,
  OpenGeniProvider,
  useComposer,
} from "@opengeni/react";
import { SessionUsageLimitNotice } from "@opengeni/react/usage";
import { OpenGeniApiError, OpenGeniSessionUsageLimitReachedError } from "@opengeni/sdk/browser";
import type { SessionUsageLimit } from "@opengeni/sdk/session-usage-limits";
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { MockOpenGeniClient } from "../../../packages/react/demo/mock";
import { ComposerMobilePlus } from "../src/components/composer-mobile-plus";
import { SessionHeader } from "../src/components/rail/session-header";
import { UsageLimitMenuBody } from "../src/components/session/new-session-settings-menu";
import { SessionUsageLimitSection } from "../src/components/session/session-usage-limit-section";
import { Toaster } from "../src/components/ui/sonner";
import { TooltipProvider } from "../src/components/ui/tooltip";
import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryToolSelection,
  galleryToolServers,
  idleComposer,
} from "../src/dev/composer-chrome-fixtures";
import { buildCreateSessionRequest } from "../src/lib/session-create";
import {
  NO_SESSION_USAGE_LIMIT,
  OPEN_SESSION_USAGE_LIMIT_EVENT,
  parseSessionUsageLimitDraft,
  requestSessionUsageLimitEditor,
  sessionUsageLimitDraftSummary,
  usageLimitRefusalFromState,
  useSessionUsageLimit,
  type SessionUsageLimitDraft,
} from "../src/lib/session-usage-limit";
import type { Session, SessionEvent } from "../src/types";
import { ScenarioProvider } from "./session-usage-limit-context";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const ids = {
  main: "00000000-0000-4000-8000-000000000101",
  partial: "00000000-0000-4000-8000-000000000102",
  reached: "00000000-0000-4000-8000-000000000103",
  preparing: "00000000-0000-4000-8000-000000000104",
  unavailable: "00000000-0000-4000-8000-000000000105",
  childRoot: "00000000-0000-4000-8000-000000000106",
  child: "00000000-0000-4000-8000-000000000107",
  forbidden: "00000000-0000-4000-8000-000000000108",
  disabled: "00000000-0000-4000-8000-000000000109",
  refused: "00000000-0000-4000-8000-000000000110",
} as const;
type ScenarioName = keyof typeof ids;

/** What the browser test reads and steers. */
const qa = {
  creates: [] as unknown[],
  blockedSends: 0,
  saves: [] as Array<{
    scenario: ScenarioName;
    limitMicros: number | null;
    expectedVersion: number;
  }>,
  reads: {} as Partial<Record<ScenarioName, number>>,
  failNext: {} as Partial<Record<ScenarioName, string>>,
  saveDelayMs: 150,
  sends: 0,
};
(window as unknown as { usageQa: typeof qa }).usageQa = qa;

function usage(
  rootSessionId: string,
  overrides: Partial<SessionUsageLimit> = {},
): SessionUsageLimit {
  return {
    basis: "model_api_equivalent_v1",
    rootSessionId,
    inherited: false,
    status: "within",
    limitMicros: 50_000_000,
    usedMicros: 12_340_000,
    version: 3,
    usageRevision: 7,
    history: "complete",
    coverage: "complete",
    pricedCalls: 14,
    freeCalls: 0,
    unpricedCalls: 0,
    updatedAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function apiError(status: number, code: string, detailsCode: string, message: string) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({ error: { code, message, details: { code: detailsCode } } }),
    { mutation: true },
  );
}

/** A scripted server for one task: reads, compare-and-set writes, typed failures. */
function scenarioClient(name: ScenarioName, initial: SessionUsageLimit) {
  let current = initial;
  return {
    getSessionUsageLimit: async () => {
      qa.reads[name] = (qa.reads[name] ?? 0) + 1;
      await delay(60);
      return current;
    },
    setSessionUsageLimit: async (
      _workspaceId: string,
      _sessionId: string,
      request: { limitMicros: number | null; expectedVersion: number; operationId: string },
    ) => {
      qa.saves.push({
        scenario: name,
        limitMicros: request.limitMicros,
        expectedVersion: request.expectedVersion,
      });
      await delay(qa.saveDelayMs);
      const failure = qa.failNext[name];
      delete qa.failNext[name];
      if (failure === "conflict") {
        // Someone else saved $40 meanwhile.
        current = { ...current, limitMicros: 40_000_000, version: current.version + 1 };
        throw apiError(409, "conflict", "session_usage_limit_conflict", "Version changed");
      }
      if (failure === "unavailable") {
        throw apiError(503, "unavailable", "session_usage_limit_unavailable", "Unavailable");
      }
      if (failure === "forbidden") {
        throw apiError(403, "forbidden", "session_usage_limit_forbidden", "Forbidden");
      }
      if (current.status === "preparing" && request.limitMicros !== null) {
        throw apiError(409, "conflict", "session_usage_limit_preparing", "Preparing");
      }
      if (request.expectedVersion !== current.version) {
        throw apiError(409, "conflict", "session_usage_limit_conflict", "Version changed");
      }
      const used = current.usedMicros;
      current = {
        ...current,
        limitMicros: request.limitMicros,
        version: current.version + 1,
        status:
          current.status === "preparing" || current.status === "unavailable"
            ? current.status
            : request.limitMicros === null
              ? "unlimited"
              : used !== null && used >= request.limitMicros
                ? "reached"
                : "within",
      };
      return current;
    },
  };
}

function grants(control: boolean) {
  return {
    subjectId: "user:sample",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId,
        permissions: control ? ["sessions:read", "sessions:control"] : ["sessions:read"],
      },
    ],
  };
}

function scenarioContext(input: { client: unknown; control?: boolean; enabled?: boolean }) {
  return {
    client: input.client,
    accessContext: grants(input.control ?? true),
    clientConfig: { sessionUsageLimits: { enabled: input.enabled ?? true } },
  };
}

function session(id: string, title: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId,
    title,
    initialMessage: title,
    metadata: {},
    status: "idle",
    model: "preview/model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    parentSessionId: null,
    effectiveControl: {
      state: "active",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
    },
    ...overrides,
  } as unknown as Session;
}

/* ---------------------------------------------------------------------------
   Layout helpers: the session dock's Agent tab section markup.
   ------------------------------------------------------------------------- */

function AgentTab(props: { testId: string; caption: string; children: ReactNode }) {
  const headingId = `${props.testId}-usage`;
  const captionId = `${props.testId}-caption`;
  return (
    <div
      data-testid={props.testId}
      className="flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-bg p-4"
    >
      <p id={captionId} className="text-xs text-fg-muted">
        {props.caption}
      </p>
      {/* Several Agent tabs share this page: name each region uniquely. */}
      <section
        aria-labelledby={`${headingId} ${captionId}`}
        data-agent-section="Usage"
        className="flex min-w-0 flex-col gap-3"
      >
        <h3 id={headingId} className="text-sm leading-5 font-medium text-fg">
          Usage
        </h3>
        {props.children}
      </section>
    </div>
  );
}

function Scenario(props: {
  name: ScenarioName;
  caption: string;
  initial: SessionUsageLimit;
  session?: Partial<Session>;
  control?: boolean;
  enabled?: boolean;
}) {
  const [value] = useState(() =>
    scenarioContext({
      client: scenarioClient(props.name, props.initial),
      control: props.control,
      enabled: props.enabled,
    }),
  );
  const [task] = useState(() =>
    session(ids[props.name], props.caption, { usageLimit: props.initial, ...props.session }),
  );
  return (
    <ScenarioProvider value={value}>
      <AgentTab testId={`scenario-${props.name}`} caption={props.caption}>
        <SessionUsageLimitSection session={task} />
      </AgentTab>
    </ScenarioProvider>
  );
}

/* ---------------------------------------------------------------------------
   New chat: "+" > Usage limit, and the create request it sends.
   ------------------------------------------------------------------------- */

function NewChat() {
  const [message, setMessage] = useState("Audit the billing service and fix the flaky tests.");
  const [draft, setDraft] = useState<SessionUsageLimitDraft>(NO_SESSION_USAGE_LIMIT);
  const [blocked, setBlocked] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // Mirrors the new-chat route: an invalid amount blocks Send; a valid one is
  // sent as usageLimitMicros; the setting resets after the chat is created.
  const send = async () => {
    const parsed = parseSessionUsageLimitDraft(draft);
    if (!parsed.ok) {
      qa.blockedSends += 1;
      setBlocked(true);
      return false;
    }
    const request = buildCreateSessionRequest({
      currentResources: [],
      submission: { text: message },
      selectedTools: [],
      defaultModel: "preview/model",
      defaultReasoningEffort: "medium",
      defaultLatencyMode: "standard",
      clientEventId: `event-${qa.creates.length + 1}`,
      idempotencyKey: `create-${qa.creates.length + 1}`,
      usageLimitMicros: parsed.limitMicros,
    });
    qa.creates.push(request);
    setSent(sessionUsageLimitDraftSummary(draft));
    setDraft(NO_SESSION_USAGE_LIMIT);
    setBlocked(false);
    setMessage("");
    return true;
  };
  return (
    <div data-testid="new-chat" className="flex w-full min-w-0 flex-col gap-3">
      <ChatComposer
        responsiveBasis="container"
        composer={idleComposer({
          value: message,
          setValue: setMessage,
          hasDraftContent: () => message.length > 0,
          canSend: message.trim().length > 0,
          send,
        })}
        attachments={emptyAttachments()}
        attachButtonClassName="hidden"
        placeholder="Ask anything"
        controlsLeading={
          <ComposerMobilePlus
            menuSide="bottom"
            fileUploadsEnabled
            servers={galleryToolServers}
            firstPartyTools={galleryFirstPartyTools}
            selection={galleryToolSelection}
            onToolSelectionChange={() => {}}
            usageLimit={{
              summary: sessionUsageLimitDraftSummary(draft),
              panel: (
                <UsageLimitMenuBody
                  value={draft}
                  disabled={false}
                  showRequiredError={blocked}
                  onChange={setDraft}
                />
              ),
            }}
          />
        }
      />
      <p data-testid="new-chat-result" className="text-xs text-fg-muted" aria-live="polite">
        {sent ? `Sample chat created · usage limit ${sent}` : "\u00a0"}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   An open chat: header overflow menu > Usage limit opens the Agent tab editor.
   ------------------------------------------------------------------------- */

function OpenChat() {
  const initial = usage(ids.main);
  const [value] = useState(() => scenarioContext({ client: scenarioClient("main", initial) }));
  const [task] = useState(() =>
    session(ids.main, "Migrate the billing service to the new queue", { usageLimit: initial }),
  );
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    const open = () => setFocusRequest((current) => current + 1);
    document.addEventListener(OPEN_SESSION_USAGE_LIMIT_EVENT, open);
    return () => document.removeEventListener(OPEN_SESSION_USAGE_LIMIT_EVENT, open);
  }, []);
  return (
    <ScenarioProvider value={value}>
      <div data-testid="open-chat" className="flex w-full min-w-0 flex-col gap-4">
        <div className="rounded-md border border-border">
          <SessionHeader
            session={task}
            ancestors={[]}
            connectionState="live"
            status={task.status}
            keyAuthRequired={false}
            onForgetAccessKey={() => undefined}
            inspectorOpen={false}
            onToggleInspector={() => undefined}
            onRename={async () => null}
            onPin={async () => null}
            onOpenUsageLimit={requestSessionUsageLimitEditor}
          />
        </div>
        <AgentTab testId="scenario-main" caption="Agent tab · within the limit">
          <SessionUsageLimitSection session={task} focusRequest={focusRequest} />
        </AgentTab>
      </div>
    </ScenarioProvider>
  );
}

/* ---------------------------------------------------------------------------
   A chat at its limit: the neutral stop in the timeline, the composer notice
   (goal paused), and the Agent tab over the limit.
   ------------------------------------------------------------------------- */

function timelineEvent(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `usage-limit-event-${sequence}`,
    workspaceId,
    sessionId: ids.reached,
    turnId: "turn-1",
    sequence,
    type,
    payload,
    occurredAt: `2026-10-13T08:0${sequence}:00.000Z`,
  } as SessionEvent;
}

const reachedUsage = usage(ids.reached, {
  status: "reached",
  limitMicros: 50_000_000,
  usedMicros: 52_100_000,
  pricedCalls: 61,
});

const reachedEvents = [
  timelineEvent(1, "user.message", { text: "Refactor the invoice exporter and add tests." }),
  timelineEvent(2, "turn.started", {}),
  timelineEvent(3, "agent.message.completed", {
    messageId: "m1",
    text: "I split the exporter into a formatter and a writer and added tests for both.",
  }),
  timelineEvent(4, "turn.completed", {
    output: "",
    segmentLimit: "session_usage_limit",
    sessionUsageLimit: {
      code: "session_usage_limit_reached",
      basis: "model_api_equivalent_v1",
      rootSessionId: ids.reached,
      limitMicros: 50_000_000,
      usedMicros: 52_100_000,
      message: "This task's usage limit is reached.",
    },
  }),
];

function ReachedChat() {
  const [value] = useState(() =>
    scenarioContext({ client: scenarioClient("reached", reachedUsage) }),
  );
  const [task] = useState(() =>
    session(ids.reached, "Refactor the invoice exporter", { usageLimit: reachedUsage }),
  );
  const live = useSessionUsageLimit({
    client: value.client as never,
    workspaceId,
    sessionId: ids.reached,
    initial: reachedUsage,
    enabled: true,
  });
  const [focusRequest, setFocusRequest] = useState(0);
  return (
    <ScenarioProvider value={value}>
      <div className="grid w-full min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div
          data-testid="reached-chat"
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-bg p-3"
        >
          <div className="h-72 min-h-0">
            <MessageTimeline className="h-full" events={reachedEvents} />
          </div>
          <ChatComposer
            responsiveBasis="container"
            composer={idleComposer({ value: "", canSend: false })}
            attachments={emptyAttachments()}
            attachButtonClassName="hidden"
            placeholder="Message"
            header={
              <SessionUsageLimitNotice
                usage={live.usage}
                goalPaused
                onChangeLimit={() => setFocusRequest((current) => current + 1)}
                dismissStorageKey={`opengeni:${workspaceId}`}
              />
            }
          />
        </div>
        <AgentTab testId="scenario-reached" caption="Agent tab · over the limit">
          <SessionUsageLimitSection session={task} focusRequest={focusRequest} goalPausedAtLimit />
        </AgentTab>
      </div>
    </ScenarioProvider>
  );
}

/* ---------------------------------------------------------------------------
   A refused Send: the real composer against a client that answers 402.
   ------------------------------------------------------------------------- */

const refusedInitial = usage(ids.refused, { usedMicros: 49_100_000, pricedCalls: 58 });
const refusedClient = new MockOpenGeniClient();
const refusedUsageClient = scenarioClient("refused", refusedInitial);
const reachedAfterRefusal = {
  ...refusedInitial,
  status: "reached" as const,
  usedMicros: 50_400_000,
};
refusedClient.sendMessage = async () => {
  qa.sends += 1;
  await delay(80);
  // The server's answer moves the projection to reached as well.
  refusedUsageClient.getSessionUsageLimit = async () => {
    qa.reads.refused = (qa.reads.refused ?? 0) + 1;
    await delay(60);
    return reachedAfterRefusal;
  };
  throw new OpenGeniSessionUsageLimitReachedError(
    402,
    JSON.stringify({
      error: {
        code: "session_usage_limit_reached",
        message: "This task's usage limit is reached.",
        details: {
          basis: "model_api_equivalent_v1",
          rootSessionId: ids.refused,
          limitMicros: 50_000_000,
          usedMicros: 50_400_000,
        },
      },
    }),
  );
};

function RefusedSendInner() {
  const composer = useComposer(ids.refused, {
    draftPersistence: "disabled",
    initialPolicy: { model: "preview/model", reasoningEffort: "medium", latencyMode: "standard" },
  });
  const live = useSessionUsageLimit({
    client: refusedUsageClient as never,
    workspaceId,
    sessionId: ids.refused,
    initial: refusedInitial,
    enabled: true,
  });
  // As the chat route: a failed bubble refused at the limit, or a typed error.
  const refusedIds = (composer.optimisticMessages ?? [])
    .filter(
      (message) =>
        message.state === "failed" &&
        message.error !== undefined &&
        isSessionUsageLimitSubmissionError(new Error(message.error)),
    )
    .map((message) => message.clientEventId)
    .join(",");
  const error =
    composer.error instanceof OpenGeniSessionUsageLimitReachedError ? composer.error : null;
  const [pending, setPending] = useState(false);
  const refresh = live.refresh;
  useEffect(() => {
    if (!refusedIds && !error) return;
    setPending(true);
    void refresh().finally(() => setPending(false));
  }, [error, refresh, refusedIds]);
  const refusal = usageLimitRefusalFromState({ pending, error, usage: live.usage });
  return (
    <div
      data-testid="refused-send"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-bg p-3"
    >
      <div className="h-64 min-h-0">
        <MessageTimeline
          className="h-full"
          items={conversationTimeline([], { queue: [], snapshot: null }, composer)}
        />
      </div>
      <ChatComposer
        responsiveBasis="container"
        composer={composer}
        attachButtonClassName="hidden"
        placeholder="Message"
        header={
          <SessionUsageLimitNotice
            usage={live.usage}
            refusal={refusal}
            onChangeLimit={() => undefined}
          />
        }
      />
    </div>
  );
}

function RefusedSend() {
  return (
    <OpenGeniProvider client={refusedClient} workspaceId={workspaceId}>
      <RefusedSendInner />
    </OpenGeniProvider>
  );
}

/* ---------------------------------------------------------------------------
   Page.
   ------------------------------------------------------------------------- */

function Group(props: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-medium text-fg">{props.title}</h2>
      <div className={props.className ?? "flex min-w-0 flex-col gap-4"}>{props.children}</div>
    </section>
  );
}

function Page() {
  return (
    <TooltipProvider>
      <main className="min-h-screen bg-bg p-4 text-fg sm:p-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="text-base font-semibold">Usage limits</h1>
            <span
              data-testid="sample-data"
              className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted"
            >
              Sample data
            </span>
          </header>
          <Group title="New chat" className="max-w-xl">
            <NewChat />
          </Group>
          <Group title="Open chat" className="max-w-3xl">
            <OpenChat />
          </Group>
          <Group title="Chat at its limit">
            <ReachedChat />
          </Group>
          <Group title="Message sent at the limit" className="max-w-3xl">
            <RefusedSend />
          </Group>
          <Group
            title="Agent tab states"
            className="grid min-w-0 gap-4 md:grid-cols-2 lg:grid-cols-3"
          >
            <Scenario
              name="partial"
              caption="Started before usage limits"
              initial={usage(ids.partial, {
                history: "legacy_partial",
                coverage: "partial",
                usedMicros: 8_200_000,
                unpricedCalls: 2,
              })}
            />
            <Scenario
              name="preparing"
              caption="Earlier usage still being counted"
              initial={usage(ids.preparing, {
                status: "preparing",
                limitMicros: null,
                usedMicros: null,
                history: "preparing",
                coverage: "partial",
                version: 0,
              })}
            />
            <Scenario
              name="unavailable"
              caption="Usage can't be read right now"
              initial={usage(ids.unavailable, { status: "unavailable", usedMicros: null })}
            />
            <Scenario
              name="child"
              caption="An agent of a main task"
              initial={usage(ids.childRoot, { inherited: true, usedMicros: 21_700_000 })}
              session={{ parentSessionId: ids.childRoot }}
            />
            <Scenario
              name="forbidden"
              caption="Without permission to run the chat"
              initial={usage(ids.forbidden, { usedMicros: 4_100_000 })}
              control={false}
            />
            <Scenario
              name="disabled"
              caption="New limits turned off by the server"
              initial={usage(ids.disabled, { limitMicros: 30_000_000, usedMicros: 9_800_000 })}
              enabled={false}
            />
          </Group>
        </div>
      </main>
      <Toaster />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
