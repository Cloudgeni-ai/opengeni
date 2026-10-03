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

const currentStep = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-step][data-current]")?.dataset.step ?? null;
const step = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-step="${id}"]`)!;
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
const code = (container: HTMLElement) =>
  container.querySelector("[data-slot='line-tabs-content'][data-state='active'] pre")
    ?.textContent ?? "";

describe("playground", () => {
  test("is Acme with the real chat, four steps, and the code beside it", async () => {
    const { container, unmount } = await mount();
    try {
      expect(container.querySelector("h1")!.textContent).toBe("Playground");
      expect(container.textContent).toContain("A recording: no model, nothing saved.");
      // The stock OpenGeniChat: its chat list and new-chat composer.
      expect(chat(container)).toContain("Delivery address");
      expect(container.querySelector("[data-og-new-chat-composer] textarea")).not.toBeNull();
      expect(currentStep(container)).toBe("ask");
      expect(
        Array.from(container.querySelectorAll("[data-step] h2"), (heading) =>
          heading.textContent?.replace(/^Step \d:\s*/u, ""),
        ),
      ).toEqual([
        "Send a message",
        "Click a color to restyle the chat",
        "Turn on tools",
        "Add it to your product",
      ]);
      expect(code(container)).toContain("<OpenGeniChat />");
      expect(container.textContent).toContain("npm i @opengeni/sdk @opengeni/react");
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("ask, restyle, turn on tools, then add it: each step explains what happened", async () => {
    journeys.writeOnboardingJourney(
      journeys.onboardingJourneyStorageKey(SUBJECT, ORG),
      journeys.newOnboardingJourney({ intents: ["build"] }),
    );
    const { container, unmount } = await mount();
    try {
      // 1. Ask: the answer streams into the real conversation. No tools yet.
      await press(buttonIn(step(container, "ask"), "Where is my order #4417?"));
      expect(chat(container)).toContain("Where is my order #4417?");
      expect(chat(container)).toContain("I can't see orders yet.");
      expect(step(container, "ask").textContent).toContain("That's <OpenGeniChat />");
      // Nothing moves on by itself: the step waits for Next.
      expect(currentStep(container)).toBe("ask");
      await press(buttonIn(step(container, "ask"), "Next"));
      expect(currentStep(container)).toBe("style");
      expect(
        journeys.readOnboardingJourney(journeys.onboardingJourneyStorageKey(SUBJECT, ORG))!.marks
          .playground,
      ).toBeString();

      // 2. Restyle: the product's tokens change, and the component file marks
      // the line, right next to <OpenGeniChat />, until the next change.
      await press(container.querySelector<HTMLElement>('[role="radio"][aria-label="Indigo"]'));
      const product = container.querySelector<HTMLElement>("[data-playground-product]")!;
      expect(product.style.getPropertyValue("--og-color-accent")).toBe("#5b4bff");
      expect(container.querySelector("[role='tab'][aria-selected='true']")!.textContent).toBe(
        "Support.jsx",
      );
      expect(code(container)).toContain('"--og-color-accent": "#5b4bff",');
      expect(
        Array.from(
          container.querySelectorAll("[data-state='active'] pre [data-changed]"),
          (line) => line.textContent,
        ),
      ).toEqual([
        '        "--og-color-accent": "#5b4bff",',
        '        "--og-color-primary": "#5b4bff",',
      ]);
      expect(currentStep(container)).toBe("style");
      await press(buttonIn(step(container, "style"), "Next"));
      expect(currentStep(container)).toBe("tools");

      // 3. Tools: new chats get them, and the code gains the MCP server line.
      await press(
        step(container, "tools").querySelector<HTMLElement>(
          '[data-setting="tools"] button[role="switch"]',
        ),
      );
      expect(code(container)).toContain("mcpServers");
      await press(buttonIn(step(container, "tools"), "Ask in a new chat"));
      expect(chat(container)).toContain("out for delivery with UPS");
      expect(step(container, "tools").textContent).toContain("through your MCP server");
      await press(buttonIn(step(container, "tools"), "Next"));
      expect(currentStep(container)).toBe("ship");

      // 4. Add it to your product: a real chat in this workspace that guides them.
      expect(startSession).not.toHaveBeenCalled();
      await press(buttonIn(step(container, "ship"), "Add it to your product"));
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
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("Skip moves on, and Start over resets the steps, style and settings", async () => {
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(step(container, "ask"), "Skip"));
      expect(currentStep(container)).toBe("style");
      expect(
        JSON.parse(localStorage.getItem(`og.playground:v3:${encodeURIComponent(SUBJECT)}:guide`)!),
      ).toEqual({ current: "style", done: ["ask"] });
      await press(container.querySelector<HTMLElement>('[role="radio"][aria-label="Rose"]'));
      await press(buttonIn(container.querySelector("header")!, "Start over"));
      expect(currentStep(container)).toBe("ask");
      expect(
        container
          .querySelector<HTMLElement>("[data-playground-product]")!
          .style.getPropertyValue("--og-color-accent"),
      ).toBe("#1f8f7a");
    } finally {
      await unmount();
    }
  });
});
