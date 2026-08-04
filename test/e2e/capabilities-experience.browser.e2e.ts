import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000217";
const accountId = "00000000-0000-4000-8000-000000000218";
const subjectId = "capabilities-experience-subject";
const apiContractRevision = "2026-07-workspace-artifacts-v1";
const evidenceDir = new URL("../../.agent/evidence/capabilities-redesign/", import.meta.url)
  .pathname;

type JsonRecord = Record<string, unknown>;

type ExperienceState = {
  items: JsonRecord[];
  connections: JsonRecord[];
  catalogDelayMs?: number;
  catalogError?: boolean;
};

describe("capabilities experience browser e2e", () => {
  let browser: Browser;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    await mkdir(evidenceDir, { recursive: true });
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--port",
        String(webPort),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        env: { VITE_API_BASE_URL: "http://127.0.0.1:9" },
        ready: async () =>
          (
            await fetch(webBaseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = existsSync("/usr/local/bin/chromium")
      ? "/usr/local/bin/chromium"
      : undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("desktop lifecycle views stay compact, searchable, scoped, and accessible at 637 items", async () => {
    const state = connectedExperienceState();
    expect(state.items).toHaveLength(637);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await installExperienceApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      await expectVisible(page.getByRole("heading", { name: "What agents can use now" }));
      await expectText(
        page.getByRole("region", { name: "Capabilities", exact: true }),
        "Needs attention",
      );
      await expectText(
        page.getByRole("region", { name: "Capabilities", exact: true }),
        "Workspace",
      );
      await assertAccessibleAndBounded(page);
      await capture(page, "current-desktop-1440x900.png");

      const currentTab = page.getByRole("tab", { name: /Current/ });
      await currentTab.focus();
      await page.keyboard.press("ArrowRight");
      await expectFocused(page.getByRole("tab", { name: "Discover" }));
      await page.keyboard.press("Enter");
      expect(await page.getByRole("tab", { name: "Discover" }).getAttribute("aria-selected")).toBe(
        "true",
      );

      const discoverPanel = page.getByRole("tabpanel", { name: "Discover" });
      await expectText(discoverPanel, "636 matching capabilities · 1 pack managed separately");
      expect(await discoverPanel.locator("[data-capability-id]").count()).toBeLessThanOrEqual(48);
      await assertAccessibleAndBounded(page);
      await capture(page, "discover-desktop-1440x900.png");

      const search = page.getByRole("textbox", { name: "Search capabilities" });
      await search.fill("Specialist MCP 0618");
      await expectVisible(discoverPanel.getByText("Specialist MCP 0618", { exact: true }));
      expect(await discoverPanel.locator("[data-capability-id]").count()).toBe(1);
      await search.fill("");
      await page.getByRole("combobox", { name: "Capability format" }).selectOption("mcp");
      await expectText(discoverPanel, "623 matching capabilities");

      await page.getByRole("tab", { name: "Connections" }).click();
      const connectionsPanel = page.getByRole("tabpanel", { name: "Connections" });
      await expectText(connectionsPanel, "Connections and identities");
      await expectText(connectionsPanel, "Your Slack account");
      await expectText(connectionsPanel, "Personal · only you");
      await expectText(connectionsPanel, "OpenGeni workspace bot");
      await expectVisible(connectionsPanel.getByText("Google Drive", { exact: true }).first());
      await assertAccessibleAndBounded(page);
      await capture(page, "connections-desktop-1440x900.png");

      await page.getByRole("tab", { name: "Custom" }).click();
      const customPanel = page.getByRole("tabpanel", { name: "Custom" });
      await expectText(customPanel, "Build or add a custom capability");
      await expectText(customPanel, "Workspace policy");
      await expectText(customPanel, "Skill and pack precedence");
      await assertAccessibleAndBounded(page);
      await capture(page, "custom-desktop-1440x900.png");
    } finally {
      await context.close();
    }
  }, 90_000);

  test("mobile, reduced motion, and first-run states preserve hierarchy without overflow", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await installExperienceApi(page, connectedExperienceState());
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      expect(
        await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      ).toBe(true);
      await expectVisible(page.getByRole("heading", { name: "What agents can use now" }));
      await assertAccessibleAndBounded(page);
      await capture(page, "current-mobile-390x844.png");

      await page.getByRole("tab", { name: "Connections" }).click();
      await expectText(page.getByRole("tabpanel", { name: "Connections" }), "Personal · only you");
      await assertAccessibleAndBounded(page);
      await capture(page, "connections-mobile-390x844.png");
    } finally {
      await context.close();
    }

    const emptyContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const emptyPage = await emptyContext.newPage();
    try {
      await installExperienceApi(emptyPage, { items: [], connections: [] });
      await emptyPage.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      await expectText(
        emptyPage.getByRole("region", { name: "Capabilities", exact: true }),
        "Choose capabilities for the work ahead",
      );
      await assertAccessibleAndBounded(emptyPage);
      await capture(emptyPage, "first-run-empty-mobile-390x844.png");
    } finally {
      await emptyContext.close();
    }
  }, 90_000);

  test("loading and error states remain explicit and retryable", async () => {
    const loadingContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const loadingPage = await loadingContext.newPage();
    try {
      await installExperienceApi(loadingPage, {
        items: connectedExperienceState().items,
        connections: [],
        catalogDelayMs: 1_800,
      });
      await loadingPage.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "domcontentloaded",
      });
      await expectVisible(loadingPage.getByRole("heading", { name: "What agents can use now" }));
      await expectVisible(loadingPage.locator(".animate-pulse").first());
      await capture(loadingPage, "loading-desktop-1440x900.png");
      await expectVisible(loadingPage.getByText("Available now"));
    } finally {
      await loadingContext.close();
    }

    const errorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errorPage = await errorContext.newPage();
    try {
      await installExperienceApi(errorPage, {
        items: [],
        connections: [],
        catalogError: true,
      });
      await errorPage.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      await expectText(
        errorPage.getByRole("region", { name: "Capabilities", exact: true }),
        "Couldn't load capabilities",
      );
      await expectVisible(errorPage.getByRole("button", { name: /Retry/ }));
      await assertAccessibleAndBounded(errorPage);
      await capture(errorPage, "error-desktop-1440x900.png");
    } finally {
      await errorContext.close();
    }
  }, 90_000);
});

async function installExperienceApi(page: Page, state: ExperienceState): Promise<void> {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = { "x-opengeni-api-contract": apiContractRevision };
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/v1/config/client") {
      return json({
        deploymentRevision: "capabilities-experience-test",
        apiContractRevision,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "xhigh",
        allowedReasoningEfforts: ["xhigh"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (url.pathname === "/v1/access/me") {
      return json({
        mode: "configured",
        subjectId,
        subjectLabel: "Capabilities experience owner",
        accountGrants: [
          {
            accountId,
            subjectId,
            role: "owner",
            permissions: ["account:admin", "workspace:admin"],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId,
            permissions: [
              "workspace:admin",
              "capabilities:read",
              "capabilities:write",
              "connections:read",
              "connections:write",
            ],
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    }
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      if (state.catalogDelayMs) await Bun.sleep(state.catalogDelayMs);
      if (state.catalogError)
        return json({ message: "Catalog unavailable for browser fixture" }, 503);
      return json({ items: state.items, installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: state.connections });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/social/connections`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/slack/reaction-channels`) {
      return json({ channels: [], nextCursor: null });
    }
    return json({});
  });
}

function connectedExperienceState(): ExperienceState {
  return { items: experienceCatalog(), connections: experienceConnections() };
}

function experienceCatalog(): JsonRecord[] {
  const items: JsonRecord[] = [
    mcpCapability({
      id: "mcp:linear",
      name: "Linear",
      description: "Plan and update product work in Linear.",
      providerDomain: "linear.app",
      category: "productivity",
      enabled: true,
      connectionId: "00000000-0000-4000-8000-000000000301",
      subjectScope: "workspace",
    }),
    mcpCapability({
      id: "mcp:mobbin",
      name: "Mobbin",
      description: "Search real product screens and interaction patterns.",
      providerDomain: "mobbin.com",
      category: "research",
      enabled: true,
      connectionId: "00000000-0000-4000-8000-000000000302",
      subjectScope: "subject",
    }),
    mcpCapability({
      id: "mcp:notion",
      name: "Notion",
      description: "Read and update reviewed Notion workspaces.",
      providerDomain: "notion.so",
      category: "knowledge",
      enabled: true,
      connectionId: "00000000-0000-4000-8000-000000000303",
      subjectScope: "workspace",
    }),
    mcpCapability({
      id: "mcp:slack-personal",
      name: "Slack",
      description: "Use your personal Slack identity for interactive work.",
      providerDomain: "slack.com",
      endpointUrl: "https://mcp.slack.com/mcp",
      category: "communication",
      enabled: true,
      connectionId: "00000000-0000-4000-8000-000000000304",
      subjectScope: "subject",
    }),
    mcpCapability({
      id: "mcp:document-search",
      name: "Document Search",
      description: "Search indexed workspace knowledge with citations.",
      providerDomain: null,
      category: "knowledge",
      enabled: true,
      source: "built_in",
      authKind: "none",
    }),
  ];

  const categories = [
    "productivity",
    "development",
    "knowledge",
    "marketing",
    "infrastructure",
    "communication",
  ];
  for (let index = 1; index <= 618; index += 1) {
    const suffix = String(index).padStart(4, "0");
    items.push(
      mcpCapability({
        id: `mcp:specialist-${suffix}`,
        name: `Specialist MCP ${suffix}`,
        description: `A searchable ${categories[(index - 1) % categories.length]} integration.`,
        providerDomain: `specialist-${suffix}.example.com`,
        category: categories[(index - 1) % categories.length],
      }),
    );
  }

  items.push(
    apiCapability("api:scheduled-tasks", "Scheduled Tasks", "Automate recurring agent work."),
    apiCapability(
      "api:document-knowledge",
      "Document Knowledge Base",
      "Manage reviewed workspace knowledge.",
    ),
    apiCapability("api:social-accounts", "Social Accounts", "Manage connected social accounts."),
    apiCapability("api:github-app", "GitHub App", "Use workspace-approved repositories."),
    apiCapability("api:files", "Files", "Read and create session file resources.", "configured"),
  );

  items.push(
    skillCapability(
      "skill:opengeni",
      "OpenGeni",
      "Operate OpenGeni workspace resources.",
      true,
      "built_in",
    ),
    skillCapability("skill:checkov", "checkov", "Scan infrastructure code for policy violations."),
    skillCapability(
      "skill:refactor-module",
      "refactor-module",
      "Refactor monolithic Terraform into reusable modules.",
    ),
    skillCapability(
      "skill:terraform-search-import",
      "terraform-search-import",
      "Discover and import existing cloud resources.",
    ),
    skillCapability(
      "skill:terraform-stacks",
      "terraform-stacks",
      "Build and validate Terraform Stacks.",
    ),
    skillCapability(
      "skill:terraform-style-guide",
      "terraform-style-guide",
      "Apply consistent Terraform conventions.",
    ),
    skillCapability("skill:terraform-test", "terraform-test", "Write and run Terraform tests."),
    skillCapability(
      "skill:social-media-marketing",
      "social-media-marketing",
      "Plan and analyze connected social campaigns.",
      false,
      "library",
      "marketing",
    ),
  );

  items.push(
    baseCapability({
      id: "pack:infrastructure-review",
      kind: "pack",
      source: "library",
      name: "Infrastructure review",
      description: "Checkov and Terraform review guidance enabled as one intentional collection.",
      category: "infrastructure",
      tags: ["pack", "terraform", "security"],
      enabled: false,
    }),
  );

  return items;
}

function mcpCapability(input: {
  id: string;
  name: string;
  description: string;
  providerDomain: string | null;
  endpointUrl?: string;
  category: string;
  enabled?: boolean;
  connectionId?: string;
  subjectScope?: "workspace" | "subject";
  source?: string;
  authKind?: string;
}): JsonRecord {
  const endpointUrl =
    input.endpointUrl ?? (input.providerDomain ? `https://${input.providerDomain}/mcp` : null);
  return baseCapability({
    id: input.id,
    kind: "mcp",
    source: input.source ?? "registry",
    name: input.name,
    description: input.description,
    category: input.category,
    tags: ["mcp", input.category],
    endpointUrl,
    homepageUrl: input.providerDomain ? `https://${input.providerDomain}` : null,
    providerDomain: input.providerDomain,
    mcpUrl: endpointUrl,
    authModel: input.authKind === "none" ? null : "credential_ref",
    authKind: input.authKind ?? "oauth2",
    enabled: input.enabled ?? false,
    enabledReason: input.enabled ? "explicit" : null,
    tier: input.source === "built_in" ? "platform" : "verified",
    connectionRef:
      input.connectionId && input.providerDomain
        ? {
            connectionId: input.connectionId,
            providerDomain: input.providerDomain,
            kind: "oauth2",
            subjectScope: input.subjectScope ?? "workspace",
          }
        : null,
    metadata: { registry: "browser-production-volume" },
  });
}

function apiCapability(id: string, name: string, description: string, source = "built_in") {
  return baseCapability({
    id,
    kind: "api",
    source,
    name,
    description,
    category: "platform",
    tags: ["opengeni", "platform"],
    enabled: true,
    enabledReason: "built_in",
    tier: "platform",
  });
}

function skillCapability(
  id: string,
  name: string,
  description: string,
  enabled = false,
  source = "library",
  category = "infrastructure",
) {
  return baseCapability({
    id,
    kind: "skill",
    source,
    name,
    description,
    category,
    tags: category === "marketing" ? ["marketing", "social"] : ["terraform", "infrastructure"],
    enabled,
    enabledReason: enabled ? "built_in" : null,
    tier: source === "built_in" ? "platform" : "verified",
    metadata:
      source === "library"
        ? {
            libraryId: id,
            version: "1.0.0",
            contentSha256: "a".repeat(64),
            provenance: "OpenGeni canonical skill library browser fixture",
          }
        : {},
  });
}

function baseCapability(overrides: JsonRecord): JsonRecord {
  return {
    id: "capability:fixture",
    accountId,
    workspaceId,
    kind: "api",
    source: "library",
    name: "Capability fixture",
    description: "Browser fixture capability.",
    category: "productivity",
    tags: [],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: "none",
    credentialFacts: [],
    tier: "verified",
    provenance: "Capabilities experience browser fixture",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function experienceConnections(): JsonRecord[] {
  return [
    connection({
      id: "00000000-0000-4000-8000-000000000301",
      providerDomain: "linear.app",
      subjectId: null,
    }),
    connection({
      id: "00000000-0000-4000-8000-000000000302",
      providerDomain: "mobbin.com",
      subjectId,
    }),
    connection({
      id: "00000000-0000-4000-8000-000000000303",
      providerDomain: "notion.so",
      subjectId: null,
      status: "revoked",
      lastError: "Provider authorization revoked.",
    }),
    connection({
      id: "00000000-0000-4000-8000-000000000304",
      providerDomain: "slack.com",
      subjectId,
      metadata: { mcpUrl: "https://mcp.slack.com/mcp" },
    }),
    connection({
      id: "00000000-0000-4000-8000-000000000305",
      providerDomain: "googleapis.com",
      subjectId,
      metadata: {
        credentialRole: "google_drive_metadata",
        credentialLabel: "Google Drive metadata browser",
        googlePermissionId: "permission-browser-fixture",
        googleEmail: "founder@example.com",
        googleDisplayName: "Founder",
        verifiedAt: new Date(0).toISOString(),
        accessMode: "readonly",
        lifecycle: { state: "connected" },
        selectedSources: [],
      },
    }),
    connection({
      id: "00000000-0000-4000-8000-000000000306",
      providerDomain: "slack.com",
      subjectId: null,
      kind: "app_install",
      grantedScopes: [
        "app_mentions:read",
        "canvases:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "files:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
      ],
      verifiedInstallAt: new Date(0).toISOString(),
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: "opengeni_slack_bot",
        credentialLabel: "OpenGeni Slack bot",
        slackTeamId: "T-BROWSER",
        slackTeamName: "Acme",
        botDisplayName: "OpenGeni",
      },
    }),
  ];
}

function connection(overrides: JsonRecord): JsonRecord {
  return {
    id: "00000000-0000-4000-8000-000000000399",
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "example.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["openid"],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: new Date(0).toISOString(),
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    verifiedInstallAt: null,
    verifiedInstallVersion: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function workspace(): JsonRecord {
  return {
    id: workspaceId,
    accountId,
    name: "Acme Product",
    slug: "acme-product",
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {
      slackReactionSummon: {
        enabled: false,
        emoji: "genie",
        channelPolicy: { mode: "bot_member" },
      },
    },
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

async function capture(page: Page, fileName: string): Promise<void> {
  const region = page.getByRole("region", { name: "Capabilities", exact: true });
  await region.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: `${evidenceDir}${fileName}`, fullPage: true });
}

async function assertAccessibleAndBounded(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .include('[role="region"][aria-label="Capabilities"]')
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectVisible(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
}

async function expectFocused(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "attached", timeout: 20_000 });
  expect(await locator.evaluate((element) => element === document.activeElement)).toBe(true);
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  expect((await locator.textContent()) ?? "").toContain(expected);
}
