import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { projectPickerRows } from "@opengeni/react";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ModelPicker,
  ModelPickerMenu,
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
  // Instant page swaps in tests (no slide exit delay).
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as MediaQueryList) as typeof window.matchMedia;
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
      expect(trigger?.textContent).not.toContain("Fast");
      expect(container.querySelector('[data-testid="model-picker-fast-icon"]')).toBeNull();
      expect(
        trigger?.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
      ).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("collapsed Fast uses a lightning icon, not the word Fast", async () => {
    const rows = projectPickerRows([catalogModel({ id: "gpt-5.6-sol", label: "Sol" })]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ModelPicker
            rows={rows}
            model="gpt-5.6-sol"
            effort="low"
            latencyMode="fast"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />,
        ),
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Model and effort"]',
      );
      expect(trigger?.textContent).not.toContain("Fast");
      expect(container.querySelector('[data-testid="model-picker-fast-icon"]')).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("opens on Thinking; only that leaf shows a selection check", async () => {
    const rows = projectPickerRows([
      catalogModel({ id: "gpt-5.6-sol", label: "Sol" }),
      catalogModel({
        id: "codex/gpt-5.6-luna",
        label: "Luna",
        provider: "codex-subscription",
        providerLabel: "Codex",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ModelPickerMenu
            rows={rows}
            model="gpt-5.6-sol"
            effort="low"
            latencyMode="standard"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />,
        ),
      );
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();
      expect(container.textContent).toContain("Thinking");
      expect(
        container.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
      ).toBeTruthy();
      expect(container.querySelector('[data-testid="model-picker-fast"]')).toBeTruthy();
      expect(container.querySelectorAll('[data-testid="model-picker-effort-check"]')).toHaveLength(
        1,
      );
      // Provider/model pages are not mounted on the leaf page.
      expect(
        container.querySelector('[data-testid="model-picker-rail-opengeni_credits"]'),
      ).toBeNull();
      expect(container.querySelector('[data-testid="model-picker-choice-gpt-5.6-sol"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("slides providers → models → thinking; Thinking commits the model", async () => {
    const rows = projectPickerRows([
      catalogModel({ id: "gpt-5.6-sol", label: "Sol" }),
      catalogModel({
        id: "codex/gpt-5.6-luna",
        label: "Luna",
        provider: "codex-subscription",
        providerLabel: "Codex",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ]);
    let selected = "gpt-5.6-sol";
    const selection = {
      effort: "low" as "low" | "high" | "xhigh",
      latency: "standard" as "standard" | "fast",
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [model, setModel] = useState(selected);
      const [effortState, setEffortState] = useState(selection.effort);
      const [latencyMode, setLatencyMode] = useState(selection.latency);
      return (
        <ModelPickerMenu
          rows={rows}
          model={model}
          effort={effortState}
          latencyMode={latencyMode}
          onModelChange={(id) => {
            selected = id;
            setModel(id);
          }}
          onEffortChange={(value) => {
            selection.effort = value as typeof selection.effort;
            setEffortState(selection.effort);
          }}
          onLatencyModeChange={(mode) => {
            selection.latency = mode === "fast" ? "fast" : "standard";
            setLatencyMode(selection.latency);
          }}
        />
      );
    }

    try {
      await act(async () => root.render(<Harness />));
      // Back from Thinking → models
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-back"]')!.click();
      });
      expect(container.querySelector('[data-testid="model-picker-models"]')).toBeTruthy();
      expect(selected).toBe("gpt-5.6-sol");

      // Back → providers
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-back"]')!.click();
      });
      expect(
        container.querySelector('[data-testid="model-picker-rail-codex_subscription"]'),
      ).toBeTruthy();

      await act(async () => {
        container
          .querySelector<HTMLElement>('[data-testid="model-picker-rail-codex_subscription"]')!
          .click();
      });
      expect(
        container.querySelector('[data-testid="model-picker-choice-codex/gpt-5.6-luna"]'),
      ).toBeTruthy();
      expect(selected).toBe("gpt-5.6-sol");

      await act(async () => {
        container
          .querySelector<HTMLElement>('[data-testid="model-picker-choice-codex/gpt-5.6-luna"]')!
          .click();
      });
      expect(selected).toBe("gpt-5.6-sol");
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();

      await act(async () => {
        const thinking = container.querySelector('[data-testid="model-picker-reasoning"]')!;
        const high = [...thinking.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "High",
        );
        high!.click();
      });
      expect(selected).toBe("codex/gpt-5.6-luna");
      expect(selection.effort).toBe("high");
      expect(container.querySelector('[data-testid="model-picker-fast"]')).toBeTruthy();

      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-fast"]')!.click();
      });
      expect(selection.latency).toBe("fast");

      // Back leaves Thinking without changing the committed selection.
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-back"]')!.click();
      });
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeNull();
      expect(container.querySelector('[data-testid="model-picker-models"]')).toBeTruthy();
      expect(selected).toBe("codex/gpt-5.6-luna");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("hides Fast toggle when the focused model cannot run it", async () => {
    const baseCapabilities = catalogModel({ id: "x", label: "x" }).capabilities!;
    const rows = projectPickerRows([
      catalogModel({
        id: "slow-only",
        label: "Slow",
        capabilities: {
          ...baseCapabilities,
          latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
        },
      }),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ModelPickerMenu
            rows={rows}
            model="slow-only"
            effort="low"
            latencyMode="standard"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />,
        ),
      );
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="model-picker-fast"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps client nav while mounted; remount resets to selected Thinking", async () => {
    const rows = projectPickerRows([
      catalogModel({ id: "gpt-5.6-sol", label: "Sol" }),
      catalogModel({
        id: "codex/gpt-5.6-luna",
        label: "Luna",
        provider: "codex-subscription",
        providerLabel: "Codex",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const menu = (
      <ModelPickerMenu
        rows={rows}
        model="gpt-5.6-sol"
        effort="low"
        latencyMode="standard"
        sessionKey="session-a"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
    );
    try {
      await act(async () => root.render(menu));
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();

      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-back"]')!.click();
      });
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="model-picker-back"]')!.click();
      });
      expect(
        container.querySelector('[data-testid="model-picker-rail-codex_subscription"]'),
      ).toBeTruthy();

      // Still mounted → stay on providers (close/reopen equivalent).
      await act(async () => root.render(menu));
      expect(
        container.querySelector('[data-testid="model-picker-rail-codex_subscription"]'),
      ).toBeTruthy();

      // Fresh mount (refresh) → selected Thinking leaf again.
      await act(async () => root.unmount());
      const root2 = createRoot(container);
      await act(async () => root2.render(menu));
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();
      expect(container.textContent).toContain("Thinking");
      await act(async () => root2.unmount());
    } finally {
      container.remove();
    }
  });
});
