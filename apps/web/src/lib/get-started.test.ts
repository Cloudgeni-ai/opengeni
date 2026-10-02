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

  test("Buy credits appears while nothing pays for models, and only when it is true", () => {
    const credits = (overrides: Partial<GetStartedFacts>) =>
      getStartedItems(facts({ journey: journey({ intents: ["build"] }), ...overrides })).find(
        (item) => item.id === "credits",
      );
    const empty = { balanceMicros: 0, currency: "USD" };
    // No model, no balance, credits sold: buy them.
    expect(credits({ credits: { canBuy: true, balance: empty, margin: "5%" } })).toMatchObject({
      title: "Buy Opengeni credits",
      description: "Pay as you go: the model provider's price plus 5%. No provider account needed.",
      done: false,
    });
    // Someone without billing:manage is told who can.
    expect(credits({ credits: { canBuy: false, balance: empty, margin: "5%" } })?.description).toBe(
      "Ask an organization owner to add credits.",
    );
    // Not on a server without Stripe, not with a model, not with a balance,
    // and not when the balance can't be read.
    expect(credits({ credits: null })).toBeUndefined();
    expect(
      credits({
        model: { ready: true, label: "GPT-6 Luna · Your ChatGPT plan" },
        credits: { canBuy: true, balance: empty, margin: null },
      }),
    ).toBeUndefined();
    expect(
      credits({
        credits: {
          canBuy: true,
          balance: { balanceMicros: 5_000_000, currency: "USD" },
          margin: null,
        },
      }),
    ).toBeUndefined();
    expect(credits({ credits: { canBuy: true, balance: null, margin: null } })).toBeUndefined();
    // A checkout started here keeps the step, done once the balance lands.
    expect(
      getStartedItems(
        facts({
          journey: journey({
            intents: ["build"],
            marks: { credits_checkout: "2026-10-01T08:00:00.000Z" },
          }),
          model: { ready: true, label: "GPT-6 Luna · Opengeni credits" },
          credits: {
            canBuy: true,
            balance: { balanceMicros: 25_000_000, currency: "USD" },
            margin: "5%",
          },
        }),
      ).find((item) => item.id === "credits"),
    ).toMatchObject({
      title: "You have Opengeni credits",
      description: "$25.00 left.",
      done: true,
    });
  });

  test("the model step names only what this server offers", () => {
    const model = (overrides: Partial<GetStartedFacts>) =>
      getStartedItems(facts(overrides)).find((item) => item.id === "model")!.description;
    const credits = { canBuy: true, balance: null, margin: null };
    expect(model({ journey: journey({ intents: ["build"] }), credits })).toBe(
      "Buy Opengeni credits, or use your ChatGPT plan or your own key.",
    );
    expect(model({ journey: journey({ intents: ["cloud"] }), credits })).toBe(
      "Use your ChatGPT plan, or buy Opengeni credits.",
    );
    expect(model({ journey: journey({ intents: ["cloud"] }), credits: null })).toBe(
      "Use your ChatGPT plan, or another subscription or key.",
    );
    expect(model({ credits: null, codexEnabled: false })).toBe(
      "Connect a subscription or your own key.",
    );
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
    expect(loading.find((item) => item.id === "model")!.done).toBeNull();
    expect(loading.find((item) => item.id === "first_task")!.done).toBeNull();
    expect(getStartedProgress(loading)).toEqual({ done: 1, total: 5 });

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
    expect(ready.find((item) => item.id === "model")).toMatchObject({
      done: true,
      title: "Your agents have a model",
      description: "GPT-6 Luna · Your ChatGPT plan",
    });
    expect(getStartedProgress(ready)).toEqual({ done: 5, total: 5 });
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
