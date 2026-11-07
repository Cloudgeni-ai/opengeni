import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { SessionHumanInputRequest, SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { fakeClient, fakeGoal, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom({ clock: "virtual" });

/*
 * `agentSignals={false}` hides how the agent works (goal pill, agents and
 * commands segments) from end users, and keeps everything they act on: the
 * queue, approvals and the agent's questions. An object hides only the
 * switches set to false.
 */

const effectiveControl = {
  state: "active",
  controlVersion: 1,
  controlEtag: "control-1",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
} as const;

const question = {
  id: "request-1",
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  turnId: "turn-1",
  turnGeneration: 1,
  creationAttemptId: "attempt-1",
  toolCallId: "call-question",
  status: "pending",
  questions: [
    {
      id: "colour",
      kind: "text",
      prompt: "Which colour should the kitchen wall be?",
      options: [],
      required: true,
      allowOther: false,
    },
  ],
  allowSkip: true,
  response: null,
  respondedBy: null,
  respondedAt: null,
  expiresAt: null,
  createdAt: "2026-11-05T08:00:00.000Z",
  updatedAt: "2026-11-05T08:00:00.000Z",
} as unknown as SessionHumanInputRequest;

function signalsClient() {
  const goalReads = { count: 0 };
  const snapshot = {
    version: 1,
    effectiveControl,
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [fakeTurn({ prompt: "Also order the tiles" })],
    pendingInputs: [],
    pendingInputAttachment: null,
  } as unknown as SessionQueueSnapshot;
  const client = fakeClient({
    listEvents: async () =>
      [
        {
          id: "33333333-3333-4333-8333-333333333334",
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "session.requiresAction",
          turnId: "44444444-4444-4444-8444-444444444444",
          occurredAt: "2026-11-05T08:00:00Z",
          payload: {
            approvals: [
              {
                rawItem: { callId: "call-1", name: "deploy", arguments: { environment: "test" } },
                name: "deploy",
              },
            ],
          },
        },
      ] as never,
    getSession: async () =>
      ({ id: SESSION_ID, status: "requires_action", effectiveControl }) as never,
    getQueue: async () => snapshot,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [question],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  Object.assign(client, {
    getGoal: async () => {
      goalReads.count++;
      return fakeGoal({ status: "paused", pausedReason: "agent" });
    },
    updateGoal: async () => fakeGoal(),
    deleteGoal: async () => undefined,
  });
  return { client, goalReads };
}

// A host that also shows its agents and commands in the chrome.
const chromeProps = {
  agentsSignal: { count: 2, detail: "Running" },
  agentsPanel: <p>Agent tree</p>,
  commandsCount: 1,
  commandsPanel: <p>Command list</p>,
};

const signal = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-og-session-chrome-signal="${id}"]`);
// Agents and commands sit behind the chrome's Activity button.
const activity = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('button[aria-label="Session activity"]');

test("by default the conversation shows the goal, agents and commands signals", async () => {
  const { client, goalReads } = signalsClient();
  const view = await renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      chromeProps={chromeProps}
    />,
  );
  try {
    await flush(200);
    expect(signal(view.container, "goal")?.textContent).toContain("Paused · agent");
    expect(signal(view.container, "queue")).not.toBeNull();
    expect(goalReads.count).toBeGreaterThan(0);
    await actRun(() => activity(view.container)!.click());
    await flush(50);
    expect(view.container.textContent).toContain("Command list");
  } finally {
    await view.unmount();
  }
});

test("agentSignals={false} hides goal, agents and commands but keeps queue, approvals and questions", async () => {
  const { client, goalReads } = signalsClient();
  const view = await renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      chromeProps={chromeProps}
      agentSignals={false}
    />,
  );
  try {
    await flush(200);
    expect(signal(view.container, "goal")).toBeNull();
    expect(activity(view.container)).toBeNull();
    expect(view.container.textContent).not.toContain("Agent tree");
    expect(view.container.textContent).not.toContain("Command list");
    expect(view.container.textContent).not.toContain("Paused");
    // The goal is not even read.
    expect(goalReads.count).toBe(0);
    // What the person acts on stays.
    expect(signal(view.container, "queue")?.textContent).toContain("1 queued");
    expect(
      [...view.container.querySelectorAll("button")].some(
        (node) => node.textContent === "Approve action",
      ),
    ).toBe(true);
    expect(view.container.textContent).toContain("Which colour should the kitchen wall be?");
  } finally {
    await view.unmount();
  }
});

function mountSignals(agentSignals: ComponentProps<typeof SessionConversation>["agentSignals"]) {
  const { client, goalReads } = signalsClient();
  return renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      chromeProps={chromeProps}
      agentSignals={agentSignals}
    />,
  ).then((view) => ({ view, goalReads }));
}

async function openActivity(root: HTMLElement) {
  await actRun(() => activity(root)!.click());
  await flush(50);
}

test("{ goal: false } hides only the goal pill: queue, agents and commands stay", async () => {
  const { view, goalReads } = await mountSignals({ goal: false });
  try {
    await flush(200);
    expect(signal(view.container, "goal")).toBeNull();
    expect(view.container.textContent).not.toContain("Paused");
    expect(goalReads.count).toBe(0);
    expect(signal(view.container, "queue")?.textContent).toContain("1 queued");
    await openActivity(view.container);
    expect(view.container.textContent).toContain("2 agents");
    expect(view.container.textContent).toContain("Command list");
  } finally {
    await view.unmount();
  }
});

test("{ agents: false } hides only the helper agents", async () => {
  const { view } = await mountSignals({ agents: false });
  try {
    await flush(200);
    expect(signal(view.container, "goal")?.textContent).toContain("Paused · agent");
    await openActivity(view.container);
    expect(view.container.textContent).toContain("Command list");
    expect(view.container.textContent).not.toContain("Agent tree");
    expect(view.container.textContent).not.toContain("2 agents");
  } finally {
    await view.unmount();
  }
});

test("{ commands: false } hides only the running commands", async () => {
  const { view } = await mountSignals({ commands: false });
  try {
    await flush(200);
    expect(signal(view.container, "goal")?.textContent).toContain("Paused · agent");
    await openActivity(view.container);
    expect(view.container.textContent).toContain("2 agents");
    expect(view.container.textContent).not.toContain("Command list");
    expect(view.container.textContent).not.toContain("1 command");
  } finally {
    await view.unmount();
  }
});

test("an object with every switch off matches agentSignals={false}", async () => {
  const { view, goalReads } = await mountSignals({
    goal: false,
    agents: false,
    commands: false,
    turnDetail: false,
  });
  try {
    await flush(200);
    expect(signal(view.container, "goal")).toBeNull();
    expect(activity(view.container)).toBeNull();
    expect(goalReads.count).toBe(0);
    expect(signal(view.container, "queue")?.textContent).toContain("1 queued");
  } finally {
    await view.unmount();
  }
});

/*
 * In a panel wider than the readable column, the session row sits in the
 * composer's column (as approvals and questions do), not at the panel's left.
 */
test("the session row shares the composer's readable column", async () => {
  const columnClasses = (element: Element | null) =>
    ["mx-auto", "max-w-3xl"].filter((name) => element?.classList.contains(name));
  for (const extra of [{}, { className: "og-host-chrome" }]) {
    const { client } = signalsClient();
    const view = await renderComponent(
      <SessionConversation
        sessionId={SESSION_ID}
        client={client}
        workspaceId={WORKSPACE_ID}
        chromeProps={{ ...chromeProps, ...extra }}
      />,
    );
    try {
      await flush(200);
      const row = view.container.querySelector("[data-og-session-chrome]");
      const composer = view.container.querySelector("[data-og-conversation-composer]");
      expect(columnClasses(composer)).toEqual(["mx-auto", "max-w-3xl"]);
      expect(columnClasses(row)).toEqual(columnClasses(composer));
      // A host class still reaches the row.
      if ("className" in extra) expect(row?.classList.contains("og-host-chrome")).toBe(true);
    } finally {
      await view.unmount();
    }
  }
});
