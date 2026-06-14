import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/components/chat-composer";
import type { ComposerState } from "../src/hooks/use-composer";
import type { SlashCommandContext } from "../src/hooks/use-slash-commands";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
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

/** A controlled fake composer whose value is driven by React state in the test tree. */
function makeComposer(value: string, setValue: (v: string) => void, overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value,
    setValue,
    send: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
    mode: "queue",
    setMode: () => {},
    interrupt: async () => {},
    interrupting: false,
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

const ctx: SlashCommandContext = {
  client: fakeClient({
    updateGoal: async () => ({}) as never,
    clearSessionContext: async () => {},
    compactSessionContext: async () => ({ status: "queued", message: "queued" }),
  }),
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  status: null,
  permissions: ["sessions:control"] as never,
};

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

describe("ChatComposer slash palette", () => {
  test("opens the palette listbox when the value starts with '/'", async () => {
    let value = "/";
    const container = await mount(
      <ChatComposer composer={makeComposer(value, (v) => { value = v; })} commandContext={ctx} />,
    );
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(1);
    // The textarea advertises combobox semantics + activedescendant while open.
    const textarea = container.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-activedescendant")).toBeTruthy();
  });

  test("renders gated commands only with the permission; hides them otherwise", async () => {
    const withPerm = await mount(
      <ChatComposer composer={makeComposer("/", () => {})} commandContext={ctx} />,
    );
    const labels = [...withPerm.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "");
    expect(labels.join(" ")).toContain("/clear");
    expect(labels.join(" ")).toContain("/compact");
    if (mounted) {
      const c = mounted; mounted = null;
      await act(async () => c.root.unmount());
      c.container.remove();
    }

    const noPerm = await mount(
      <ChatComposer composer={makeComposer("/", () => {})} commandContext={{ ...ctx, permissions: [] as never }} />,
    );
    const noPermLabels = [...noPerm.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "").join(" ");
    expect(noPermLabels).toContain("/help");
    expect(noPermLabels).not.toContain("/clear ");
    expect(noPermLabels).not.toContain("/compact");
  });

  test("the palette is inert (not rendered) without a commandContext", async () => {
    const container = await mount(
      <ChatComposer composer={makeComposer("/clear", () => {})} />,
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  test("a danger command marks itself in the palette row", async () => {
    const container = await mount(
      <ChatComposer composer={makeComposer("/clear", () => {})} commandContext={ctx} />,
    );
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).toContain("danger");
  });
});
