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
const client = new Proxy(
  {},
  {
    get: () => unexpected,
  },
);
const context = {
  client,
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
  Link: ({
    children,
    to: _to,
    params: _params,
    search: _search,
    ...rest
  }: { children: ReactNode; to?: unknown; params?: unknown; search?: unknown } & Record<
    string,
    unknown
  >) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

const { PlaygroundRoute } = await import("./playground");
const journeys = await import("@/lib/onboarding-journey");

const realSetTimeout = globalThis.setTimeout;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Play the recording (and the tour's pauses) without waiting for it.
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
});

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => await new Promise((resolve) => realSetTimeout(resolve, 5)));
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<PlaygroundRoute workspaceId={DEVELOPMENT} />));
  await settle(1);
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const coach = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-coach-mark]");
const buttonIn = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes(text),
  );
async function press(button: HTMLButtonElement | undefined) {
  if (!button) throw new Error("Missing button");
  await act(async () => button.click());
  await settle();
}

describe("playground", () => {
  test("is Acme with a recorded chat, labelled as a demo, and no model gate", async () => {
    const { container, unmount } = await mount();
    try {
      expect(container.querySelector("h1")!.textContent).toBe("Playground");
      expect(container.textContent).toContain("Hi Ada, how can we help?");
      expect(container.textContent).toContain("This is a recorded demo.");
      expect(container.textContent).not.toContain("Connect a model");
      // Questions to pick, not a box to type into.
      expect(container.querySelector("textarea")).toBeNull();
      expect(
        Array.from(
          container.querySelectorAll('[aria-label="Suggested questions"] button'),
          (button) => button.textContent,
        ),
      ).toEqual(["Where is my order #4417?", "I was charged twice this month"]);
      expect(coach(container)!.dataset.coachMark).toBe("send");
      expect(coach(container)!.textContent).toContain("Step 1 of 6");
      expect(container.querySelector("[data-tour='palette']")).toBeNull();
    } finally {
      await unmount();
    }
  });

  test("a question plays in the real timeline without calling the API", async () => {
    journeys.writeOnboardingJourney(
      journeys.onboardingJourneyStorageKey(SUBJECT, ORG),
      journeys.newOnboardingJourney({ intents: ["build"] }),
    );
    const { container, unmount } = await mount();
    try {
      await press(
        buttonIn(
          container.querySelector('[aria-label="Suggested questions"]')!,
          "Where is my order",
        ),
      );
      const chat = container.querySelector("[data-tour='chat']")!;
      expect(chat.textContent).toContain("Where is my order #4417?");
      expect(chat.textContent).toContain("out for delivery");
      expect(unexpected).not.toHaveBeenCalled();
      // Watching it stream is the playground's checklist step.
      expect(
        journeys.readOnboardingJourney(journeys.onboardingJourneyStorageKey(SUBJECT, ORG))!.marks
          .playground,
      ).toBeString();
    } finally {
      await unmount();
    }
  });

  test("the tour walks through streaming, style, memory in a new chat, tools and the next step", async () => {
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(coach(container)!, "Where is my order"));
      // The answer streamed; the tour moved to restyling.
      expect(coach(container)!.dataset.coachMark).toBe("style");
      await press(buttonIn(coach(container)!, "Skip"));
      expect(coach(container)!.dataset.coachMark).toBe("memory");
      await press(buttonIn(coach(container)!, "Remember that my plan is Pro."));
      const chat = () => container.querySelector("[data-tour='chat']")!.textContent ?? "";
      expect(chat()).toContain("I'll remember that you're on the Pro plan.");
      expect(coach(container)!.dataset.coachMark).toBe("ask");
      await press(buttonIn(coach(container)!, "What plan did I tell you I'm on?"));
      // A new chat: the earlier exchange is gone, the answer comes from memory.
      expect(chat()).not.toContain("Remember that my plan is Pro.");
      expect(chat()).toContain("You told me you're on the Pro plan.");
      expect(coach(container)!.dataset.coachMark).toBe("tool");
      await press(buttonIn(coach(container)!, "Ask for a refund"));
      expect(chat()).toContain("I refunded the duplicate $49 charge.");
      expect(coach(container)!.dataset.coachMark).toBe("finish");
      expect(coach(container)!.textContent).toContain("Add it to your product");
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  test("Skip tour hides the coach marks and offers every question; Restart tour starts over", async () => {
    const { container, unmount } = await mount();
    try {
      await press(buttonIn(container.querySelector("header")!, "Skip tour"));
      expect(coach(container)).toBeNull();
      expect(
        JSON.parse(localStorage.getItem(`og.playground:v2:${encodeURIComponent(SUBJECT)}:tour`)!),
      ).toMatchObject({ step: null });
      expect(container.querySelectorAll('[aria-label="Suggested questions"] button').length).toBe(
        4,
      );
      expect(
        container.querySelector("[data-tour='palette'], [data-tour='palette-toggle']"),
      ).not.toBeNull();
      await press(buttonIn(container.querySelector("header")!, "Restart tour"));
      expect(coach(container)!.dataset.coachMark).toBe("send");
    } finally {
      await unmount();
    }
  });
});
