import { describe, expect, test } from "bun:test";

import {
  getStartedItems,
  getStartedProgress,
  nextGetStartedItem,
  type GetStartedFacts,
} from "./get-started";
import { newOnboardingJourney, type OnboardingJourney } from "./onboarding-journey";

function facts(overrides: Partial<GetStartedFacts> = {}): GetStartedFacts {
  return {
    journey: newOnboardingJourney({ intents: ["explore"] }),
    model: { ready: false, label: null },
    canManageModels: true,
    hasSession: false,
    canCreateApiKeys: true,
    githubConnected: false,
    githubAvailable: true,
    codingAgentAvailable: true,
    ...overrides,
  };
}

function journey(overrides: Partial<OnboardingJourney>): OnboardingJourney {
  return { ...newOnboardingJourney(), ...overrides };
}

const ids = (input: GetStartedFacts) => getStartedItems(input).map((item) => item.id);

describe("Get started checklist", () => {
  test("each path lists its own steps, in the order to do them", () => {
    // Build's product step adds Opengeni to the coding agent itself.
    expect(ids(facts({ journey: journey({ intents: ["build"] }) }))).toEqual([
      "path",
      "model",
      "api_key",
      "playground",
    ]);
    expect(ids(facts({ journey: journey({ intents: ["cloud"] }) }))).toEqual([
      "path",
      "model",
      "github",
      "first_task",
      "coding_agent",
    ]);
    expect(ids(facts({ journey: journey({ intents: ["explore"] }) }))).toEqual([
      "path",
      "model",
      "first_task",
      "playground",
      "api_key",
    ]);
    // Without the product step, the coding-agent step stands on its own.
    expect(
      ids(facts({ journey: journey({ intents: ["explore"] }), canCreateApiKeys: false })),
    ).toEqual(["path", "model", "first_task", "playground", "coding_agent"]);
  });

  test("Build and cloud together list both paths' steps once", () => {
    expect(ids(facts({ journey: journey({ intents: ["build", "cloud"] }) }))).toEqual([
      "path",
      "model",
      "api_key",
      "playground",
      "github",
      "first_task",
    ]);
    const path = getStartedItems(facts({ journey: journey({ intents: ["build", "cloud"] }) }))[0]!;
    expect(path).toMatchObject({
      done: true,
      description: "Adding agents to your product and the cloud",
    });
  });

  test("the first step is Build your first agent, summarizing what was entered", () => {
    const first = (overrides: Partial<OnboardingJourney>) =>
      getStartedItems(facts({ journey: journey(overrides) }))[0]!;
    expect(first({ intents: [] })).toMatchObject({
      id: "path",
      title: "Build your first agent",
      done: false,
      description: "Tell us about your product, or explore what agents can do.",
    });
    const answers = newOnboardingJourney().firstAgent;
    expect(
      first({
        intents: ["build"],
        firstAgent: {
          ...answers,
          use: "product",
          product: "have",
          website: "www.acme.com/pricing",
        },
      }),
    ).toMatchObject({ done: true, description: "Agent for acme.com" });
    expect(
      first({
        intents: ["build"],
        firstAgent: {
          ...answers,
          use: "product",
          product: "have",
          website: "acme.com",
          outcome: "session",
        },
      }).description,
    ).toBe("Agent for acme.com · Opengeni is building it");
    expect(
      first({ intents: ["build"], firstAgent: { ...answers, use: "product", builder: "own" } })
        .description,
    ).toBe("Adding agents to your product · Your coding agent builds it");
    expect(first({ intents: ["cloud"], firstAgent: { ...answers, use: "work" } }).description).toBe(
      "Agents for your own work",
    );
    expect(
      first({ intents: ["build"], firstAgent: { ...answers, use: "product", product: "explore" } })
        .description,
    ).toBe("Exploring agents for your product");
    // The recorded playground is optional now.
    expect(
      getStartedItems(facts({ journey: journey({ intents: ["build"] }) })).find(
        (item) => item.id === "playground",
      )?.optional,
    ).toBe(true);
  });

  test("no model step while anything pays for models; one fallback item when nothing does", () => {
    const model = (overrides: Partial<GetStartedFacts>) =>
      getStartedItems(facts({ journey: journey({ intents: ["build"] }), ...overrides })).find(
        (item) => item.id === "model",
      );
    const empty = { balanceMicros: 0, currency: "USD" };
    const trial = { balanceMicros: 10_000_000, currency: "USD" };
    // Nothing pays: one clear item, so nobody is stuck.
    expect(model({ credits: { canBuy: true, balance: empty, margin: "5%" } })).toMatchObject({
      title: "Add credits or connect a model",
      description: "Buy Opengeni credits, or use a subscription or your own key.",
      done: false,
    });
    expect(model({ credits: null })?.description).toBe("Use a subscription or your own key.");
    expect(model({ canManageModels: false, credits: null })?.description).toBe(
      "Only organization owners and admins can add models. Ask one to connect a model.",
    );
    // Credits (the trial grant or bought), or any usable model: no item at all.
    expect(model({ credits: { canBuy: true, balance: trial, margin: null } })).toBeUndefined();
    expect(
      model({ model: { ready: true, label: "GPT-6 Luna · Opengeni credits" } }),
    ).toBeUndefined();
    // Still loading: nothing shown rather than a wrong item.
    expect(model({ model: null })).toBeUndefined();
    expect(getStartedItems(facts({})).some((item) => item.id === ("credits" as never))).toBe(false);
  });

  test("hides what this person or this deployment can't do", () => {
    // No API keys for people who can't create them, no GitHub where it's off,
    // no coding-agent step where neither OAuth nor a key can reach a workspace.
    expect(
      ids(
        facts({
          journey: journey({ intents: ["cloud"] }),
          githubAvailable: false,
          codingAgentAvailable: false,
        }),
      ),
    ).toEqual(["path", "model", "first_task"]);
    expect(
      ids(facts({ journey: journey({ intents: ["build"] }), canCreateApiKeys: false })),
    ).toEqual(["path", "model", "playground", "coding_agent"]);
  });

  test("an invited member gets a lighter list without the path question", () => {
    const items = getStartedItems(
      facts({
        journey: journey({ invited: true }),
        canManageModels: false,
        canCreateApiKeys: false,
        codingAgentAvailable: false,
      }),
    );
    expect(items.map((item) => item.id)).toEqual(["model", "first_task", "playground"]);
    expect(items[0]!.description).toBe(
      "Only organization owners and admins can add models. Ask one to connect a model.",
    );
  });

  test("done states come from live facts and marks, and unknown is never done", () => {
    const loading = getStartedItems(facts({ model: null, hasSession: null }));
    expect(loading.find((item) => item.id === "model")).toBeUndefined();
    expect(loading.find((item) => item.id === "first_task")!.done).toBeNull();
    expect(getStartedProgress(loading)).toEqual({ done: 1, total: 4 });

    const ready = getStartedItems(
      facts({
        model: { ready: true, label: "GPT-6 Luna · Your ChatGPT plan" },
        hasSession: true,
        journey: journey({
          intents: ["explore"],
          marks: {
            playground: "2026-10-01T08:00:00.000Z",
            first_api_session: "2026-10-01T08:01:00.000Z",
          },
        }),
      }),
    );
    expect(ready.find((item) => item.id === "model")).toBeUndefined();
    expect(getStartedProgress(ready)).toEqual({ done: 4, total: 4 });
    expect(nextGetStartedItem(ready)).toBeNull();
  });

  test("a skipped GitHub step counts as handled but still says it can be connected", () => {
    const github = getStartedItems(
      facts({
        journey: journey({
          intents: ["cloud"],
          marks: { github_skipped: "2026-10-01T08:00:00.000Z" },
        }),
      }),
    ).find((item) => item.id === "github")!;
    expect(github).toMatchObject({ done: true, optional: true });
    expect(github.description).toBe("Skipped. Connect it any time.");
  });

  test("the product step is done only when the app's first chat arrives", () => {
    const step = (marks: OnboardingJourney["marks"]) =>
      getStartedItems(facts({ journey: journey({ intents: ["build"], marks }) })).find(
        (item) => item.id === "api_key",
      )!;
    expect(step({}).done).toBe(false);
    expect(step({ api_key: "2026-10-01T08:00:00.000Z" })).toMatchObject({
      done: false,
      description: "Your key is ready. Ask your coding agent to build the app.",
    });
    expect(step({ first_api_session: "2026-10-01T08:00:00.000Z" }).done).toBe(true);
  });
});
