import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

import type { SelectOption } from "./select-menu";

// Register the DOM before React DOM and Radix load: Radix picks a no-op layout
// effect when it is imported without a document, and the popover never mounts.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  ComboboxSelect,
  MenuSelect,
  NativeSelect,
  filterSelectOptions,
  nativeOptionText,
  nextEnabledIndex,
  typeaheadIndex,
} = await import("./select-menu");
const { Field } = await import("./field");

afterAll(() => GlobalRegistrator.unregister());

const models: SelectOption[] = [
  {
    value: "codex:gpt-6-astra",
    label: "GPT-6 Astra",
    meta: "Codex plan",
    description: "The most capable model for long, careful work.",
  },
  {
    value: "codex:gpt-6-luna",
    label: "GPT-6 Luna",
    meta: "Codex plan",
    description: "Fast and light, for quick questions and edits.",
  },
  {
    value: "codex:gpt-6-sol",
    label: "GPT-6 Sol",
    meta: "Codex plan",
    description: "Balanced speed and depth for everyday work.",
  },
  {
    value: "credits:gpt-6-astra",
    label: "GPT-6 Astra",
    meta: "OpenGeni credits",
    disabled: true,
    disabledReason: "No credit balance. An owner can add credits in Billing.",
  },
];

describe("option helpers", () => {
  test("search matches every word across label, meta, description and keywords", () => {
    expect(filterSelectOptions(models, "astra credits").map((option) => option.value)).toEqual([
      "credits:gpt-6-astra",
    ]);
    expect(filterSelectOptions(models, "  QUICK  ").map((option) => option.label)).toEqual([
      "GPT-6 Luna",
    ]);
    expect(
      filterSelectOptions(
        [{ value: "Europe/Oslo", label: "Oslo time", keywords: ["Europe/Oslo"] }],
        "europe",
      ),
    ).toHaveLength(1);
    expect(filterSelectOptions(models, "")).toHaveLength(4);
  });

  test("arrow movement skips unavailable options and wraps", () => {
    expect(nextEnabledIndex(models, 2, 1)).toBe(0);
    expect(nextEnabledIndex(models, 0, -1)).toBe(2);
    expect(nextEnabledIndex([{ value: "x", label: "X", disabled: true }], 0, 1)).toBe(-1);
  });

  test("typeahead cycles on a repeated letter and matches a typed prefix", () => {
    const roles: SelectOption[] = [
      { value: "viewer", label: "Viewer" },
      { value: "member", label: "Member" },
      { value: "workspace_admin", label: "Workspace admin" },
      { value: "maintainer", label: "Maintainer" },
    ];
    expect(typeaheadIndex(roles, "m", 1)).toBe(3);
    expect(typeaheadIndex(roles, "mm", 3)).toBe(1);
    expect(typeaheadIndex(roles, "wor", 0)).toBe(2);
    expect(typeaheadIndex(models, "gpt-6 astra", 3)).toBe(0);
  });

  test("native options keep the payer and say when they are unavailable", () => {
    expect(nativeOptionText(models[2]!)).toBe("GPT-6 Sol · Codex plan");
    expect(nativeOptionText(models[3]!)).toBe("GPT-6 Astra · OpenGeni credits - unavailable");
  });
});

describe("native select", () => {
  test("shows the chosen option's description and the disabled reason", () => {
    const html = renderToStaticMarkup(
      <NativeSelect
        aria-label="Default model"
        options={models}
        value="codex:gpt-6-sol"
        disabled
        disabledReason="Only workspace admins can change the default model."
      />,
    );
    expect(html).toContain("Balanced speed and depth for everyday work.");
    expect(html).toContain("Only workspace admins can change the default model.");
    expect(html).toContain("GPT-6 Astra · OpenGeni credits - unavailable");
  });

  test("inside a Field it takes the field's label, error and invalid state", () => {
    for (const Select of [NativeSelect, MenuSelect]) {
      const html = renderToStaticMarkup(
        <Field label="Default model" error="The model you picked was removed.">
          <Select options={models} placeholder="Choose a model" />
        </Field>,
      );
      const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
      const errorId = /<p id="([^"]+)"[^>]*>.*The model you picked was removed/.exec(html)?.[1];
      expect(labelFor).toBeTruthy();
      expect(html).toContain(`id="${labelFor}"`);
      expect(html).toContain(`aria-describedby="${errorId}"`);
      expect(html).toContain('aria-invalid="true"');
    }
  });
});

let container: HTMLDivElement;
let root: Root;

describe("menu select and combobox", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // Radix mounts the popover content a tick after it opens.
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const press = async (element: Element, key: string) => {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    await settle();
  };

  test("keyboard opens on the selected option, skips unavailable ones and selects with Enter", async () => {
    const change = mock();
    await act(async () =>
      root.render(
        <MenuSelect
          aria-label="Default model"
          options={models}
          value="codex:gpt-6-sol"
          onValueChange={change}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toContain("GPT-6 Sol");
    expect(trigger.textContent).toContain("Codex plan");
    trigger.focus();

    await press(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const active = () =>
      document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toContain("GPT-6 Sol");

    // The next option is unavailable, so the list wraps to the first one.
    await press(trigger, "ArrowDown");
    expect(active()).toContain("The most capable model");

    await press(trigger, "Enter");
    expect(change).toHaveBeenCalledWith("codex:gpt-6-astra");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("an unavailable option can't be picked and shows its reason", async () => {
    const change = mock();
    await act(async () =>
      root.render(
        <MenuSelect aria-label="Default model" options={models} onValueChange={change} />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => trigger.click());
    await settle();
    const unavailable = document.querySelector<HTMLElement>(
      '[role="option"][aria-disabled="true"]',
    )!;
    expect(unavailable.textContent).toContain("No credit balance");
    await act(async () => unavailable.click());
    await settle();
    expect(change).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("a loading select can't open", async () => {
    await act(async () =>
      root.render(
        <MenuSelect
          aria-label="Default model"
          options={[]}
          loading
          loadingLabel="Loading models…"
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.textContent).toContain("Loading models…");
  });

  test("combobox filters as you type and Enter picks the first match", async () => {
    const change = mock();
    await act(async () =>
      root.render(
        <ComboboxSelect
          aria-label="Default model"
          options={models}
          value="codex:gpt-6-sol"
          onValueChange={change}
          searchPlaceholder="Search models"
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.click());
    await settle();
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "luna");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const options = document.querySelectorAll('[role="listbox"] [role="option"]');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("GPT-6 Luna");

    await press(input, "Enter");
    expect(change).toHaveBeenCalledWith("codex:gpt-6-luna");
  });
});
