import { afterEach, describe, expect, test } from "bun:test";
import type { ClientModel } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelPolicyPicker, ModelPolicyPickerMenu } from "../src/components/model-policy-picker";
import { registerDom } from "./render-hook";

registerDom();

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

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

const MODELS: ClientModel[] = [
  {
    id: "codex/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
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
  },
  {
    id: "codex/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "high"],
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
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    },
  },
];

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  mounted = { root, container };
  return container;
}

describe("ModelPolicyPicker", () => {
  test("renders the polished model, effort, and Fast trigger from ClientModel data", async () => {
    const container = await mount(
      <ModelPolicyPicker
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="medium"
        latencyMode="fast"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Model and effort"]',
    );
    expect(trigger?.textContent).toContain("GPT-5.6 Sol");
    expect(trigger?.textContent).toContain("Medium");
    expect(container.querySelector('[data-testid="model-picker-fast-icon"]')).toBeTruthy();
    expect(container.querySelector("select")).toBeNull();
  });

  test("changes model policy only when an effort is chosen", async () => {
    let selectedModel = "codex/gpt-5.6-sol";
    let selectedEffort = "medium" as "low" | "medium" | "high";
    let selectedLatency = "standard" as "standard" | "fast";

    function Harness() {
      const [, rerender] = useState(0);
      return (
        <ModelPolicyPickerMenu
          models={MODELS}
          model={selectedModel}
          effort={selectedEffort}
          latencyMode={selectedLatency}
          onModelChange={(model) => {
            selectedModel = model;
            rerender((value) => value + 1);
          }}
          onEffortChange={(effort) => {
            selectedEffort = effort as typeof selectedEffort;
            rerender((value) => value + 1);
          }}
          onLatencyModeChange={(latencyMode) => {
            selectedLatency = latencyMode === "fast" ? "fast" : "standard";
            rerender((value) => value + 1);
          }}
        />
      );
    }

    const container = await mount(<Harness />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="model-picker-back"]')?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-choice-codex/gpt-5.6-terra"]')
        ?.click();
    });
    expect(selectedModel).toBe("codex/gpt-5.6-sol");

    await act(async () => {
      const high = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "High",
      );
      high?.click();
    });
    expect(selectedModel).toBe("codex/gpt-5.6-terra");
    expect(selectedEffort).toBe("high");
    expect(container.querySelector('[data-testid="model-picker-fast"]')).toBeNull();
  });

  test("allows hosts to translate the generic picker labels", async () => {
    const container = await mount(
      <ModelPolicyPicker
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="low"
        latencyMode="standard"
        messages={{ label: "Modell og tenking", thinking: "Tenking" }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Modell og tenking"]'),
    ).toBeTruthy();
  });

  test("never exposes stale model rows while the catalog is loading", async () => {
    const container = await mount(
      <ModelPolicyPicker
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="low"
        latencyMode="standard"
        loading
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-testid="model-picker-loading"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Model and effort"]')).toBeNull();
  });

  test("keeps an empty or failed catalog inspectable", async () => {
    const container = await mount(
      <>
        <ModelPolicyPicker
          models={[]}
          model="codex/unavailable"
          effort="low"
          latencyMode="standard"
          error="Catalog unavailable"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onLatencyModeChange={() => {}}
        />
        <ModelPolicyPickerMenu
          models={[]}
          model="codex/unavailable"
          effort="low"
          latencyMode="standard"
          error="Catalog unavailable"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onLatencyModeChange={() => {}}
        />
      </>,
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Model and effort"]',
    );
    expect(trigger?.textContent).toContain("codex/unavailable");

    expect(container.textContent).toContain("Catalog unavailable");
    expect(container.textContent).toContain("No models available.");
  });

  test("treats supplied empty catalog rows as authoritative", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        rows={[]}
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(container.textContent).toContain("No models available.");
    expect(container.textContent).not.toContain("GPT-5.6 Sol");
  });

  test("preserves the Codex billing rail for an unknown Codex selection", async () => {
    const container = await mount(
      <ModelPolicyPicker
        rows={[]}
        model="codex/unavailable"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="billing-class-icon-codex_subscription"]'),
    ).toBeTruthy();
  });
});
