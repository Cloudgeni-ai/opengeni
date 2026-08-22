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
