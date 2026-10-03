import { ModelPolicyPickerMenu } from "../src/components/model-policy-picker-menu";
import { ModelName } from "../src/components/model-mark";
import { projectClientModelRows } from "../src/model-policy";
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientModel, ReasoningEffort } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BillingClassMark,
  defaultModelPolicyPickerMessages,
  ModelPolicyPicker,
  useModelPolicyPickerState,
} from "../src/components/model-policy-picker";
import { actRun, registerDom, renderHook } from "./render-hook";

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
    shortLabel: "5.6 Sol",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high", "xhigh"],
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
  test.each(["credits", "free"] as const)(
    "stock deployment %s presentation is neutral without changing model truth",
    async (cost) => {
      const models: ClientModel[] = [
        {
          ...MODELS[0]!,
          id: "deployment/model",
          label: "Deployment model",
          source: "opengeni",
          provider: "openai",
          cost,
        },
        MODELS[1]!,
      ];
      const before = JSON.stringify(models);
      const container = await mount(
        <>
          <ModelPolicyPicker
            models={models}
            model="deployment/model"
            effort="low"
            latencyMode="standard"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />
          <ModelPolicyPickerMenu
            models={models}
            model="deployment/model"
            effort="low"
            latencyMode="standard"
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onLatencyModeChange={() => {}}
          />
        </>,
      );
      expect(container.querySelector('section[aria-label="Models"]')).not.toBeNull();
      expect(
        container.querySelector('[role="img"][aria-label="Models"] .lucide-sparkles'),
      ).not.toBeNull();
      expect(container.querySelector('svg[viewBox="0 0 140 133"]')).toBeNull();
      expect(container.textContent).not.toContain("Opengeni");
      expect(
        container.querySelector('section[aria-label="Codex"] svg[viewBox="0 0 24 24"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain("ChatGPT / Codex plan");
      const choice = container.querySelector(
        '[data-testid="model-picker-choice-deployment/model"]',
      )!;
      expect(choice.textContent?.includes("Free")).toBe(cost === "free");
      expect(JSON.stringify(models)).toBe(before);
    },
  );

  test("neutral defaults preserve external identities and caller-provided row labels", async () => {
    const rows = projectClientModelRows([
      { ...MODELS[0]!, id: "deployment/model", source: "opengeni", cost: "credits" },
      { ...MODELS[0]!, id: "external/model", source: "opengeni", provider: "custom" },
      MODELS[1]!,
    ]).map((row) =>
      row.id === "external/model"
        ? { ...row, billingClass: "external" as const, billingClassLabel: "External" }
        : row.billingClass === "opengeni_credits"
          ? { ...row, billingClassLabel: "Host models" }
          : row,
    );
    const catalogRows = rows.map((row) => ({
      ...row,
      catalog: {
        ...row.catalog,
        credentialReadiness: {
          status: "ready" as const,
          reason: null,
          basis: "configuration" as const,
          checkedAt: null,
        },
        availability: {
          status: "available" as const,
          selectable: row.selectable,
          reason: null,
          checkedAt: null,
        },
      },
    }));
    const container = await mount(
      <ModelPolicyPickerMenu
        rows={catalogRows}
        model="deployment/model"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(container.querySelector('section[aria-label="Host models"]')).not.toBeNull();
    expect(
      container.querySelector(
        'section[aria-label="External"] [data-testid="billing-class-icon-external"] svg',
      ),
    ).not.toBeNull();
    expect(container.querySelector('section[aria-label="Codex"]')).not.toBeNull();
  });

  test("deployment branding overrides supplied row labels without mutating catalog truth", async () => {
    const rows = projectClientModelRows([
      {
        ...MODELS[0]!,
        id: "host/example",
        provider: "openai",
        source: "opengeni",
        cost: "credits",
      },
    ]);
    const catalogRows = rows.map((row) => ({
      ...row,
      catalog: {
        ...row.catalog,
        credentialReadiness: {
          status: "ready" as const,
          reason: null,
          basis: "configuration" as const,
          checkedAt: null,
        },
        availability: {
          status: "available" as const,
          selectable: true,
          reason: null,
          checkedAt: null,
        },
      },
    }));
    const before = JSON.stringify(catalogRows);
    const container = await mount(
      <ModelPolicyPickerMenu
        rows={catalogRows}
        model="host/example"
        effort="low"
        latencyMode="standard"
        groupPresentation={{
          opengeni_credits: {
            label: "Acme Assist",
            description: "Workspace-provided models",
            icon: <svg data-testid="acme-mark" />,
          },
        }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(container.querySelector('section[aria-label="Acme Assist"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Opengeni");
    expect(container.textContent).toContain("Workspace-provided models");
    expect(container.querySelector('[data-testid="acme-mark"]')).not.toBeNull();
    expect(JSON.stringify(catalogRows)).toBe(before);
  });

  test("host presentation replaces group branding and search without changing selection", async () => {
    const selected: string[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="low"
        latencyMode="standard"
        groupPresentation={{
          codex_subscription: {
            label: "Acme models",
            description: "Included with Acme",
            icon: <svg data-testid="host-icon" />,
          },
        }}
        onModelChange={(id) => selected.push(id)}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(container.querySelector('section[aria-label="Acme models"]')).not.toBeNull();
    expect(container.textContent).toContain("Included with Acme");
    expect(container.textContent).not.toContain("ChatGPT / Codex plan");
    expect(container.querySelector('[data-testid="host-icon"]')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "Acme";
    const key = Object.keys(input).find((property) => property.startsWith("__reactProps$"))!;
    await act(async () =>
      (
        input as unknown as Record<
          string,
          { onChange: (event: { target: HTMLInputElement }) => void }
        >
      )[key]!.onChange({ target: input }),
    );
    const choice = container.querySelector<HTMLButtonElement>(
      `[data-testid="model-picker-choice-${MODELS[1]!.id}"]`,
    )!;
    expect(choice).not.toBeNull();
    await act(async () => choice.click());
    expect(selected).toEqual([MODELS[1]!.id]);
  });

  test("trigger branding uses the host label and icon", async () => {
    const container = await mount(
      <ModelPolicyPicker
        models={MODELS}
        model={MODELS[0]!.id}
        effort="low"
        latencyMode="standard"
        groupPresentation={{
          codex_subscription: {
            label: "Acme models",
            icon: <svg data-testid="trigger-host-icon" />,
          },
        }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(container.querySelector('[role="img"][aria-label="Acme models"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trigger-host-icon"]')).not.toBeNull();
  });

  test("explicit null hides group icons and descriptions", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="low"
        latencyMode="standard"
        groupPresentation={{ codex_subscription: { icon: null, description: null } }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(
      container.querySelector('[data-testid="billing-class-icon-codex_subscription"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("ChatGPT / Codex plan");
  });

  test.each([false, true])(
    "renders usable Codex first without mutating selection (codexOnly=%s)",
    async (codexOnly) => {
      const rows = projectClientModelRows([
        { ...MODELS[0]!, id: "free", label: "Free", source: "opengeni", cost: "free" },
        { ...MODELS[0]!, id: "paid", label: "Paid", source: "opengeni", cost: "credits" },
        ...MODELS,
      ])
        .map((row) =>
          row.id === "paid"
            ? { ...row, selectable: false, unavailableReason: "Blocked by workspace policy" }
            : row,
        )
        .map((row) => ({
          ...row,
          catalog: {
            ...row.catalog,
            credentialReadiness: {
              status: "ready" as const,
              reason: null,
              basis: "configuration" as const,
              checkedAt: null,
            },
            availability: {
              status: "available" as const,
              selectable: row.selectable,
              reason: null,
              checkedAt: null,
            },
          },
        }));
      const calls: unknown[] = [];
      const container = await mount(
        <ModelPolicyPickerMenu
          rows={rows}
          model="free"
          codexOnly={codexOnly}
          effort="medium"
          latencyMode="standard"
          onModelChange={(id) => calls.push(id)}
          onEffortChange={(effort) => calls.push(effort)}
          onLatencyModeChange={(mode) => calls.push(mode)}
        />,
      );
      expect(
        [...container.querySelectorAll("section")].map((section) =>
          section.getAttribute("aria-label"),
        ),
      ).toEqual(["Codex", "Models"]);
      expect(
        container.querySelector('[data-testid="model-picker-choice-free"] [aria-label="Selected"]'),
      ).toBeTruthy();
      const blocked = container.querySelector<HTMLButtonElement>(
        '[data-testid="model-picker-choice-paid"]',
      )!;
      expect(blocked.disabled).toBe(true);
      expect(blocked.textContent).toContain("Blocked by workspace policy");
      expect(container.querySelector('[aria-label="Search models or providers"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="model-picker-reasoning"]')).toBeTruthy();
      const codexButtons = container.querySelectorAll<HTMLButtonElement>(
        'section[aria-label="Codex"] button',
      );
      codexButtons[0]!.focus();
      await act(async () =>
        codexButtons[0]!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        ),
      );
      expect(document.activeElement).toBe(codexButtons[1]!);
      expect(calls).toEqual([]);
      expect(rows[0]?.selectable).toBe(true);
    },
  );

  test("search does not promote Codex when selectable paid models are filtered out", async () => {
    const calls: unknown[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={[
          { ...MODELS[0]!, id: "free", label: "Match Free", source: "opengeni", cost: "free" },
          { ...MODELS[0]!, id: "paid", label: "Paid", source: "opengeni", cost: "credits" },
          { ...MODELS[0]!, label: "Match Codex" },
        ]}
        model="paid"
        effort="medium"
        latencyMode="standard"
        onModelChange={(id) => calls.push(id)}
        onEffortChange={(effort) => calls.push(effort)}
        onLatencyModeChange={() => {}}
      />,
    );
    const input = container.querySelector("input")!;
    input.value = "Match";
    const key = Object.keys(input).find((property) => property.startsWith("__reactProps$"))!;
    const handler = (
      input as unknown as Record<
        string,
        { onChange: (event: { target: HTMLInputElement }) => void }
      >
    )[key]!;
    await act(async () => handler.onChange({ target: input }));
    expect(container.querySelector('[data-testid="model-picker-choice-paid"]')).toBeNull();
    expect(
      [...container.querySelectorAll("section")].map((section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual(["Models", "Codex"]);
    expect(calls).toEqual([]);
  });

  test("shows subscription copy once per provider and keeps selection in its group", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="medium"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const group = container.querySelector('section[aria-label="Codex"]')!;
    expect(group.textContent?.match(/ChatGPT \/ Codex plan/g)?.length).toBe(1);
    expect(group.querySelectorAll('[data-testid^="model-picker-choice-"]').length).toBe(2);
    expect(group.querySelector('[aria-label="Selected"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Current model");
    for (const row of group.querySelectorAll("button")) {
      expect(row.textContent).not.toContain("subscription");
      expect(row.getAttribute("aria-description")).toBeNull();
      expect(row.title).not.toContain("ChatGPT / Codex plan");
    }
  });

  test("selects thinking inline without switching model or closing the picker", async () => {
    const calls: unknown[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="medium"
        latencyMode="standard"
        onModelChange={(id) => calls.push(["model", id])}
        onEffortChange={(effort) => calls.push(["effort", effort])}
        onLatencyModeChange={() => {}}
        onOpenChange={(open) => calls.push(["open", open])}
      />,
    );
    expect(container.querySelector("select")).toBeNull();
    expect(
      container.querySelector('[role="radio"][aria-label="Medium"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="High"]')!.click(),
    );
    expect(calls).toEqual([["effort", "high"]]);
  });

  test("Claude Extra high and Max reuse the inline picker without changing model or closing it", async () => {
    const model: ClientModel = {
      ...MODELS[0]!,
      id: "workspace-claude-subscription/claude-opus-5-5",
      provider: "workspace-claude-subscription",
      providerLabel: "Claude subscription",
      source: undefined,
      api: "anthropic-messages",
      label: "Claude Opus 5.5",
      capabilities: {
        ...MODELS[0]!.capabilities!,
        reasoning: {
          upstream: "supported",
          runnable: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "medium",
          required: false,
        },
        latencyModes: [],
      },
    };
    const calls: unknown[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={[model]}
        model={model.id}
        effort="medium"
        latencyMode="standard"
        onModelChange={(id) => calls.push(["model", id])}
        onEffortChange={(effort) => calls.push(["effort", effort])}
        onLatencyModeChange={() => {}}
        onOpenChange={(open) => calls.push(["open", open])}
      />,
    );
    expect(
      [...container.querySelectorAll('[role="radio"]')].map((element) =>
        element.getAttribute("aria-label"),
      ),
    ).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    expect(
      container.querySelector('[role="radio"][aria-label="Medium"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    for (const label of ["Extra high", "Max"])
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`)!
          .click(),
      );
    expect(calls).toEqual([
      ["effort", "xhigh"],
      ["effort", "max"],
    ]);
  });

  test("hides thinking for models with no runnable reasoning controls", async () => {
    const model = {
      ...MODELS[0]!,
      capabilities: {
        ...MODELS[0]!.capabilities!,
        reasoning: { ...MODELS[0]!.capabilities!.reasoning, runnable: false },
        latencyModes: [],
      },
    };
    const container = await mount(
      <>
        <ModelPolicyPicker
          models={[model]}
          model={model.id}
          effort="low"
          latencyMode="standard"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onLatencyModeChange={() => {}}
        />
        <ModelPolicyPickerMenu
          models={[model]}
          model={model.id}
          effort="low"
          latencyMode="standard"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onLatencyModeChange={() => {}}
        />
      </>,
    );
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector(".og-model-policy-effort")).toBeNull();
    expect(container.textContent).not.toContain("Thinking");
  });
  test("combines deployment providers, preserves connection groups, and badges only explicit free cost", async () => {
    const deployment = (id: string, cost?: "free" | "credits"): ClientModel => ({
      id,
      label: id,
      provider: id.split("/")[0]!,
      providerLabel: id.split("/")[0]!,
      api: "chat",
      cost,
      billing: { upstreamPayer: "deployment", metering: "external" },
    });
    const models: ClientModel[] = [
      deployment("azure/model", "credits"),
      deployment("gateway/model", "credits"),
      deployment("openrouter/starter:free", "free"),
      deployment("openrouter/charged:free", "credits"),
      deployment("anonymous/legacy:free"),
      { ...deployment("workspace-openrouter/model"), cost: "workspace" },
      { ...deployment("organization-gateway/model"), cost: "organization" },
      ...MODELS,
    ];
    const before = JSON.stringify(models);
    const calls: string[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={models}
        model="unselected"
        effort="low"
        latencyMode="standard"
        messages={{ free: "Gratis" }}
        onModelChange={(id) => calls.push(id)}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const group = container.querySelector('section[aria-label="Models"]')!;
    expect(group.querySelectorAll("button").length).toBe(5);
    expect(container.querySelector('section[aria-label="External"]')).toBeNull();
    // Organization- and workspace-connected keys share one scope-free group.
    for (const label of ["API keys", "Codex"]) {
      expect(container.querySelector(`section[aria-label="${label}"]`)).toBeTruthy();
    }
    expect(container.querySelector('section[aria-label="Organization providers"]')).toBeNull();
    expect(group.textContent?.match(/Gratis/g)?.length).toBe(1);
    expect(group.textContent).not.toContain("credits");
    const paid = group.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-choice-openrouter/charged:free"]',
    )!;
    expect(paid.getAttribute("aria-description")).toBeNull();
    expect(paid.title).toBe("Charged");
    await act(async () => paid.click());
    expect(calls).toEqual(["openrouter/charged:free"]);
    expect(JSON.stringify(models)).toBe(before);
  });

  test("keeps the Free badge beside the current-model checkmark", async () => {
    const model: ClientModel = { ...MODELS[0]!, id: "starter", source: "openrouter", cost: "free" };
    const container = await mount(
      <ModelPolicyPickerMenu
        models={[model]}
        model={model.id}
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const row = container.querySelector('[data-testid="model-picker-choice-starter"]')!;
    expect(row.textContent).toContain("Free");
    expect(row.querySelector('[aria-label="Selected"]')).toBeTruthy();
    expect(row.getAttribute("aria-description")).toBeNull();
  });
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
    // Mobile span prefers curated shortLabel; desktop keeps the full label.
    const labelSpans = [...(trigger?.querySelectorAll("span.truncate") ?? [])];
    const mobileLabel = labelSpans.find((span) => /(?:^|\s)sm:hidden(?:\s|$)/.test(span.className));
    const desktopLabel = labelSpans.find((span) =>
      /(?:^|\s)max-sm:hidden(?:\s|$)/.test(span.className),
    );
    expect(mobileLabel?.textContent).toBe("5.6 Sol");
    expect(desktopLabel?.textContent).toBe("GPT-5.6 Sol");
    expect(trigger?.className).toContain("max-sm:max-w-[7.5rem]");
  });

  test("the field trigger shows the model and the payer, and leaves the effort to the menu", async () => {
    const container = await mount(
      <ModelPolicyPicker
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="medium"
        latencyMode="standard"
        triggerStyle="field"
        triggerMeta="Codex"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Model and effort"]',
    );
    expect(trigger?.dataset.triggerStyle).toBe("field");
    expect(trigger?.textContent).toBe("GPT-5.6 SolCodex");
    expect(trigger?.textContent).not.toContain("Medium");
    expect(trigger?.className).not.toContain("rounded-full");
  });

  test("selects immediately and coerces unsupported effort and speed without closing", async () => {
    const calls: unknown[] = [];
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="medium"
        latencyMode="fast"
        onModelChange={(value) => calls.push(["model", value])}
        onEffortChange={(value) => calls.push(["effort", value])}
        onLatencyModeChange={(value) => calls.push(["latency", value])}
        onOpenChange={(value) => calls.push(["open", value])}
      />,
    );
    expect(container.querySelector('[data-testid="model-picker-back"]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-picker-choice-codex/gpt-5.6-terra"]',
        )!
        .click(),
    );
    expect(calls).toEqual([
      ["model", "codex/gpt-5.6-terra"],
      ["effort", "low"],
      ["latency", "standard"],
    ]);
  });

  test.each(["codex/gpt-5.6-sol", "codex/gpt-5.6-terra"])(
    "keeps the picker open to adjust effort after selecting %s",
    async (modelId) => {
      function Harness() {
        const [open, setOpen] = useState(true);
        const [model, setModel] = useState(MODELS[0]!.id);
        const [effort, setEffort] = useState<ReasoningEffort>("medium");
        return open ? (
          <ModelPolicyPickerMenu
            models={MODELS}
            model={model}
            effort={effort}
            latencyMode="standard"
            onModelChange={setModel}
            onEffortChange={setEffort}
            onLatencyModeChange={() => {}}
            onOpenChange={setOpen}
          />
        ) : null;
      }
      const container = await mount(<Harness />);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[data-testid="model-picker-choice-${modelId}"]`)!
          .click(),
      );
      expect(container.querySelector('[data-testid="model-picker-menu"]')).not.toBeNull();
      expect(
        container.querySelector(
          `[data-testid="model-picker-choice-${modelId}"] [aria-label="Selected"]`,
        ),
      ).not.toBeNull();
      expect(container.querySelectorAll('[role="radio"]').length).toBe(
        modelId === MODELS[0]!.id ? 4 : 2,
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="High"]')!.click(),
      );
      expect(container.querySelector('[data-testid="model-picker-menu"]')).not.toBeNull();
      expect(
        container.querySelector('[role="radio"][aria-label="High"]')?.getAttribute("aria-checked"),
      ).toBe("true");
    },
  );

  test("commits supported effort after model selection and hides a model with only one level", async () => {
    const calls: string[] = [];
    const lowOnly: ClientModel = {
      ...MODELS[1]!,
      id: "low-only",
      capabilities: {
        ...MODELS[1]!.capabilities!,
        reasoning: {
          ...MODELS[1]!.capabilities!.reasoning,
          efforts: ["low"],
          defaultEffort: "low",
        },
      },
    };
    const container = await mount(
      <ModelPolicyPickerMenu
        models={[...MODELS, lowOnly]}
        model="low-only"
        effort="low"
        latencyMode="standard"
        onModelChange={(value) => calls.push(value)}
        onEffortChange={(value) => calls.push(value)}
        onLatencyModeChange={() => {}}
      />,
    );
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-choice-codex/gpt-5.6-sol"]')!
        .click(),
    );
    expect(calls).toEqual(["codex/gpt-5.6-sol", "low"]);
  });

  test("warns only when the selected model cannot receive images", async () => {
    const warning = "This model cannot view the attached images.";
    for (const [inputModalities, hasImageAttachments] of [
      [["text"], false],
      [["text"], true],
      [["text", "image"], true],
    ] as const) {
      const model: ClientModel = {
        ...MODELS[0]!,
        capabilities: { ...MODELS[0]!.capabilities!, inputModalities: [...inputModalities] },
      };
      const container = await mount(
        <ModelPolicyPickerMenu
          hasImageAttachments={hasImageAttachments}
          models={[model]}
          model={model.id}
          effort="medium"
          latencyMode="standard"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onLatencyModeChange={() => {}}
        />,
      );
      expect(container.textContent?.includes(warning)).toBe(
        hasImageAttachments && inputModalities.length === 1,
      );
      await act(async () => mounted!.root.unmount());
      container.remove();
      mounted = null;
    }
  });

  test("controlled and uncontrolled open state stay independent of model selection", async () => {
    const hook = await renderHook(
      (open: boolean | undefined) =>
        useModelPolicyPickerState({
          models: MODELS,
          model: MODELS[0]!.id,
          effort: "high",
          latencyMode: "standard",
          open,
          onModelChange() {},
          onEffortChange() {},
          onLatencyModeChange() {},
        }),
      undefined as boolean | undefined,
    );
    try {
      await actRun(() => hook.result.current.setOpen(true));
      expect(hook.result.current.open).toBe(true);
      await hook.rerender(false);
      await actRun(() => hook.result.current.setOpen(true));
      expect(hook.result.current.open).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  test("filters names and payment sources and reports no matches", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="high"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    const search = async (value: string) => {
      // React's change-event feature detection runs before Happy DOM is registered.
      // Use the same event seam as human-input.test.ts; browser input is verified live.
      input.value = value;
      const key = Object.keys(input).find((property) => property.startsWith("__reactProps$"))!;
      const handler = (
        input as unknown as Record<
          string,
          { onChange: (event: { target: HTMLInputElement }) => void }
        >
      )[key]!;
      await act(async () => handler.onChange({ target: input }));
    };
    await search("terra");
    expect(
      Boolean(container.querySelector('[data-testid="model-picker-choice-codex/gpt-5.6-sol"]')),
    ).toBe(false);
    expect(
      Boolean(container.querySelector('[data-testid="model-picker-choice-codex/gpt-5.6-terra"]')),
    ).toBe(true);
    await search("no-such-model");
    expect(container.textContent).toContain("No matching models");
    await search("");
    expect(container.querySelectorAll('[data-testid^="model-picker-choice-"]').length).toBe(2);
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

  test("translates search, selection, billing, and thinking in the open menu", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model={MODELS[0]!.id}
        effort="high"
        latencyMode="standard"
        hasImageAttachments
        messages={{
          searchLabel: "Søk etter modell",
          searchPlaceholder: "Søk…",
          currentModel: "Valgt modell",
          noMatches: "Ingen treff",
          unsupportedAttachments: "Denne modellen kan ikke se vedleggene.",
          thinking: "Tenking",
          thinkingEffort: "Tenkenivå",
          selected: "Valgt",
          billingHints: {
            ...defaultModelPolicyPickerMessages.billingHints,
            codex_subscription: "Codex-abonnement",
          },
        }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Søk etter modell"]',
    )!;
    expect(input.placeholder).toBe("Søk…");
    expect(container.textContent).not.toContain("Valgt modell");
    expect(container.textContent).toContain("Codex-abonnement");
    expect(container.textContent).toContain("Denne modellen kan ikke se vedleggene.");
    expect(container.querySelector('[role="radiogroup"][aria-label="Tenkenivå"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Valgt"]')).toBeTruthy();
    input.value = "no-such-model";
    const key = Object.keys(input).find((property) => property.startsWith("__reactProps$"))!;
    const handler = (
      input as unknown as Record<
        string,
        { onChange: (event: { target: HTMLInputElement }) => void }
      >
    )[key]!;
    await act(async () => handler.onChange({ target: input }));
    expect(container.textContent).toContain("Ingen treff");
    expect(container.textContent).not.toContain("No matching models");
  });

  test("can hide latency controls on policy surfaces that do not persist latency", async () => {
    const container = await mount(
      <ModelPolicyPickerMenu
        models={MODELS}
        model="codex/gpt-5.6-sol"
        effort="low"
        latencyMode="standard"
        allowLatencyMode={false}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-choice-codex/gpt-5.6-sol"]')
        ?.click();
    });

    expect(container.querySelector('[data-testid="model-picker-fast"]')).toBeNull();
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

    const loading = container.querySelector('[data-testid="model-picker-loading"]');
    expect(loading).toBeTruthy();
    expect(loading?.classList.contains("og-root")).toBeTrue();
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
    // The trigger names the model, never its routing id.
    expect(trigger?.textContent).toContain("Unavailable");
    expect(trigger?.textContent).not.toContain("codex/");

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

  test("preserves the Gateway billing rail for a removed custom-model selection", async () => {
    const container = await mount(
      <ModelPolicyPicker
        rows={[]}
        model="workspace-gateway/retired/provider-model"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-testid="billing-class-icon-byok"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
    ).toBeNull();
  });

  test("preserves the workspace-provider rail for a removed OpenRouter selection", async () => {
    const container = await mount(
      <ModelPolicyPicker
        rows={[]}
        model="workspace-openrouter/retired/provider-model"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-testid="billing-class-icon-byok"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="billing-class-icon-external"]')).toBeNull();
  });

  test("labels the shared BYOK rail without connection scope", async () => {
    const container = await mount(<BillingClassMark billingClass="byok" />);

    expect(container.querySelector('[aria-label="API key"]')).toBeTruthy();
  });

  test("uses the credits-safe rail when a removed OpenRouter selection has no cost row", async () => {
    const container = await mount(
      <ModelPolicyPicker
        rows={[]}
        model="openrouter/retired/provider-model:free"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="billing-class-icon-external"]')).toBeNull();
  });

  test("renders the neutral Models mark for an anonymous deployment provider", async () => {
    const external: ClientModel = {
      id: "opencode/x-preview-f-free",
      label: "OpenCode Ox Alpha",
      provider: "opencode-zen",
      providerLabel: "OpenCode Zen",
      api: "chat",
      billing: { upstreamPayer: "deployment", metering: "external" },
    };
    const container = await mount(
      <ModelPolicyPicker
        models={[external]}
        model={external.id}
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
    ).toBeTruthy();
    expect(container.querySelector('[aria-label="Models"] .lucide-sparkles')).not.toBeNull();
  });

  test("badges only explicitly free deployment models", async () => {
    const freeModel: ClientModel = {
      ...MODELS[0]!,
      id: "deployment/free-model",
      label: "Deployment Free",
      provider: "openai",
      providerLabel: "OpenAI",
      source: "opengeni",
      cost: "free",
    };
    const creditsModel: ClientModel = {
      ...MODELS[1]!,
      id: "deployment/credits-model",
      label: "Deployment Credits",
      provider: "openai",
      providerLabel: "OpenAI",
      source: "opengeni",
      cost: "credits",
    };
    const container = await mount(
      <ModelPolicyPickerMenu
        models={[freeModel, creditsModel]}
        model="deployment/unavailable"
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="model-picker-choice-deployment/free-model"]')
        ?.textContent,
    ).toContain("Free");
    expect(
      container.querySelector('[data-testid="model-picker-choice-deployment/credits-model"]')
        ?.textContent,
    ).not.toContain("Opengeni credits");
  });
});

describe("model identity outside settings", () => {
  test("ModelName shows the clean name and maker mark for any connection scope", async () => {
    const container = await mount(
      <>
        <ModelName model="organization-claude-subscription/claude-opus-5-5" />
        <ModelName model="workspace-claude-subscription/claude-opus-5-5" />
        <ModelName model="codex/gpt-6.1-sol" />
      </>,
    );
    const names = [...container.querySelectorAll("span[title]")].map((node) => node.textContent);
    expect(names).toEqual(["Claude Opus 5.5", "Claude Opus 5.5", "GPT-6.1 Sol"]);
    expect(
      [...container.querySelectorAll("[data-model-vendor]")].map((node) =>
        node.getAttribute("data-model-vendor"),
      ),
    ).toEqual(["anthropic", "anthropic", "openai"]);
    expect(container.textContent).not.toContain("/");
  });

  test("API-key trigger shows the maker mark and name, not a key or raw id", async () => {
    const model: ClientModel = {
      ...MODELS[0]!,
      id: "organization-anthropic/claude-haiku-4-5-20251001",
      label: "claude-haiku-4-5-20251001",
      provider: "organization-anthropic",
      providerLabel: "Anthropic API",
      source: undefined,
      cost: "organization",
    };
    const container = await mount(
      <ModelPolicyPicker
        models={[model]}
        model={model.id}
        effort="low"
        latencyMode="standard"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />,
    );
    const trigger = container.querySelector('button[aria-label="Model and effort"]')!;
    expect(trigger.textContent).toContain("Claude Haiku 4.5");
    expect(trigger.textContent).not.toContain("claude-haiku");
    expect(trigger.querySelector('[data-model-vendor="anthropic"]')).not.toBeNull();
    expect(trigger.querySelector('[data-testid^="billing-class-icon-"]')).toBeNull();
  });
});
