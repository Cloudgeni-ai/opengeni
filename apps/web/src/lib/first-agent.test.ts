import { describe, expect, mock, test } from "bun:test";

import {
  composeCodingAgentPrompt,
  composeOpengeniPrompt,
  buildsProduct,
  EMPTY_FIRST_AGENT,
  firstChatModel,
  hasProductDetails,
  intentsForUse,
  normalizeWebsite,
  useForIntents,
  parseFirstAgentAnswers,
  writeFirstChatDraft,
  type FirstAgentAnswers,
} from "./first-agent";

const repository = {
  fullName: "acme/shop",
  url: "https://github.com/acme/shop",
  resource: {
    kind: "repository" as const,
    uri: "https://github.com/acme/shop.git",
    ref: "main",
    githubRepositoryId: 1,
    githubInstallationId: 2,
  },
};
const answers = (overrides: Partial<FirstAgentAnswers>): FirstAgentAnswers => ({
  ...EMPTY_FIRST_AGENT,
  use: "product",
  product: "have",
  ...overrides,
});
const target = {
  apiOrigin: "https://app.opengeni.ai",
  organizationId: "org-1",
  workspaceId: "ws-dev",
};

describe("first agent answers", () => {
  test("websites become absolute http(s) URLs; anything else is not one", () => {
    expect(normalizeWebsite("acme.com")).toBe("https://acme.com");
    expect(normalizeWebsite(" https://www.acme.com/pricing/ ")).toBe(
      "https://www.acme.com/pricing",
    );
    expect(normalizeWebsite("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeWebsite("")).toBeNull();
    expect(normalizeWebsite("not a site")).toBeNull();
    expect(normalizeWebsite("acme")).toBeNull();
    expect(normalizeWebsite("javascript:alert(1)")).toBeNull();
    expect(hasProductDetails(answers({ website: "acme" }))).toBe(false);
    expect(hasProductDetails(answers({ repository }))).toBe(true);
  });

  test("the answer maps to the Get started paths and back", () => {
    expect(intentsForUse("product")).toEqual(["build"]);
    expect(intentsForUse("work")).toEqual(["cloud"]);
    expect(intentsForUse(null)).toEqual([]);
    expect(useForIntents(["build", "cloud"])).toBe("product");
    expect(useForIntents(["explore"])).toBe("work");
    expect(useForIntents([])).toBeNull();
    // Only a product with a website or repository is what the first chat builds.
    expect(buildsProduct(answers({ website: "acme.com" }))).toBe(true);
    expect(buildsProduct(answers({ website: "acme.com", product: "explore" }))).toBe(false);
    expect(buildsProduct(answers({}))).toBe(false);
  });

  test("stored answers keep only our shape", () => {
    expect(parseFirstAgentAnswers(null)).toEqual(EMPTY_FIRST_AGENT);
    expect(
      parseFirstAgentAnswers({
        use: "nonsense",
        product: "explore",
        website: 42,
        repository: { fullName: "acme/shop", url: "https://github.com/acme/shop", resource: {} },
        builder: "own",
        outcome: "session",
      }),
    ).toEqual({
      ...EMPTY_FIRST_AGENT,
      product: "explore",
      repository: { fullName: "acme/shop", url: "https://github.com/acme/shop", resource: null },
      builder: "own",
      outcome: "session",
    });
  });

  test("the Opengeni prompt has the product, attaches the repository and asks to inspect, propose and implement", () => {
    const prompt = composeOpengeniPrompt(
      answers({ website: "acme.com", repository, task: "Answer support questions" }),
    );
    expect(prompt).toContain("- Website: https://acme.com");
    expect(prompt).toContain("- Code: acme/shop on GitHub (attached to this chat)");
    expect(prompt).toContain("- What the agent should do: Answer support questions");
    expect(prompt).toContain("look at the website and the repository");
    expect(prompt).toContain("propose two or three ways the agent could work");
    expect(prompt).toContain("implement the integration in the repository on a new branch");
    expect(prompt).toContain("open a pull request");
  });

  test("without a repository or a task, the Opengeni prompt asks for what it needs", () => {
    const prompt = composeOpengeniPrompt(answers({ website: "acme.com" }));
    expect(prompt).not.toContain("- Code:");
    expect(prompt).toContain("- What the agent should do: not decided yet");
    expect(prompt).toContain("propose two or three places an agent would help most");
    expect(prompt).toContain("tell me what to connect so you can implement it");
    // A repository from the person's own GitHub is named, not attached.
    expect(
      composeOpengeniPrompt(answers({ repository: { ...repository, resource: null } })),
    ).toContain("- Code: acme/shop on GitHub\n");
  });

  test("the coding-agent prompt names the developer skills, the product and this workspace", () => {
    const prompt = composeCodingAgentPrompt(
      answers({ website: "acme.com", repository, task: "Answer support questions" }),
      target,
    );
    expect(prompt.split("\n")[0]).toBe(
      "Use the opengeni-setup and opengeni-client skills to add an Opengeni agent to my product.",
    );
    expect(prompt).toContain("- Code: acme/shop (https://github.com/acme/shop)");
    expect(prompt).toContain("Use the existing workspace ws-dev in organization org-1.");
    expect(prompt).not.toContain("OPENGENI_API_BASE_URL");
    expect(prompt).toContain("OPENGENI_API_KEY; never put it in client code");
    expect(
      composeCodingAgentPrompt(answers({ website: "acme.com" }), {
        ...target,
        apiOrigin: "http://homeserver:8000",
      }),
    ).toContain("(OPENGENI_API_BASE_URL=http://homeserver:8000)");
  });

  test("first chats start on GPT-6 Luna at extra high reasoning when credits pay for it", () => {
    const luna = (overrides: Record<string, unknown>) => ({
      id: "openai/gpt-6-luna",
      label: "GPT-6 Luna",
      cost: "credits",
      availability: { selectable: true },
      capabilities: {
        reasoning: { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      },
      ...overrides,
    });
    expect(firstChatModel({ models: [luna({})] } as never)).toEqual({
      id: "openai/gpt-6-luna",
      reasoningEffort: "xhigh",
    });
    // No credits to pay for it, or not Luna on credits: keep the default.
    expect(
      firstChatModel({ models: [luna({ availability: { selectable: false } })] } as never),
    ).toBeNull();
    // A connected subscription that offers Luna (Codex) runs it when credits can't.
    expect(
      firstChatModel({
        models: [
          luna({ availability: { selectable: false } }),
          luna({ id: "codex/gpt-6-luna", cost: "subscription" }),
        ],
      } as never),
    ).toEqual({ id: "codex/gpt-6-luna", reasoningEffort: "xhigh" });
    // Credits first when both can.
    expect(
      firstChatModel({
        models: [luna({ id: "codex/gpt-6-luna", cost: "subscription" }), luna({})],
      } as never)?.id,
    ).toBe("openai/gpt-6-luna");
    expect(
      firstChatModel({
        models: [
          luna({
            id: "codex/gpt-6-luna",
            cost: "subscription",
            availability: { selectable: false },
          }),
        ],
      } as never),
    ).toBeNull();
  });

  test("the first chat's draft gets Luna, the message and the repository, but never replaces typed text", async () => {
    const draft = {
      revision: 7,
      text: "",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "m",
      reasoningEffort: "low" as const,
      latencyMode: "standard" as const,
      options: {},
      selectionHistory: { projects: [] },
      updatedAt: null,
    };
    const saveNewSessionDraft = mock(async (_workspaceId: string, _request: unknown) => draft);
    const lunaCatalog = {
      models: [
        {
          id: "openai/gpt-6-luna",
          cost: "credits",
          availability: { selectable: true },
          capabilities: { reasoning: { efforts: ["low", "xhigh"], defaultEffort: "low" } },
        },
      ],
    };
    const client = (text: string, catalog: unknown = { models: [] }) => ({
      getNewSessionDraft: async () => ({ ...draft, text }),
      getWorkspaceModelCatalog: async () => catalog,
      saveNewSessionDraft,
    });
    expect(
      await writeFirstChatDraft(client("", lunaCatalog) as never, "ws", "Hello", {
        repository: repository.resource,
      }),
    ).toBe(true);
    expect(saveNewSessionDraft.mock.calls[0]![1]).toMatchObject({
      text: "Hello",
      resources: [repository.resource],
      expectedRevision: 7,
      model: "openai/gpt-6-luna",
      reasoningEffort: "xhigh",
      modelProvided: true,
    });
    // Typed text stays; Luna is still selected.
    expect(await writeFirstChatDraft(client("Mine", lunaCatalog) as never, "ws", "Hello")).toBe(
      false,
    );
    expect(saveNewSessionDraft.mock.calls[1]![1]).toMatchObject({
      text: "Mine",
      model: "openai/gpt-6-luna",
    });
    // Nothing to write and no Luna: the draft is left alone.
    expect(await writeFirstChatDraft(client("Mine") as never, "ws", "Hello")).toBe(false);
    expect(await writeFirstChatDraft(client("") as never, "ws", null)).toBe(false);
    expect(saveNewSessionDraft).toHaveBeenCalledTimes(2);
    // An earlier prompt from this page is replaced; a started chat replaces anything.
    expect(
      await writeFirstChatDraft(
        client("I want to add an AI agent to my product with Opengeni.\nold") as never,
        "ws",
        "Hello",
      ),
    ).toBe(true);
    expect(
      await writeFirstChatDraft(client("Mine") as never, "ws", "Hello", { replace: true }),
    ).toBe(true);
    expect(saveNewSessionDraft.mock.calls.at(-1)![1]).toMatchObject({ text: "Hello", model: "m" });
  });
});
