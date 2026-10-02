import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const context = {
  accessContext: { subjectId: "user:ada", defaultAccountId: "org-1" },
  workspaces: [{ id: "ws-1", accountId: "org-1" }],
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { useFirstRunStarters } = await import("./first-run-starters");
const journeys = await import("./onboarding-journey");
const { EMPTY_FIRST_AGENT } = await import("./first-agent");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function starters() {
  let result: ReturnType<typeof useFirstRunStarters> | null = null;
  function Probe() {
    result = useFirstRunStarters("ws-1");
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  return result!;
}

test("the starter set follows the saved first-run answer; the default is general", async () => {
  const key = journeys.onboardingJourneyStorageKey("user:ada", "org-1");
  journeys.resetOnboardingJourneysForTests();
  localStorage.clear();
  expect(await starters()).toEqual({ set: "general", productPrompt: null });
  for (const [firstAgent, expected] of [
    [{ use: "work" }, { set: "general", productPrompt: null }],
    [
      { use: "product", product: "explore" },
      { set: "product", productPrompt: null },
    ],
  ] as const) {
    journeys.writeOnboardingJourney(key, {
      ...journeys.newOnboardingJourney(),
      firstAgent: { ...EMPTY_FIRST_AGENT, ...firstAgent },
    });
    expect(await starters()).toEqual(expected);
  }
  journeys.writeOnboardingJourney(key, {
    ...journeys.newOnboardingJourney(),
    firstAgent: { ...EMPTY_FIRST_AGENT, use: "product", product: "have", website: "acme.com" },
  });
  const product = await starters();
  expect(product.set).toBe("product");
  expect(product.productPrompt).toContain("- Website: https://acme.com");
});
