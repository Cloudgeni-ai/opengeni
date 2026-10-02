import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { Session } from "@/types";

import { SessionHeader } from "./session-header";

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
      onOpenSchedule={
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
    const button = container.querySelector<HTMLButtonElement>(
      'button[title="Open schedules for this session"]',
    );
    expect(button?.textContent?.trim()).toBe("Schedule");
    await act(async () => button?.click());
    expect(opened).toBe(1);
    await act(async () => root.render(render(false)));
    expect(container.querySelector('button[title="Open schedules for this session"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("phones keep a compact lifecycle indicator instead of hiding status", async () => {
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
      ["waiting_capacity", "Waiting"],
    ] as const) {
      await act(async () => root.render(render(session, status)));
      expect(compact()?.dataset.compactSessionStatus).toBe(status);
      expect(compact()?.textContent).toBe(label);
      expect(compact()?.className).toContain("md:hidden");
    }
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
    expect(container.querySelector(".sr-only.md\\:hidden")?.textContent).toBe("Connection live.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
