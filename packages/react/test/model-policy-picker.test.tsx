import { ModelPolicyPickerMenu } from "../src/components/model-policy-picker-menu";
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientModel } from "@opengeni/sdk";
import { act } from "react";
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
    for (const row of group.querySelectorAll("button"))
      expect(row.textContent).not.toContain("subscription");
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
    const group = container.querySelector('section[aria-label="OpenGeni"]')!;
    expect(group.querySelectorAll("button").length).toBe(5);
    expect(container.querySelector('section[aria-label="External"]')).toBeNull();
    for (const label of ["Workspace providers", "Organization providers", "Codex"]) {
      expect(container.querySelector(`section[aria-label="${label}"]`)).toBeTruthy();
    }
    expect(group.textContent?.match(/Gratis/g)?.length).toBe(1);
    expect(group.textContent).not.toContain("credits");
    const paid = group.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-choice-openrouter/charged:free"]',
    )!;
    expect(paid.getAttribute("aria-description")).toBe("OpenGeni credits");
    expect(paid.title).toBe("openrouter/charged:free · OpenGeni credits");
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
    expect(row.getAttribute("aria-description")).toBe("Free in this deployment");
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

  test("selects immediately, coerces unsupported effort and speed, and closes", async () => {
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
      ["open", false],
    ]);
  });

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

  test("labels the shared BYOK rail as workspace-provider billing", async () => {
    const container = await mount(<BillingClassMark billingClass="byok" />);

    expect(container.querySelector('[aria-label="Workspace provider account"]')).toBeTruthy();
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

  test("renders the OpenGeni mark for an anonymous deployment provider", async () => {
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
    ).not.toContain("OpenGeni credits");
  });
});
