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
const startSession = mock(
  async (_workspaceId: string, _submission: unknown, _options: unknown) => ({
    id: "00000000-0000-4000-8000-0000000000f1",
  }),
);
const navigate = mock(async (_to: unknown) => undefined);
const context = {
  client,
  busy: false,
  startSession,
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
// The dialog primitive has its own tests; here it only has to open.
mock.module("@/components/ui/dialog", () => {
  const Pass = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div data-ship-preview={"data-ship-preview" in rest ? "" : undefined}>{children}</div>
  );
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  };
});
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
const journeys = await import("@/lib/onboarding-journey");

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
  journeys.resetOnboardingJourneysForTests();
  unexpected.mockClear();
  startSession.mockClear();
  navigate.mockClear();
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
  test("is one screen: Acme with the real chat, two questions, the snippet, one button", async () => {
    const { container, unmount } = await mount();
    try {
      expect(container.querySelector("h1")!.textContent).toBe("Playground");
      expect(container.textContent).toContain("Try a color");
      // The stock OpenGeniChat: its chat list and new-chat composer.
      expect(chat(container)).toContain("Delivery address");
      expect(container.querySelector("[data-og-new-chat-composer] textarea")).not.toBeNull();
      expect(container.querySelectorAll('[aria-label="Suggested questions"] button').length).toBe(
        2,
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
        "Opens a chat where an agent adds it to your product with you.",
      );
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("a question plays in the real chat with Acme's tool, without calling the API", async () => {
    journeys.writeOnboardingJourney(
      journeys.onboardingJourneyStorageKey(SUBJECT, ORG),
      journeys.newOnboardingJourney({ intents: ["build"] }),
    );
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
      expect(
        journeys.readOnboardingJourney(journeys.onboardingJourneyStorageKey(SUBJECT, ORG))!.marks
          .playground,
      ).toBeString();
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

  test("Add it to your product starts a guided chat in this workspace", async () => {
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(container, "Add it to your product"));
      expect(startSession).toHaveBeenCalledTimes(1);
      const [workspace, submission, options] = startSession.mock.calls[0]!;
      expect(workspace).toBe(DEVELOPMENT);
      expect(submission).toEqual({ text: ADD_AGENT_DEFAULT_PROMPT });
      expect((options as { instructions: string }).instructions).toContain(
        "read the opengeni-client Skill",
      );
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId: DEVELOPMENT, sessionId: "00000000-0000-4000-8000-0000000000f1" },
      });
    } finally {
      await unmount();
    }
  });

  test("callouts go chat, color, code, ship, each on the person's action", async () => {
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
      await press(container.querySelector<HTMLElement>('[role="radio"][aria-label="Rose"]'));
      expect(callout(container)!.dataset.callout).toBe("code");
      expect(callout(container)!.textContent).toContain("one prop");
      // Nothing moves on by itself.
      await settle(20);
      expect(callout(container)!.dataset.callout).toBe("code");
      await press(buttonIn(callout(container)!, "Next"));
      expect(callout(container)!.dataset.callout).toBe("ship");
      expect(callout(container)!.textContent).toContain("This opens a chat where an agent");
      // The caption steps aside while the callout says it.
      expect(
        Array.from(container.querySelectorAll("p")).find((p) =>
          p.textContent?.startsWith("Opens a chat"),
        )!.className,
      ).toContain("invisible");
      await press(buttonIn(callout(container)!, "Skip"));
      expect(callout(container)).toBeNull();
      // Skip is for this visit only, and the tips can come back.
      await press(buttonIn(container.querySelector("header")!, "Show tips"));
      expect(callout(container)!.dataset.callout).toBe("color");
    } finally {
      await unmount();
    }
  });

  test("a new visit starts with the tips again, even after Skip", async () => {
    const first = await mount();
    await press(buttonIn(callout(first.container)!, "Skip"));
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

  test("without a workspace to start chats in, it shows how the chat opens", async () => {
    const real = context.startSession;
    (context as { startSession?: unknown }).startSession = undefined;
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(container, "Add it to your product"));
      const dialog = document.querySelector("[data-ship-preview]")!;
      expect(dialog.textContent).toContain("A chat like this opens");
      expect(dialog.textContent).toContain(ADD_AGENT_DEFAULT_PROMPT);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      context.startSession = real;
      await unmount();
    }
  });
});
