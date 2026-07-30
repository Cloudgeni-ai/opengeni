import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  SessionToolPicker,
  visibleSessionToolSelection,
  type SessionToolSelection,
} from "@/components/pickers";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const FIRST_PARTY = [
  { id: "session_get" as FirstPartyMcpToolName, name: "Get session" },
  { id: "session_steer" as FirstPartyMcpToolName, name: "Steer session" },
];

describe("unified session tool picker", () => {
  test("shows one durable selection for connected and OpenGeni tools", async () => {
    let latest: SessionToolSelection = {
      mcpServerIds: new Set(["linear"]),
      firstPartyToolIds: new Set(FIRST_PARTY.map((tool) => tool.id)),
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [selection, setSelection] = useState(latest);
      return (
        <SessionToolPicker
          servers={[{ id: "linear", name: "Linear" }]}
          firstPartyTools={FIRST_PARTY}
          selection={selection}
          onChange={(next) => {
            latest = next;
            setSelection(next);
          }}
        />
      );
    }

    try {
      await act(async () => root.render(<Harness />));
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Session tools"]',
      );
      expect(trigger?.textContent).toContain("Tools · All");

      expect(container.querySelectorAll('button[aria-label="Session tools"]')).toHaveLength(1);
      expect(container.textContent).not.toContain("Tools for this turn");
      expect(latest.mcpServerIds).toEqual(new Set(["linear"]));
      expect(latest.firstPartyToolIds).toEqual(new Set(FIRST_PARTY.map((tool) => tool.id)));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("never counts or preserves non-rendered runtime infrastructure", async () => {
    let latest: SessionToolSelection = {
      mcpServerIds: new Set(["docs", "opengeni", "files"]),
      firstPartyToolIds: new Set(FIRST_PARTY.map((tool) => tool.id)),
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [selection, setSelection] = useState(latest);
      return (
        <SessionToolPicker
          servers={[{ id: "docs", name: "Document Search" }]}
          firstPartyTools={FIRST_PARTY}
          selection={selection}
          onChange={(next) => {
            latest = next;
            setSelection(next);
          }}
        />
      );
    }

    try {
      await act(async () => root.render(<Harness />));
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Session tools"]',
      );
      expect(trigger?.textContent).toContain("Tools · All");
      expect(trigger?.textContent).not.toContain("5/3");
      expect(visibleSessionToolSelection(latest, [{ id: "docs" }], FIRST_PARTY)).toEqual({
        mcpServerIds: new Set(["docs"]),
        firstPartyToolIds: new Set(FIRST_PARTY.map((tool) => tool.id)),
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
