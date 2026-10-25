import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";

import { AppContext, type AppContextValue } from "../../app-context";
import type { Session } from "../../types";

import { SessionHeader } from "./session-header";

// The header only renders inside the session shell, which always has the app
// context; its chat actions (copy link, pin) run through it. None of these
// tests run one, so any read of the context fails loudly.
const appContext = new Proxy({} as AppContextValue, {
  get(_target, key) {
    throw new Error(`The SessionHeader test's app context has no ${String(key)}`);
  },
});

function createRoot(container: Element) {
  const root = createReactRoot(container);
  return {
    render: (node: ReactNode) =>
      root.render(<AppContext.Provider value={appContext}>{node}</AppContext.Provider>),
    unmount: () => root.unmount(),
  };
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  initialMessage: "Run this exact bash script once in the workspace root.",
  title: null,
  titleSource: null,
  parentSessionId: null,
  model: "codex/gpt-5.6-sol",
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as Session;

describe("SessionHeader mobile touch targets", () => {
  test("keeps the editable session title at least 44px high on coarse pointers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <SessionHeader
            session={session}
            ancestors={[]}
            connectionState="live"
            status="idle"
            keyAuthRequired={false}
            onForgetAccessKey={() => undefined}
            inspectorOpen={false}
            onToggleInspector={() => undefined}
            onRename={async () => null}
            onPin={async () => null}
          />,
        );
      });

      const title = container.querySelector<HTMLButtonElement>(
        'button[title$="· click to rename"]',
      );
      expect(title).not.toBeNull();
      expect(title!.className).toContain("pointer-coarse:min-h-11");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("renders access beside the title actions and names workspace open/hide state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (inspectorOpen: boolean) => (
      <SessionHeader
        session={session}
        ancestors={[]}
        connectionState="live"
        status="idle"
        keyAuthRequired={false}
        onForgetAccessKey={() => undefined}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => undefined}
        onRename={async () => null}
        onPin={async () => null}
        accessSlot={<span data-testid="session-access-slot">Private</span>}
      />
    );

    try {
      await act(async () => root.render(render(false)));
      const access = container.querySelector('[data-testid="session-access-slot"]');
      const title = container.querySelector('button[title$="· click to rename"]');
      expect(access).not.toBeNull();
      expect(title).not.toBeNull();
      expect(access?.parentElement?.contains(title ?? null)).toBe(true);
      expect(container.querySelector('[aria-label="Open workspace"]')).not.toBeNull();
      await act(async () => root.render(render(true)));
      expect(container.querySelector('[aria-label="Hide workspace"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("reuses the compact Schedule button without requiring creation metadata", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let opened = 0;
  const render = (linked: boolean) => (
    <SessionHeader
      session={{ ...session, hasSchedules: linked }}
      ancestors={[]}
      connectionState="live"
      status="idle"
      keyAuthRequired={false}
      onForgetAccessKey={() => undefined}
      inspectorOpen={false}
      onToggleInspector={() => undefined}
      onRename={async () => null}
      onPin={async () => null}
      onOpenAutomations={
        linked
          ? () => {
              opened++;
            }
          : null
      }
    />
  );
  try {
    await act(async () => root.render(render(true)));
    const button = container.querySelector<HTMLButtonElement>("button[data-automation-wait]");
    expect(button?.getAttribute("data-automation-wait")).toBe("schedule");
    expect(button?.title).toBe("On a schedule. Open this chat's automations.");
    expect(button?.textContent?.trim()).toBe("On a schedule");
    await act(async () => button?.click());
    expect(opened).toBe(1);
    await act(async () => root.render(render(false)));
    expect(container.querySelector("button[data-automation-wait]")).toBeNull();
    // A paused or finished automation still links to its settings, marked inactive.
    await act(async () =>
      root.render(
        <SessionHeader
          session={{ ...session, hasSchedules: true, hasUpcomingSchedules: false }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          onOpenAutomations={() => {
            opened++;
          }}
        />,
      ),
    );
    const inactive = container.querySelector<HTMLButtonElement>(
      'button[data-automation-wait="none"]',
    );
    expect(inactive?.title).toBe("Nothing upcoming. Open this chat's automations.");
    expect(inactive?.textContent?.trim()).toBe("Automation");
    expect(inactive?.querySelector("svg")?.getAttribute("class")).toContain("lucide-zap-off");
    await act(async () => inactive?.click());
    expect(opened).toBe(2);
    // An automation an event can still wake says so.
    await act(async () =>
      root.render(
        <SessionHeader
          session={{ ...session, hasSchedules: true, waitingForEvents: true }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          onOpenAutomations={() => undefined}
        />,
      ),
    );
    const listening = container.querySelector<HTMLButtonElement>(
      'button[data-automation-wait="event"]',
    );
    expect(listening?.title).toBe("Waiting for an event. Open this chat's automations.");
    expect(listening?.textContent?.trim()).toBe("Waiting on an event");
    expect(listening?.querySelector("svg")?.getAttribute("class")).toContain("lucide-zap");
    // With the details, the pill names the source and its tooltip the event.
    await act(async () =>
      root.render(
        <SessionHeader
          session={{
            ...session,
            hasSchedules: true,
            waitingForEvents: true,
            automationWait: {
              nextRunAt: null,
              event: {
                source: { kind: "github", name: "GitHub" },
                eventTypes: ["check_suite.completed"],
              },
              automations: 1,
            },
          }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          onOpenAutomations={() => undefined}
        />,
      ),
    );
    const detailed = container.querySelector<HTMLButtonElement>(
      'button[data-automation-wait="event"]',
    );
    expect(detailed?.title).toBe(
      "Waiting for check_suite.completed from GitHub. Open this chat's automations.",
    );
    expect(detailed?.textContent?.trim()).toBe("Waiting on GitHub");
    // Two automations on two apps: the pill names both, not only the first.
    const checks = {
      source: { kind: "github" as const, name: "GitHub" },
      eventTypes: ["check_suite.completed"],
    };
    const mail = {
      source: { kind: "gmail" as const, name: "Gmail" },
      eventTypes: ["message.received"],
    };
    await act(async () =>
      root.render(
        <SessionHeader
          session={{
            ...session,
            hasSchedules: true,
            waitingForEvents: true,
            automationWait: {
              nextRunAt: null,
              event: checks,
              events: [checks, mail],
              automations: 2,
            },
          }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          onOpenAutomations={() => undefined}
        />,
      ),
    );
    const both = container.querySelector<HTMLButtonElement>('button[data-automation-wait="event"]');
    expect(both?.title).toBe(
      "Waiting for check_suite.completed from GitHub or message.received from Gmail. Open this chat's automations.",
    );
    expect(both?.textContent?.trim()).toBe("Waiting on GitHub and Gmail");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("narrow headers keep a compact lifecycle dot instead of hiding status", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (value: Session, status: Session["status"]) => (
    <SessionHeader
      session={value}
      ancestors={[]}
      connectionState="live"
      status={status}
      keyAuthRequired={false}
      onForgetAccessKey={() => undefined}
      inspectorOpen={false}
      onToggleInspector={() => undefined}
      onRename={async () => null}
      onPin={async () => null}
    />
  );
  const compact = () => container.querySelector<HTMLElement>("[data-compact-session-status]");
  try {
    for (const [status, label] of [
      ["running", "Running"],
      ["failed", "Failed"],
      ["requires_action", "Waiting on you"],
      ["waiting_capacity", "Limit reached"],
    ] as const) {
      await act(async () => root.render(render(session, status)));
      expect(compact()?.dataset.compactSessionStatus).toBe(status);
      expect(compact()?.textContent).toBe(label);
      expect(compact()?.className).toContain("lg:hidden");
    }
    // A session the runtime could not start is stuck, not waiting on you.
    await act(async () =>
      root.render(
        render(
          {
            ...session,
            admissionBlock: {
              reason: "database_claim_rejected",
              sqlState: "42501",
              retryPolicy: "explicit_recheck",
              blockedAt: "2026-09-25T12:00:00.000Z",
            },
          } as Session,
          "requires_action",
        ),
      ),
    );
    expect(compact()?.dataset.compactSessionStatus).toBe("blocked");
    expect(compact()?.textContent).toBe("Stuck");
    expect(container.textContent).not.toContain("Waiting on you");
    await act(async () =>
      root.render(
        render(
          {
            ...session,
            inputWait: { deadlineAt: "2026-09-25T12:00:00.000Z", reason: "Waiting for CI" },
          } as Session,
          "idle",
        ),
      ),
    );
    expect(compact()?.textContent).toBe("Waiting");
    // Only the desktop badge carries the wait marker, so selectors stay unique.
    expect(container.querySelectorAll("[data-session-wait-badge]")).toHaveLength(1);
    await act(async () =>
      root.render(
        render(
          {
            ...session,
            effectiveControl: {
              ...session.effectiveControl,
              state: "paused",
              directState: "paused",
            },
          } as Session,
          "idle",
        ),
      ),
    );
    expect(compact()?.textContent).toBe("Paused");
    expect(container.querySelector(".sr-only.lg\\:hidden")?.textContent).toBe("Connection live.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("names the model cleanly for org- and workspace-connected copies alike", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (model: string) => (
    <SessionHeader
      session={{ ...session, model }}
      ancestors={[]}
      connectionState="live"
      status="idle"
      keyAuthRequired={false}
      onForgetAccessKey={() => undefined}
      inspectorOpen={false}
      onToggleInspector={() => undefined}
      onRename={async () => null}
      onPin={async () => null}
      billingClass="claude_subscription"
    />
  );
  try {
    const seen: string[] = [];
    for (const model of [
      "organization-claude-subscription/claude-opus-5-5",
      "workspace-claude-subscription/claude-opus-5-5",
    ]) {
      await act(async () => root.render(render(model)));
      const text = container.querySelector("header")?.textContent ?? "";
      expect(text).toContain("Opus 5.5");
      expect(text).not.toContain("claude-subscription");
      const mark = container.querySelector(
        '[data-testid="billing-class-icon-claude_subscription"]',
      );
      expect(mark).not.toBeNull();
      seen.push(mark?.parentElement?.textContent ?? "");
    }
    expect(seen[0]).toBe(seen[1]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

// Bendik's report: a Claude chat showed a static Claude logo where a Codex chat
// shows its account control. Every subscription rail gets the same control.
test.each([
  ["codex_subscription", "codex/gpt-6-astra"],
  ["claude_subscription", "organization-claude-subscription/claude-opus-5-5"],
  ["supergrok_subscription", "supergrok/grok-4.6"],
] as const)("the %s header shows the account control", async (billingClass, model) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SessionHeader
          session={{ ...session, model }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          billingClass={billingClass}
          accountSlot={<button type="button" data-testid="account-control" />}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="account-control"]')).not.toBeNull();
    expect(container.querySelector("[data-model-vendor]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("other payment rails keep the maker's logo and never show an account control", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SessionHeader
          session={{ ...session, model: "opper/aws/claude-opus-5-5" }}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          billingClass="opengeni_credits"
          accountSlot={<button type="button" data-testid="account-control" />}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="account-control"]')).toBeNull();
    expect(container.querySelector('[data-model-vendor="anthropic"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
