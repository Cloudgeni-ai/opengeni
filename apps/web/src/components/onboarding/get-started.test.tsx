import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PERSONAL = "00000000-0000-4000-8000-0000000000b1";
const DEVELOPMENT = "00000000-0000-4000-8000-0000000000c1";
const SUBJECT = "user:ada";

let modelReady = false;
let mcpOAuthEnabled = false;
let billingMode: "disabled" | "stripe" = "disabled";
let balanceMicros = 0;
let sessions: unknown[] = [];
const creditsModel = {
  id: "openai/gpt-6-luna",
  label: "GPT-6 Luna",
  source: "opengeni",
  cost: "credits",
  api: "responses",
  policyAllowed: true,
  pricing: { default: { marginBps: 500 } },
  credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
  capabilities: {},
  availability: { status: "available", selectable: false, reason: "no_credits", checkedAt: null },
};
const getBilling = mock(async (_options: { accountId?: string }) => ({
  mode: billingMode,
  balance: { balanceMicros, currency: "usd" },
}));
const createBillingCheckout = mock(async (_request: unknown) => ({
  checkoutSessionId: "cs_1",
  url: "https://checkout.stripe.test/c/cs_1",
}));
const getWorkspaceModelCatalog = mock(async (_workspaceId: string) => ({
  models: [
    {
      id: "codex/gpt-6-luna",
      label: "GPT-6 Luna",
      source: "codex",
      cost: "subscription",
      api: "responses",
      policyAllowed: true,
      credentialReadiness: {
        status: "ready",
        reason: null,
        basis: "configuration",
        checkedAt: null,
      },
      capabilities: {
        reasoning: {
          upstream: "supported",
          runnable: true,
          efforts: ["low"],
          defaultEffort: "low",
          required: false,
        },
      },
      availability: { status: "available", selectable: modelReady, reason: null, checkedAt: null },
    },
    ...(billingMode === "stripe"
      ? [
          // The verified-signup grant (a positive balance) pays for Luna.
          balanceMicros > 0
            ? {
                ...creditsModel,
                capabilities: {
                  reasoning: {
                    upstream: "supported",
                    runnable: true,
                    efforts: ["low", "medium", "high", "xhigh"],
                    defaultEffort: "medium",
                    required: false,
                  },
                },
                availability: {
                  status: "available",
                  selectable: true,
                  reason: null,
                  checkedAt: null,
                },
              }
            : creditsModel,
        ]
      : []),
  ],
  defaultSelection:
    billingMode === "stripe" && balanceMicros > 0
      ? { model: creditsModel.id, reasoningEffort: "xhigh", source: "credits" }
      : modelReady
        ? { model: "codex/gpt-6-luna", reasoningEffort: "low", source: "subscription" }
        : null,
  creditsSelection: null,
}));
const createOrganizationApiKey = mock(async (_organizationId: string, _request: unknown) => ({
  token: "ogk_hello",
  apiKey: { id: "key-1" },
}));
const listSessions = mock(async (_workspaceId: string, _options: unknown) => sessions);
let draftText = "";
const savedDrafts: Array<{
  workspaceId: string;
  text: string;
  resources: unknown[];
  model?: string;
  reasoningEffort?: string;
}> = [];
const getNewSessionDraft = mock(async (_workspaceId: string) => ({
  revision: 3,
  text: draftText,
  resources: [],
  tools: [],
  toolsProvided: false,
  model: "codex/gpt-6-luna",
  reasoningEffort: "low",
  latencyMode: "standard",
  options: {},
  selectionHistory: { projects: [] },
  updatedAt: null,
}));
const saveNewSessionDraft = mock(
  async (
    workspaceId: string,
    request: { text: string; resources: unknown[]; model: string; reasoningEffort: string },
  ) => {
    savedDrafts.push({
      workspaceId,
      text: request.text,
      resources: request.resources,
      ...(request.model === "openai/gpt-6-luna"
        ? { model: request.model, reasoningEffort: request.reasoningEffort }
        : {}),
    });
    return getNewSessionDraft(workspaceId);
  },
);
const createOrganizationWorkspace = mock(
  async (_organizationId: string, request: { name: string }) => {
    context.workspaces = [
      ...context.workspaces,
      { id: DEVELOPMENT, accountId: ORG, kind: "shared", name: request.name },
    ];
    return { id: DEVELOPMENT, name: request.name };
  },
);
const REPOSITORY = {
  id: 4242,
  installationId: 7,
  fullName: "acme/shop",
  name: "shop",
  private: true,
  htmlUrl: "https://github.com/acme/shop",
  cloneUrl: "https://github.com/acme/shop.git",
  defaultBranch: "main",
  accountLogin: "acme",
  accountType: "Organization",
};
function clientConfig() {
  return {
    productAccessMode: "managed",
    auth: { mode: "managedSession" },
    billingMode,
    models: [{ id: "codex/gpt-6-luna", source: "codex" }],
    mcpOAuthEnabled,
  };
}
// Stable objects, like the app's context: hooks refetch when the client changes.
const context = {
  client: {
    getWorkspaceModelCatalog,
    createOrganizationApiKey,
    listSessions,
    getBilling,
    createBillingCheckout,
    getNewSessionDraft,
    saveNewSessionDraft,
    createOrganizationWorkspace,
    connectTransport: () => ({}),
  },
  clientConfig: clientConfig(),
  authSession: { user: { email: "ada@example.test" } },
  accessContext: {
    mode: "managed",
    subjectId: SUBJECT,
    defaultAccountId: ORG,
    defaultWorkspaceId: PERSONAL,
    accountGrants: [
      {
        accountId: ORG,
        subjectId: SUBJECT,
        role: "owner",
        permissions: ["account:admin", "api_keys:manage"],
        metadata: { accountName: "Acme Robotics" },
      },
    ],
    workspaceGrants: [],
  },
  workspaces: [] as Array<{ id: string; accountId: string; kind: string; name: string }>,
  githubStatus: null as unknown,
  githubRepos: [] as unknown[],
  githubCatalogReady: true,
  personalGitHubStatus: null,
  personalGitHubRepositories: [],
  personalGitHubCatalogReady: true,
  connectPersonalGitHub: async () => undefined,
  refreshGitHub: async () => undefined,
  refreshPrincipalAccess: async () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const actualReact = await import("@opengeni/react");
mock.module("@opengeni/react", () => ({
  ...actualReact,
  useWorkspaceSessions: () => ({ sessions: [], pinned: [], loading: false }),
}));
const navigate = mock(async (_options: unknown) => undefined);
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    params,
    search: _search,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: unknown;
  } & Record<string, unknown>) => (
    <a href={to.replace("$workspaceId", params?.workspaceId ?? "")} {...rest}>
      {children}
    </a>
  ),
}));
const toastCalls: Array<{ title: string; action?: { label: string; onClick: () => void } }> = [];
mock.module("sonner", () => ({
  toast: Object.assign(
    (title: string, options?: { action?: { label: string; onClick: () => void } }) =>
      toastCalls.push({ title, ...(options?.action ? { action: options.action } : {}) }),
    { success: () => undefined, error: () => undefined },
  ),
}));

const { GetStartedCard } = await import("./get-started-card");
const { GetStartedRoute } = await import("@/routes/get-started");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const journeys = await import("@/lib/onboarding-journey");
const { takeComposerPrefill, takeComposerSend } = await import("@/lib/composer-prefill");
const { FirstAgentRoute } = await import("@/routes/first-agent");
const firstAgent = await import("@/lib/first-agent");
const { FIRST_TASKS } = await import("@/lib/first-tasks");

const KEY = journeys.onboardingJourneyStorageKey(SUBJECT, ORG);

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
beforeEach(() => {
  localStorage.clear();
  journeys.resetOnboardingJourneysForTests();
  toastCalls.length = 0;
  navigate.mockClear();
  getBilling.mockClear();
  createBillingCheckout.mockClear();
  modelReady = false;
  mcpOAuthEnabled = false;
  billingMode = "disabled";
  balanceMicros = 0;
  sessions = [];
  draftText = "";
  savedDrafts.length = 0;
  createOrganizationWorkspace.mockClear();
  saveNewSessionDraft.mockClear();
  context.githubStatus = null;
  context.githubRepos = [];
  takeComposerSend(PERSONAL);
  takeComposerSend(DEVELOPMENT);
  takeComposerPrefill(PERSONAL);
  takeComposerPrefill(DEVELOPMENT);
  context.clientConfig = clientConfig();
  context.workspaces = [
    { id: PERSONAL, accountId: ORG, kind: "personal", name: "Personal workspace" },
  ];
});

function withDevelopmentWorkspace() {
  context.workspaces = [
    ...context.workspaces,
    { id: DEVELOPMENT, accountId: ORG, kind: "shared", name: "Development" },
  ];
}

async function flush() {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  await flush();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.textContent?.includes(text) || candidate.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

describe("Get started card", () => {
  test("shows nothing without a journey", async () => {
    const { container, unmount } = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />,
    );
    try {
      expect(container.textContent).toBe("");
    } finally {
      await unmount();
    }
  });

  test("lists the path's steps with truthful progress, and first tasks fill the composer", async () => {
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["explore"] }));
    const onPrefill = mock((_text: string) => undefined);
    const { container, unmount } = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={onPrefill} />,
    );
    try {
      expect(container.querySelector("h2")!.textContent).toBe("Get started");
      // Path chosen; no usable model; no chat yet.
      expect(container.textContent).toContain("1 of 5 done");
      expect(container.textContent).toContain("Add credits or connect a model");
      await act(async () => button(container, "Run your first task").click());
      expect(button(container, "Run your first task").getAttribute("aria-expanded")).toBe("true");
      await act(async () => button(container, "Research a decision").click());
      const research = FIRST_TASKS.find((task) => task.id === "research")!;
      expect(onPrefill).toHaveBeenCalledWith(research.kind === "prompt" ? research.prompt : "");
      await act(async () => button(container, "Run your first task").click());
      await act(async () => button(container, "Weekday morning brief").click());
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/schedules/new",
        params: { workspaceId: PERSONAL },
        search: { template: "morning-brief" },
      });
    } finally {
      await unmount();
    }
  });

  test("Hide removes it everywhere until Undo, and says where to find it", async () => {
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["cloud"] }));
    const { container, unmount } = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />,
    );
    try {
      await act(async () => button(container, "Hide Get started").click());
      expect(container.querySelector("[data-get-started-card]")).toBeNull();
      expect(journeys.readOnboardingJourney(KEY)!.checklistDismissed).toBe(true);
      expect(toastCalls.at(-1)!.title).toBe("Get started is hidden");
      await act(async () => toastCalls.at(-1)!.action!.onClick());
      expect(container.querySelector("[data-get-started-card]")).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  test("an invited member is welcomed to the organization without a path question", async () => {
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ invited: true }));
    const { container, unmount } = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />,
    );
    try {
      expect(container.querySelector("h2")!.textContent).toBe("Welcome to Acme Robotics");
      expect(container.textContent).not.toContain("Pick what you want to do");
    } finally {
      await unmount();
    }
  });
});

describe("Get started page", () => {
  test("without an answer, it sends you to Build your first agent", async () => {
    const { container, unmount } = await mount(
      <GetStartedRoute workspaceId={PERSONAL} step={null} />,
    );
    try {
      expect(container.textContent).toContain(
        "Tell us what you're building, and we'll show the steps.",
      );
      expect(
        container.querySelector(`a[href="/workspaces/${PERSONAL}/first-agent"]`)?.textContent,
      ).toBe("Build your first agent");
      expect(container.querySelectorAll('button[role="checkbox"]')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  test("Build: add Opengeni to a coding agent, a one-click key, the prompt, and the app's first chat", async () => {
    modelReady = true;
    withDevelopmentWorkspace();
    journeys.writeOnboardingJourney(
      KEY,
      journeys.newOnboardingJourney({ intents: ["build"], developmentWorkspaceId: DEVELOPMENT }),
    );
    // The demo app chats as one of its own users.
    sessions = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        createdBy: { kind: "subject", subjectId: "external_user:demo" },
      },
    ];
    const { container, unmount } = await mount(
      <GetStartedRoute workspaceId={DEVELOPMENT} step="product" />,
    );
    try {
      expect(container.textContent).toContain("1. Add the Opengeni skills to your coding agent");
      // No hand-written code to paste: tabs per agent, then a prompt.
      expect(container.textContent).not.toContain("@opengeni/sdk/chat");
      expect(
        Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
      ).toEqual(["Claude Code", "Codex", "Cursor", "VS Code", "Other"]);
      // The skills-only developer plugin: no MCP sign-in needed.
      expect(container.textContent).toContain(
        "claude plugin install opengeni-developer@opengeni-developer-plugins --scope user",
      );
      expect(container.textContent).not.toContain("/mcp");
      const prompt = Array.from(container.querySelectorAll("pre")).find((pre) =>
        pre.textContent?.includes("opengeni-client"),
      )!.textContent!;
      expect(prompt).toContain("Use the opengeni-setup and opengeni-client skills");
      expect(prompt).toContain(`workspace ${DEVELOPMENT} in organization ${ORG}`);
      expect(prompt).toContain("I'll paste the API key into .env as OPENGENI_API_KEY.");
      // The chat that app created marks the path's success.
      expect(listSessions).toHaveBeenCalledWith(DEVELOPMENT, { limit: 25 });
      expect(container.textContent).toContain(
        "It worked. Your product's first chat is in Development.",
      );
      expect(container.querySelector('a[href*="/sessions/"]')?.textContent).toBe("Open the chat");
      expect(journeys.readOnboardingJourney(KEY)!.marks.first_api_session).toBeString();
      await act(async () => button(container, "Create API key").click());
      await flush();
      expect(createOrganizationApiKey).toHaveBeenCalledWith(ORG, {
        name: "My first agent",
        description: "Created while building your first agent",
      });
      expect(container.textContent).toContain(
        "Copy this API key now. You won't be able to see it again.",
      );
      expect(container.textContent).toContain(
        "Paste it into your product's .env as OPENGENI_API_KEY.",
      );
      expect(container.textContent).toContain("ogk_hello");
      expect(journeys.readOnboardingJourney(KEY)!.marks.api_key).toBeString();
    } finally {
      await unmount();
    }
  });

  test("where coding agents can sign in, Claude Code also gets the MCP line at user scope", async () => {
    mcpOAuthEnabled = true;
    context.clientConfig = clientConfig();
    withDevelopmentWorkspace();
    journeys.writeOnboardingJourney(
      KEY,
      journeys.newOnboardingJourney({ intents: ["build"], developmentWorkspaceId: DEVELOPMENT }),
    );
    const { container, unmount } = await mount(
      <GetStartedRoute workspaceId={DEVELOPMENT} step="product" />,
    );
    try {
      expect(container.textContent).toContain(
        "claude plugin marketplace add Cloudgeni-ai/opengeni",
      );
      expect(container.textContent).toContain(
        `claude mcp add --scope user --transport http opengeni`,
      );
      expect(container.textContent).toContain("Waiting for your first request");
    } finally {
      await unmount();
    }
  });

  test("Run in the cloud: a first task is prefilled on the new-chat page, not started", async () => {
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["cloud"] }));
    const { container, unmount } = await mount(
      <GetStartedRoute workspaceId={PERSONAL} step={null} />,
    );
    try {
      expect(container.textContent).toContain("Add credits or connect a model");
      expect(container.textContent).not.toContain("Use Opengeni from your coding agent");
      await act(async () => button(container, "Fix an issue in a repo").click());
      const fix = FIRST_TASKS.find((task) => task.id === "fix-issue")!;
      expect(takeComposerPrefill(PERSONAL)).toBe(fix.kind === "prompt" ? fix.prompt : null);
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: PERSONAL },
      });
      // Prefilled isn't done: the step completes once a chat exists.
      expect(journeys.readOnboardingJourney(KEY)!.marks.first_task).toBeUndefined();
    } finally {
      await unmount();
    }
  });

  test("the coding-agent step appears where coding agents can sign in", async () => {
    mcpOAuthEnabled = true;
    context.clientConfig = clientConfig();
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["cloud"] }));
    const { container, unmount } = await mount(
      <GetStartedRoute workspaceId={PERSONAL} step={null} />,
    );
    try {
      expect(container.textContent).toContain("Use Opengeni from your coding agent");
      // Handing work over is the workspace MCP server, signed in with OAuth.
      expect(container.textContent).toContain(
        `claude mcp add --scope user --transport http opengeni ${window.location.origin}/v1/workspaces/${PERSONAL}/mcp`,
      );
      expect(
        Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
      ).toEqual(["Claude Code", "Codex", "Cursor", "VS Code", "Other"]);
    } finally {
      await unmount();
    }
  });
});

describe("Models in Get started", () => {
  test("with nothing paying for models: one item, credits first, then a subscription or key", async () => {
    billingMode = "stripe";
    context.clientConfig = clientConfig();
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["cloud"] }));
    const card = await mount(<GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />);
    try {
      const row = card.container.querySelector<HTMLAnchorElement>('[data-item="model"] a');
      expect(row?.textContent).toContain("Add credits or connect a model");
      expect(row?.getAttribute("href")).toBe(`/workspaces/${PERSONAL}/get-started`);
      expect(card.container.querySelector('[data-item="credits"]')).toBeNull();
    } finally {
      await card.unmount();
    }
    const page = await mount(<GetStartedRoute workspaceId={PERSONAL} step="model" />);
    try {
      await act(async () => button(page.container, "Buy $25 in credits").click());
      await flush();
      expect(createBillingCheckout).toHaveBeenCalledTimes(1);
      expect(page.container.textContent).toContain("Connect a model");
      expect(journeys.readOnboardingJourney(KEY)?.marks.credits_checkout).toBeString();
    } finally {
      await page.unmount();
    }
  });

  test("no model item once credits (the trial grant or bought) or a model pay for chats", async () => {
    journeys.writeOnboardingJourney(KEY, journeys.newOnboardingJourney({ intents: ["build"] }));
    billingMode = "stripe";
    balanceMicros = 10_000_000;
    context.clientConfig = clientConfig();
    const credits = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />,
    );
    try {
      await flush();
      expect(credits.container.querySelector('[data-item="model"]')).toBeNull();
      expect(credits.container.textContent).not.toContain("model");
    } finally {
      await credits.unmount();
    }
    balanceMicros = 0;
    modelReady = true;
    context.clientConfig = clientConfig();
    const ready = await mount(
      <GetStartedCard workspaceId={PERSONAL} onPrefill={() => undefined} />,
    );
    try {
      expect(ready.container.querySelector('[data-item="model"]')).toBeNull();
    } finally {
      await ready.unmount();
    }
  });
});

describe("First run in the app", () => {
  const answers = (overrides: Partial<import("@/lib/first-agent").FirstAgentAnswers>) => ({
    ...firstAgent.EMPTY_FIRST_AGENT,
    ...overrides,
  });

  function radio(container: HTMLElement, title: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
      (candidate) => candidate.textContent?.includes(title),
    );
    if (!found) throw new Error(`Missing choice ${title}`);
    return found;
  }

  async function submit(container: HTMLElement) {
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    await flush();
  }

  async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, value);
      // React's own change handler, as the browser's input event would call it.
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
      (input as unknown as Record<string, { onChange: (event: { target: unknown }) => void }>)[
        propsKey
      ]!.onChange({ target: input });
    });
  }

  function trialGrant() {
    billingMode = "stripe";
    balanceMicros = 10_000_000;
    context.clientConfig = clientConfig();
  }

  function withJourney(firstAgentAnswers: Partial<import("@/lib/first-agent").FirstAgentAnswers>) {
    journeys.writeOnboardingJourney(KEY, {
      ...journeys.newOnboardingJourney({
        intents: firstAgent.intentsForUse(firstAgentAnswers.use ?? null),
        developmentWorkspaceId: context.workspaces.some((w) => w.id === DEVELOPMENT)
          ? DEVELOPMENT
          : null,
      }),
      firstAgent: answers(firstAgentAnswers),
    });
  }

  test("the first question again: a product asks about it, own work goes to the ready moment", async () => {
    for (const [title, step] of [
      ["Add AI agents to my product", "product"],
      ["Use agents for my own work", "ready"],
    ] as const) {
      navigate.mockClear();
      const { container, unmount } = await mount(
        <FirstAgentRoute workspaceId={PERSONAL} step="use" />,
      );
      try {
        expect(container.querySelector("h1")!.textContent).toBe(
          "What do you want to use Opengeni for?",
        );
        // In the app the organization exists: no name to set.
        expect(container.textContent).not.toContain("Rename");
        await act(async () => radio(container, title).click());
        await submit(container);
        expect(navigate).toHaveBeenLastCalledWith({
          to: "/workspaces/$workspaceId/first-agent",
          params: { workspaceId: PERSONAL },
          search: { step },
        });
      } finally {
        await unmount();
      }
    }
    expect(journeys.readOnboardingJourney(KEY)).toMatchObject({
      intents: ["cloud"],
      firstAgent: { use: "work" },
    });
  });

  test("a product: having one sets up Development once; exploring asks nothing more", async () => {
    withJourney({ use: "product" });
    const have = await mount(<FirstAgentRoute workspaceId={PERSONAL} step="product" />);
    try {
      expect(have.container.querySelector("h1")!.textContent).toBe(
        "Do you already have a product?",
      );
      // Option labels only; nothing explains them.
      expect(have.container.querySelectorAll("section p")).toHaveLength(0);
      await act(async () => radio(have.container, "I already have a product").click());
      expect(journeys.readOnboardingJourney(KEY)!.firstAgent.product).toBe("have");
      await submit(have.container);
      expect(createOrganizationWorkspace).toHaveBeenCalledTimes(1);
      expect(journeys.readOnboardingJourney(KEY)!.developmentWorkspaceId).toBe(DEVELOPMENT);
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/workspaces/$workspaceId/first-agent",
        params: { workspaceId: DEVELOPMENT },
        search: { step: "details" },
      });
    } finally {
      await have.unmount();
    }
    const explore = await mount(<FirstAgentRoute workspaceId={PERSONAL} step="product" />);
    try {
      await act(async () => radio(explore.container, "I want to explore first").click());
      await submit(explore.container);
      expect(createOrganizationWorkspace).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/workspaces/$workspaceId/first-agent",
        params: { workspaceId: PERSONAL },
        search: { step: "ready" },
      });
    } finally {
      await explore.unmount();
    }
  });

  test("product answers are kept as you type; Skip goes to the ready moment with them", async () => {
    withDevelopmentWorkspace();
    withJourney({ use: "product", product: "have" });
    const first = await mount(<FirstAgentRoute workspaceId={DEVELOPMENT} step="details" />);
    try {
      // Nothing is required: Continue goes on with every field empty.
      await submit(first.container);
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/workspaces/$workspaceId/first-agent",
        params: { workspaceId: DEVELOPMENT },
        search: { step: "ready" },
      });
      expect(first.container.textContent).not.toContain("Optional");
      // A product isn't always a website: any text is kept.
      await type(first.container.querySelector<HTMLInputElement>("input")!, "Acme for iOS");
      expect(journeys.readOnboardingJourney(KEY)!.firstAgent.website).toBe("Acme for iOS");
      await type(first.container.querySelector<HTMLInputElement>("input")!, "acme.com");
      await act(async () => button(first.container, "Support agent").click());
      expect(first.container.textContent).toContain("GitHub isn't set up on this server.");
    } finally {
      await first.unmount();
    }
    const second = await mount(<FirstAgentRoute workspaceId={DEVELOPMENT} step="details" />);
    try {
      expect(second.container.querySelector<HTMLInputElement>("input")!.value).toBe("acme.com");
      expect(second.container.querySelector("textarea")!.value).toBe(
        firstAgent.FIRST_AGENT_TASKS[0]!.task,
      );
      await act(async () => button(second.container, "Skip").click());
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/workspaces/$workspaceId/first-agent",
        params: { workspaceId: PERSONAL },
        search: { step: "ready" },
      });
      expect(journeys.readOnboardingJourney(KEY)!.firstAgent).toMatchObject({
        website: "acme.com",
        outcome: "skipped",
      });
    } finally {
      await second.unmount();
    }
  });

  test("after Skip, the ready moment celebrates the trial credits and opens a ready composer: Luna at xhigh, the product's prompt unsent", async () => {
    trialGrant();
    withDevelopmentWorkspace();
    withJourney({ use: "product", product: "have", website: "acme.com", outcome: "skipped" });
    const { container, unmount } = await mount(
      <FirstAgentRoute workspaceId={PERSONAL} step="ready" />,
    );
    try {
      await flush();
      expect(container.querySelector("h1")!.textContent).toBe("You got $10 in free credits");
      // No model talk in first run: Luna at xhigh is the silent default.
      expect(container.textContent).not.toContain("Luna");
      expect(container.textContent).not.toContain("USD");
      expect(container.querySelector("[data-confetti]")).not.toBeNull();
      // With the trial grant there is no model choice at all.
      expect(container.textContent).not.toContain("subscription or key");
      expect(container.textContent).not.toContain("Choose how to power your chats");
      expect(container.textContent).not.toContain("Start building");
      await act(async () => button(container, "Start").click());
      await flush();
      expect(savedDrafts).toHaveLength(1);
      expect(savedDrafts[0]).toMatchObject({
        workspaceId: DEVELOPMENT,
        model: "openai/gpt-6-luna",
        reasoningEffort: "xhigh",
      });
      expect(savedDrafts[0]!.text).toContain("- Website: https://acme.com");
      expect(takeComposerSend(DEVELOPMENT)).toBe(false);
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: DEVELOPMENT },
      });
      expect(journeys.readOnboardingJourney(KEY)!.marks.celebrated).toBeString();
    } finally {
      await unmount();
    }
  });

  test("a product with answers: Start building sends the composed prompt with the repository on Luna", async () => {
    trialGrant();
    withDevelopmentWorkspace();
    const { gitHubRepositoryResource } = await import("@/lib/session-tools");
    const chosen = {
      use: "product" as const,
      product: "have" as const,
      website: "acme.com",
      task: "Answer support questions",
      repository: {
        fullName: REPOSITORY.fullName,
        url: REPOSITORY.htmlUrl,
        resource: gitHubRepositoryResource(REPOSITORY as never, "main"),
      },
    };
    withJourney(chosen);
    const { container, unmount } = await mount(
      <FirstAgentRoute workspaceId={DEVELOPMENT} step="ready" />,
    );
    try {
      await flush();
      // Just Start building: the person's own coding agent is set up later, in the app.
      expect(
        Array.from(container.querySelectorAll("section button")).map((b) => b.textContent),
      ).toEqual(["Start building"]);
      await act(async () => button(container, "Start building").click());
      await flush();
      expect(savedDrafts).toEqual([
        {
          workspaceId: DEVELOPMENT,
          text: firstAgent.composeOpengeniPrompt(answers(chosen)),
          resources: [chosen.repository.resource],
          model: "openai/gpt-6-luna",
          reasoningEffort: "xhigh",
        },
      ]);
      expect(takeComposerSend(DEVELOPMENT)).toBe(true);
      expect(journeys.readOnboardingJourney(KEY)!.firstAgent.outcome).toBe("session");
    } finally {
      await unmount();
    }
  });

  test("own work and exploring: the credits, then one Start into a ready composer", async () => {
    trialGrant();
    for (const firstRun of [
      { use: "work" as const },
      { use: "product" as const, product: "explore" as const },
    ]) {
      savedDrafts.length = 0;
      journeys.resetOnboardingJourneysForTests();
      localStorage.clear();
      withJourney(firstRun);
      const { container, unmount } = await mount(
        <FirstAgentRoute workspaceId={PERSONAL} step="ready" />,
      );
      try {
        await flush();
        expect(container.querySelector("h1")!.textContent).toBe("You got $10 in free credits");
        // Just the moment and one way in: the new-chat page has the starters.
        expect(
          Array.from(container.querySelectorAll("section button")).map((b) => b.textContent),
        ).toEqual(["Start"]);
        await act(async () => button(container, "Start").click());
        await flush();
        expect(savedDrafts[0]).toMatchObject({
          workspaceId: PERSONAL,
          text: "",
          model: "openai/gpt-6-luna",
          reasoningEffort: "xhigh",
        });
        expect(takeComposerSend(PERSONAL)).toBe(false);
        expect(navigate).toHaveBeenLastCalledWith({
          to: "/workspaces/$workspaceId/sessions",
          params: { workspaceId: PERSONAL },
        });
      } finally {
        await unmount();
      }
    }
  });

  test("without a trial grant or a model, the model step comes first; then the ready moment, with no amount", async () => {
    withJourney({ use: "work" });
    const { container, unmount } = await mount(
      <FirstAgentRoute workspaceId={PERSONAL} step="ready" />,
    );
    try {
      await flush();
      expect(container.textContent).toContain("Choose how to power your chats");
      expect(container.textContent).not.toContain("free credits");
      await act(async () => button(container, "Skip for now").click());
      await flush();
      expect(container.querySelector("h1")!.textContent).toBe("You're all set");
      expect(container.textContent).not.toContain("$");
    } finally {
      await unmount();
    }
  });
});
