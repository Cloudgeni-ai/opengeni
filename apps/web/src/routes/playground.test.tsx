import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const DEVELOPMENT = "00000000-0000-4000-8000-0000000000c1";
const SUBJECT = "user:ada";

// The playground must never reach the API: every call fails loudly.
const unexpected = mock(async () => {
  throw new Error("The playground called the API");
});
const client = new Proxy({}, { get: () => unexpected });
const navigate = mock(async (_to: unknown) => undefined);
const toastError = mock((_title: string, _options?: unknown) => undefined);
const context = {
  client,
  busy: false,
  clientConfig: { productAccessMode: "managed", auth: { mode: "managedSession" }, models: [] },
  authSession: { user: { name: "Ada Lovelace", email: "ada@example.test" } },
  accessContext: {
    mode: "managed",
    subjectId: SUBJECT,
    defaultAccountId: ORG,
    accountGrants: [{ accountId: ORG, subjectId: SUBJECT, role: "owner", permissions: [] }],
    workspaceGrants: [],
  },
  workspaces: [{ id: DEVELOPMENT, accountId: ORG, kind: "shared", name: "Development" }],
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { error: toastError } }));
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    params: _params,
    search,
    ...rest
  }: { children: ReactNode; to?: string; params?: unknown; search?: { section?: string } } & Record<
    string,
    unknown
  >) => (
    <a href={`${to ?? ""}${search?.section ? `?section=${search.section}` : ""}`} {...rest}>
      {children}
    </a>
  ),
}));

const { PlaygroundRoute } = await import("./playground");
const { ADD_AGENT_DEFAULT_PROMPT } = await import("@/components/new-session-starters");

const realSetTimeout = globalThis.setTimeout;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Play the recording without waiting for it.
  globalThis.setTimeout = ((handler: () => void, _delay?: number, ...rest: unknown[]) =>
    realSetTimeout(handler, 0, ...rest)) as typeof setTimeout;
});
afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  localStorage.clear();
  unexpected.mockClear();
  navigate.mockClear();
  toastError.mockClear();
});

async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => await new Promise((resolve) => realSetTimeout(resolve, 2)));
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<PlaygroundRoute workspaceId={DEVELOPMENT} />));
  await settle(4);
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const chat = (container: HTMLElement) =>
  container.querySelector("[data-playground-product]")!.textContent ?? "";
const buttonIn = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.includes(text) || button.getAttribute("aria-label") === text,
  );
async function press(element: HTMLElement | null | undefined) {
  if (!element) throw new Error("Missing control");
  await act(async () => element.click());
  await settle();
}
const snippet = (container: HTMLElement) => container.querySelector('pre[data-snippet="page"]')!;
const callout = (container: HTMLElement) =>
  container.ownerDocument.querySelector<HTMLElement>("[data-callout]");
const marked = (container: HTMLElement) =>
  Array.from(snippet(container).querySelectorAll("[data-changed]"), (line) => line.textContent);

describe("playground", () => {
  test("is one screen: Acme with the real chat, three questions, the snippet, one button", async () => {
    const { container, unmount } = await mount();
    try {
      expect(container.querySelector("h1")!.textContent).toBe("Playground");
      expect(container.textContent).toContain("Try a color");
      // The stock OpenGeniChat: its chat list and new-chat composer.
      expect(chat(container)).toContain("Delivery address");
      expect(container.querySelector("[data-og-new-chat-composer] textarea")).not.toBeNull();
      expect(container.querySelectorAll('[aria-label="Suggested questions"] button').length).toBe(
        3,
      );
      const code = snippet(container).textContent ?? "";
      expect(code).toContain("<OpenGeniChat />");
      expect(snippet(container).querySelectorAll(".og-code-line").length).toBeLessThanOrEqual(12);
      // No steps, tabs or settings: two small Copy buttons, one primary action.
      expect(container.querySelector("[role='tab'], [role='switch'], [data-step]")).toBeNull();
      expect(buttonIn(container, "Copy Support.jsx")).toBeTruthy();
      // The only code is the component snippet.
      expect(container.querySelectorAll("pre").length).toBe(1);
      expect(container.textContent).not.toContain("server.ts");
      expect(buttonIn(container, "Add it to your product")).toBeTruthy();
      expect(container.textContent).toContain(
        "Opens a new chat with a prompt for adding it to your product.",
      );
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("a question plays in the real chat with Acme's tool, without calling the API", async () => {
    const { container, unmount } = await mount();
    try {
      await press(
        buttonIn(
          container.querySelector('[aria-label="Suggested questions"]')!,
          "Where is my order #4417?",
        ),
      );
      expect(chat(container)).toContain("Where is my order #4417?");
      expect(chat(container)).toContain("out for delivery with UPS");
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("a color and light restyle the chat live and mark the lines they change", async () => {
    const { container, unmount } = await mount();
    try {
      const product = container.querySelector<HTMLElement>("[data-playground-product]")!;
      expect(marked(container)).toEqual([]);
      await press(container.querySelector<HTMLElement>('[role="radio"][aria-label="Indigo"]'));
      expect(product.style.getPropertyValue("--og-color-accent")).toBe("#5b4bff");
      expect(marked(container)).toEqual([
        '    "--og-color-accent": "#5b4bff",',
        '    "--og-color-primary": "#5b4bff",',
        '    "--og-color-surface-2": "#5b4bff26",',
      ]);
      // The chat takes the color beyond the accent: user messages and the
      // selected chat sit on the tinted secondary surface.
      expect(product.style.getPropertyValue("--og-color-surface-2")).toBe("#5b4bff26");
      await press(buttonIn(container.querySelector('[aria-label="Theme"]')!, "Light"));
      expect(product.dataset.ogTheme).toBe("light");
      expect(marked(container)).toEqual(['  <div data-og-theme="light" style={{']);
    } finally {
      await unmount();
    }
  });

  test("Add it to your product puts its prompt in the new-chat composer, unsent", async () => {
    const draft = {
      text: "Something I was typing",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "codex/gpt-6-astra",
      reasoningEffort: "low",
      latencyMode: "standard",
      options: {},
      revision: 3,
    };
    const saveNewSessionDraft = mock(async (_workspaceId: string, _draft: unknown) => draft);
    const real = context.client;
    (context as { client: unknown }).client = {
      getNewSessionDraft: async () => draft,
      saveNewSessionDraft,
    };
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(container, "Add it to your product"));
      expect(saveNewSessionDraft).toHaveBeenCalledTimes(1);
      const [workspace, saved] = saveNewSessionDraft.mock.calls[0]! as [
        string,
        { text: string; model: string; expectedRevision: number },
      ];
      expect(workspace).toBe(DEVELOPMENT);
      // It replaces the message only; the person can still edit or clear it.
      expect(saved.text).toBe(ADD_AGENT_DEFAULT_PROMPT);
      expect(saved.model).toBe("codex/gpt-6-astra");
      expect(saved.expectedRevision).toBe(3);
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: DEVELOPMENT },
      });
    } finally {
      context.client = real;
      await unmount();
    }
  });

  test("when the new chat can't be readied, it says so and stays", async () => {
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(container, "Add it to your product"));
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError.mock.calls[0]![0]).toBe("Couldn't open a new chat");
      expect(navigate).not.toHaveBeenCalled();
      expect(buttonIn(container, "Add it to your product")!.disabled).toBe(false);
    } finally {
      await unmount();
    }
  });

  test("callouts go chat, color, code, tool, ship, each on the person's action", async () => {
    const { container, unmount } = await mount();
    try {
      expect(callout(container)!.dataset.callout).toBe("chat");
      // The question it points at is the first thing on the page, and pulses.
      const questions = container.querySelector('[aria-label="Suggested questions"]')!;
      expect(
        questions.compareDocumentPosition(container.querySelector("[data-playground-product]")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(questions.querySelector("[data-pulse]")!.textContent).toBe("Where is my order #4417?");
      expect(callout(container)!.textContent).toContain("<OpenGeniChat />");
      expect(callout(container)!.textContent).toContain("chat list, new chat");
      await press(
        buttonIn(
          container.querySelector('[aria-label="Suggested questions"]')!,
          "Where is my order #4417?",
        ),
      );
      expect(callout(container)!.dataset.callout).toBe("color");
      // It points at a color to pick, not the one already chosen.
      const next = container.querySelector<HTMLElement>("[data-next-swatch]")!;
      expect(next.getAttribute("aria-checked")).toBe("false");
      // Light/dark alone doesn't move on; a different color does.
      await press(buttonIn(container.querySelector('[aria-label="Theme"]')!, "Light"));
      expect(callout(container)!.dataset.callout).toBe("color");
      await press(container.querySelector<HTMLElement>('[role="radio"][aria-label="Rose"]'));
      expect(callout(container)!.dataset.callout).toBe("code");
      expect(callout(container)!.textContent).toContain("one prop");
      // Nothing moves on by itself.
      await settle(20);
      expect(callout(container)!.dataset.callout).toBe("code");
      await press(buttonIn(callout(container)!, "Next"));

      // Connect a tool: the real in-chat Connect card, then the agent goes on.
      expect(callout(container)!.dataset.callout).toBe("tool");
      expect(callout(container)!.textContent).toContain("connect tools right in the chat");
      const pickup = container.querySelector<HTMLElement>("[data-question='pickup']")!;
      expect(pickup.hasAttribute("data-pulse")).toBe(true);
      await press(pickup);
      const connect = container.querySelector<HTMLAnchorElement>(
        "[data-playground-product] a[href='https://accounts.acme.example/oauth/calendar']",
      )!;
      expect(connect.textContent).toContain("Connect");
      expect(chat(container)).toContain("Connect Calendar");
      await press(connect);
      // The pretend sign-in shows on the card's own button, then the agent goes on.
      expect(connect.dataset.demoConnect).toBe("connected");
      expect(chat(container)).toContain("I've connected my calendar.");
      expect(chat(container)).toContain("Your calendar is free Thursday 10-12");

      expect(callout(container)!.dataset.callout).toBe("ship");
      expect(callout(container)!.textContent).toContain("This opens a new chat with a prompt");
      // The caption steps aside while the callout says it.
      expect(
        Array.from(container.querySelectorAll("p")).find((p) =>
          p.textContent?.startsWith("Opens a new chat"),
        )!.className,
      ).toContain("invisible");
      // No callout offers a way past it; only the header hides the tips.
      expect(callout(container)!.querySelector("button")).toBeNull();
      await press(buttonIn(container.querySelector("header")!, "Hide tips"));
      expect(callout(container)).toBeNull();
      // Hiding is for this visit only, and the tips can come back.
      await press(buttonIn(container.querySelector("header")!, "Show tips"));
      expect(callout(container)!.dataset.callout).toBe("color");
    } finally {
      await unmount();
    }
  });

  test("a new visit starts with the tips again, even after hiding them", async () => {
    const first = await mount();
    expect(callout(first.container)!.querySelector("button")).toBeNull();
    await press(buttonIn(first.container.querySelector("header")!, "Hide tips"));
    expect(callout(first.container)).toBeNull();
    await first.unmount();
    const { container, unmount } = await mount();
    try {
      expect(callout(container)!.dataset.callout).toBe("chat");
    } finally {
      await unmount();
    }
  });

  test("your own brand color", async () => {
    const { container, unmount } = await mount();
    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Your brand color"]',
      )!;
      // Type a brand color, through the input's own change handler.
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
      const onChange = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[
        propsKey
      ]!.onChange;
      await act(async () => onChange({ target: { value: "#ff5a1f" } }));
      await settle();
      const product = container.querySelector<HTMLElement>("[data-playground-product]")!;
      expect(product.style.getPropertyValue("--og-color-accent")).toBe("#ff5a1f");
      expect(marked(container)).toContain('    "--og-color-accent": "#ff5a1f",');
    } finally {
      await unmount();
    }
  });
});
