/* ----------------------------------------------------------------------------
   <ModelPicker> + ChatComposer's opt-in `models` prop: the provider-grouped
   dropdown, its controlled value/onChange, and the composer footer wiring that
   stays backward-compatible when `models` is absent.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ClientModel } from "@opengeni/sdk";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/components/chat-composer";
import { ModelPicker } from "../src/components/model-picker";
import type { ComposerState } from "../src/hooks/use-composer";
import { registerDom } from "./render-hook";

registerDom();

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await act(async () => {
      current.root.unmount();
    });
    current.container.remove();
  }
});

const MODELS: ClientModel[] = [
  {
    id: "gpt-5.6-sol",
    label: "gpt-5.6-sol",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
  },
  {
    id: "gpt-5.4",
    label: "gpt-5.4",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
  },
  {
    id: "accounts/fireworks/models/glm-5p2",
    label: "GLM 5.2",
    provider: "fireworks",
    providerLabel: "Fireworks AI",
    api: "chat",
  },
];

function makeComposer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "hello",
    setValue: () => {},
    hasDraftContent: () => true,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: true,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = { root, container };
  return container;
}

function picker(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
}

describe("ModelPicker", () => {
  test("renders one optgroup per provider, in first-seen order, with model labels", async () => {
    const container = await mount(<ModelPicker models={MODELS} onChange={() => {}} />);
    const select = picker(container)!;
    const groups = [...select.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["OpenAI", "Fireworks AI"]);
    // OpenAI group holds its two models; Fireworks group holds GLM 5.2.
    expect([...groups[0]!.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.4",
    ]);
    expect([...groups[1]!.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "accounts/fireworks/models/glm-5p2",
    ]);
  });

  test("reflects the controlled value", async () => {
    const container = await mount(
      <ModelPicker models={MODELS} value="gpt-5.4" onChange={() => {}} />,
    );
    expect(picker(container)!.value).toBe("gpt-5.4");
  });

  test("calls onChange with the chosen model id", async () => {
    const chosen: string[] = [];
    const container = await mount(
      <ModelPicker models={MODELS} value="gpt-5.6-sol" onChange={(id) => chosen.push(id)} />,
    );
    const select = picker(container)!;
    await act(async () => {
      select.value = "accounts/fireworks/models/glm-5p2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chosen).toEqual(["accounts/fireworks/models/glm-5p2"]);
  });

  test("renders nothing when no models are exposed", async () => {
    const container = await mount(<ModelPicker models={[]} onChange={() => {}} />);
    expect(picker(container)).toBeNull();
  });
});

describe("ChatComposer model picker", () => {
  test("with no models prop, no picker renders (backward compatible)", async () => {
    const container = await mount(<ChatComposer composer={makeComposer()} />);
    expect(picker(container)).toBeNull();
  });

  test("renders the picker in the footer when models is present", async () => {
    const container = await mount(
      <ChatComposer
        composer={makeComposer()}
        models={MODELS}
        selectedModel="gpt-5.6-sol"
        onSelectModel={() => {}}
      />,
    );
    expect(picker(container)).toBeTruthy();
    expect(picker(container)!.value).toBe("gpt-5.6-sol");
  });

  test("threads the selection out through onSelectModel", async () => {
    const chosen: string[] = [];
    const container = await mount(
      <ChatComposer
        composer={makeComposer()}
        models={MODELS}
        selectedModel="gpt-5.6-sol"
        onSelectModel={(id) => chosen.push(id)}
      />,
    );
    const select = picker(container)!;
    await act(async () => {
      select.value = "accounts/fireworks/models/glm-5p2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chosen).toEqual(["accounts/fireworks/models/glm-5p2"]);
  });
});
