import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { projectPickerRows } from "@opengeni/react";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ModelPicker,
  SessionToolPicker,
  visibleSessionToolSelection,
  type PickerModelRow,
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

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    availability: {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "high", "xhigh"],
        defaultEffort: "low",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true },
      ],
    },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    ...overrides,
  };
}

describe("catalog-backed ModelPicker", () => {
  test("renders selected product model and effort on the trigger", async () => {
    const rows: PickerModelRow[] = projectPickerRows([
      catalogModel({ id: "gpt-5.6-sol", label: "Sol" }),
      catalogModel({
        id: "blocked",
        label: "Blocked",
        availability: {
          status: "unavailable",
          selectable: false,
          reason: "policy_blocked",
          checkedAt: null,
        },
      }),
    ]);
    expect(rows.find((row) => row.id === "blocked")?.selectable).toBe(false);
    expect(rows.find((row) => row.id === "blocked")?.unavailableReason).toBe(
      "Blocked by workspace policy",
    );
    expect(rows.some((row) => row.billingClass === "opengeni_credits")).toBe(true);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ModelPicker
            rows={rows}
            model="gpt-5.6-sol"
            effort="xhigh"
            latencyMode="standard"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />,
        ),
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Model and effort"]',
      );
      expect(trigger?.textContent).toContain("Sol");
      expect(trigger?.textContent).toContain("Extra high");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
