import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = new URL("../../.agent/evidence/ope-16-source-packages/", import.meta.url)
  .pathname;
const workspaceId = "00000000-0000-4000-8000-000000000717";
const accountId = "00000000-0000-4000-8000-000000000718";
const subjectId = "user:ope-16-source-browser";
const financeConnectionId = "00000000-0000-4000-8000-000000000719";
const salesConnectionId = "00000000-0000-4000-8000-000000000720";
const skillCapabilityId = "skill:release-operator-browser";
const pluginKey = "example/research";
const skillUrl = "https://github.com/acme/skills/tree/main/release-operator";
const pluginUrl = "https://plugins.example.test/research.json";
const apiContractRevision = "2026-07-workspace-artifacts-v1";
let webBaseUrl = "";

type UiState = {
  canManage: boolean;
  skillInstalled: boolean;
  pluginInstalled: boolean;
  skillInstallationVersion: number;
  pluginInstallationVersion: number;
  skillInstallRequests: Record<string, unknown>[];
  pluginPreviewRequests: Record<string, unknown>[];
  pluginInstallRequests: Record<string, unknown>[];
  skillRemoveRequests: Record<string, unknown>[];
  pluginRemoveRequests: Record<string, unknown>[];
};

describe("Skill and Plugin control center browser acceptance", () => {
  let browser: Browser;
  let web: StartedProcess;

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

  test("desktop installs immutable Skill and Plugin sources with an exact account recheck", async () => {
    const state = readyState({ skillInstalled: false, pluginInstalled: false });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      await installApi(page, state);
      await openCapabilities(page);
      await setTheme(page, "light");

      await page.getByRole("button", { name: "Import Skill" }).first().click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("GitHub or skills.sh URL").fill(skillUrl);
      await dialog.getByRole("button", { name: "Detect and preview" }).click();
      await expectText(dialog, "Immutable Skill preview ready");
      await expectText(dialog, "Pinned commit");
      await expectText(dialog, "Review 2 immutable files");
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await dialog.getByRole("button", { name: "Install this Skill" }).click();

      const skillCard = page.locator('[data-source-package-kind="skill"]');
      await expectVisible(skillCard);
      await expectText(skillCard, "release-operator");
      expect(state.skillInstallRequests).toHaveLength(1);
      expect(state.skillInstallRequests[0]).toMatchObject({
        url: skillUrl,
        expectedSourceCommit: "a".repeat(40),
        expectedContentSha256: "b".repeat(64),
      });

      await page.getByRole("button", { name: "Install Plugin" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Plugin manifest URL").fill(pluginUrl);
      await dialog.getByRole("button", { name: "Detect and preview" }).click();
      await expectText(dialog, "Immutable Plugin bill of materials ready");
      await expectText(dialog, "Manifest digest");
      await expectText(dialog, "Choose an exact Connection for Linear");

      const connectionSelect = dialog.getByLabel("Exact Connection");
      await expectText(connectionSelect, "Finance credential · Workspace");
      await expectText(connectionSelect, "Sales credential · Personal");
      expect((await connectionSelect.textContent()) ?? "").not.toContain("Wrong-domain account");
      await connectionSelect.selectOption(financeConnectionId);
      await dialog.getByRole("button", { name: "Recheck selected accounts" }).click();
      await expectVisible(dialog.getByRole("button", { name: "Install this Plugin" }));
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await dialog.getByRole("button", { name: "Install this Plugin" }).click();

      const pluginCard = page.locator('[data-source-package-kind="plugin"]');
      await expectVisible(pluginCard);
      await expectText(pluginCard, "Research suite");
      expect(state.pluginPreviewRequests).toHaveLength(2);
      expect(state.pluginInstallRequests).toHaveLength(1);
      expect(state.pluginInstallRequests[0]).toMatchObject({
        url: pluginUrl,
        bindings: { linear: { connectionId: financeConnectionId } },
      });
      await assertAccessibleAndBounded(page, '[aria-labelledby="source-packages-heading"]');
      await page.screenshot({
        path: `${evidenceDir}install-desktop-light.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 90_000);

  test("dark update and removals preserve version fences and explain shared ownership", async () => {
    const state = readyState({ skillInstalled: true, pluginInstalled: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      await installApi(page, state);
      await openCapabilities(page);
      await setTheme(page, "dark");

      let pluginCard = page.locator('[data-source-package-kind="plugin"]');
      await pluginCard.getByRole("button", { name: "Review update" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Detect and preview" }).click();
      await expectText(dialog, "Update impact");
      await expectText(dialog, "1 added, 1 changed, 0 removed, and 1 unchanged components");
      await dialog.getByLabel("Exact Connection").selectOption(financeConnectionId);
      await dialog.getByRole("button", { name: "Recheck selected accounts" }).click();
      await expectVisible(dialog.getByRole("button", { name: "Update this Plugin" }));
      await dialog.screenshot({ path: `${evidenceDir}update-review-dialog-dark.png` });
      await dialog.getByRole("button", { name: "Update this Plugin" }).click();
      expect(state.pluginInstallRequests.at(-1)).toMatchObject({
        expectedInstallationVersion: 2,
      });

      pluginCard = page.locator('[data-source-package-kind="plugin"]');
      await expectVisible(pluginCard);
      await pluginCard.getByRole("button", { name: "Remove" }).click();
      dialog = page.getByRole("dialog");
      await expectText(dialog, "3 components are in this Plugin. 1 will remain");
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await dialog.screenshot({ path: `${evidenceDir}remove-impact-dialog-dark.png` });
      await dialog.getByRole("button", { name: "Remove Plugin" }).click();
      await expectHidden(page.locator('[data-source-package-kind="plugin"]'));
      expect(state.pluginRemoveRequests.at(-1)).toMatchObject({
        expectedInstallationVersion: 3,
      });

      const skillCard = page.locator('[data-source-package-kind="skill"]');
      await skillCard.getByRole("button", { name: "Remove" }).click();
      dialog = page.getByRole("dialog");
      await expectText(dialog, "1 other owner will retain the runtime Skill");
      await dialog.getByRole("button", { name: "Remove direct Skill" }).click();
      await expectHidden(page.locator('[data-source-package-kind="skill"]'));
      expect(state.skillRemoveRequests.at(-1)).toMatchObject({
        expectedInstallationVersion: 3,
      });

      await page.screenshot({
        path: `${evidenceDir}update-remove-desktop-dark.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 90_000);

  test("mobile permission state remains truthful, accessible, and bounded", async () => {
    const state = readyState({ canManage: false, skillInstalled: true, pluginInstalled: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      await installApi(page, state);
      await openCapabilities(page);
      await expectText(
        page.locator('[aria-labelledby="source-packages-heading"]'),
        "Workspace administrators can install, update, and remove source packages",
      );
      expect(await page.getByRole("button", { name: "Import Skill" }).first().isDisabled()).toBe(
        true,
      );
      expect(
        await page
          .locator('[data-source-package-kind="plugin"]')
          .getByRole("button", { name: "Review update" })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .locator('[data-source-package-kind="skill"]')
          .getByRole("button", { name: "Remove" })
          .isDisabled(),
      ).toBe(true);
      await assertAccessibleAndBounded(page, '[aria-labelledby="source-packages-heading"]');
      await page.locator('[aria-labelledby="source-packages-heading"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidenceDir}permission-mobile-dark.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 60_000);
});

function readyState(
  patch: Partial<Pick<UiState, "canManage" | "skillInstalled" | "pluginInstalled">> = {},
): UiState {
  return {
    canManage: true,
    skillInstalled: true,
    pluginInstalled: true,
    skillInstallationVersion: 3,
    pluginInstallationVersion: 2,
    skillInstallRequests: [],
    pluginPreviewRequests: [],
    pluginInstallRequests: [],
    skillRemoveRequests: [],
    pluginRemoveRequests: [],
    ...patch,
  };
}

async function openCapabilities(page: Page): Promise<void> {
  await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
    waitUntil: "networkidle",
  });
  await expectVisible(page.getByRole("heading", { name: "Skills and Plugins" }));
}

async function installApi(page: Page, state: UiState): Promise<void> {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "x-opengeni-api-contract": apiContractRevision };
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/v1/config/client") return json(clientConfig());
    if (url.pathname === "/v1/access/me") return json(access(state.canManage));
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json(capabilityCatalog(state));
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: connections() });
    }
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
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/presets`) {
      return json({ presets: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: [] });
    }
    if (request.method() === "GET" && url.pathname === `/v1/workspaces/${workspaceId}/plugins`) {
      return json({ plugins: state.pluginInstalled ? [installedPlugin(state)] : [] });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/skills/preview`
    ) {
      return json(skillPreview(state));
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/skills/install`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.skillInstallRequests.push(body);
      state.skillInstalled = true;
      state.skillInstallationVersion += 1;
      return json(installedSkill(state), body.expectedInstallationVersion ? 200 : 201);
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/plugins/preview`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.pluginPreviewRequests.push(body);
      const bindings = body.bindings as Record<string, { connectionId?: string }> | undefined;
      const selectedConnectionId =
        bindings?.linear?.connectionId ?? (state.pluginInstalled ? financeConnectionId : null);
      return json(pluginPreview(state, selectedConnectionId));
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/plugins/install`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.pluginInstallRequests.push(body);
      state.pluginInstalled = true;
      state.pluginInstallationVersion += 1;
      return json(installedPluginResult(state), body.expectedInstallationVersion ? 200 : 201);
    }

    const decodedPath = decodeURIComponent(url.pathname);
    if (
      request.method() === "GET" &&
      decodedPath === `/v1/workspaces/${workspaceId}/skills/${skillCapabilityId}/uninstall-preview`
    ) {
      return json(skillUninstallPreview(state));
    }
    if (
      request.method() === "DELETE" &&
      decodedPath === `/v1/workspaces/${workspaceId}/skills/${skillCapabilityId}`
    ) {
      state.skillRemoveRequests.push(request.postDataJSON() as Record<string, unknown>);
      state.skillInstalled = false;
      return json({
        capabilityId: skillCapabilityId,
        status: "retained_by_other_owners",
        remainingOwners: [{ kind: "plugin", id: pluginKey, removable: true }],
      });
    }
    if (
      request.method() === "GET" &&
      decodedPath === `/v1/workspaces/${workspaceId}/plugins/${pluginKey}/uninstall-preview`
    ) {
      return json(pluginUninstallPreview(state));
    }
    if (
      request.method() === "DELETE" &&
      decodedPath === `/v1/workspaces/${workspaceId}/plugins/${pluginKey}`
    ) {
      state.pluginRemoveRequests.push(request.postDataJSON() as Record<string, unknown>);
      state.pluginInstalled = false;
      return json({ pluginKey, status: "uninstalled", retainedComponents: [skillCapabilityId] });
    }
    return json({});
  });
}

function clientConfig() {
  return {
    deploymentRevision: "ope-16-source-browser",
    apiContractRevision,
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol"],
    models: [],
    defaultReasoningEffort: "low",
    allowedReasoningEfforts: ["low"],
    mcpServers: [],
    fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
    productAccessMode: "configured",
    auth: { mode: "none" },
    structuredServices: { fileSystem: false, git: false, terminalEvents: false },
  };
}

function access(canManage: boolean) {
  const permissions = canManage
    ? [
        "workspace:admin",
        "capabilities:read",
        "capabilities:write",
        "connections:read",
        "connections:write",
      ]
    : ["capabilities:read", "connections:read"];
  return {
    mode: "configured",
    subjectId,
    subjectLabel: "OPE-16 source browser",
    accountGrants: [
      {
        accountId,
        subjectId,
        role: canManage ? "owner" : "member",
        permissions,
      },
    ],
    workspaceGrants: [{ workspaceId, accountId, subjectId, permissions }],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    name: "Source Package Acceptance",
    slug: "source-package-acceptance",
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function capabilityCatalog(state: UiState) {
  if (!state.skillInstalled) return { items: [], installations: [] };
  return {
    items: [installedSkillItem()],
    installations: [
      {
        id: "00000000-0000-4000-8000-000000000721",
        accountId,
        workspaceId,
        capabilityId: skillCapabilityId,
        kind: "skill",
        status: "active",
        config: {},
        metadata: {},
        enabledAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
    ],
  };
}

function installedSkillItem() {
  return {
    id: skillCapabilityId,
    kind: "skill",
    source: "manual",
    name: "release-operator",
    description: "Release safely with immutable operational instructions.",
    category: "skills",
    tags: ["skill", "release"],
    homepageUrl: "https://github.com/acme/skills",
    endpointUrl: null,
    installUrl: skillUrl,
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: null,
    credentialFacts: [],
    tier: "community",
    provenance: "workspace_import",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    lifecycle: {
      status: "installed",
      readiness: "ready",
      detail: "enabled",
      managedBy: "workspace",
    },
    actions: ["configure", "update", "uninstall", "inspect"],
    enabled: true,
    enabledReason: "enabled",
    connectionRef: null,
    metadata: {
      platformVersion: 2,
      provenance: "workspace_import",
      sourceUrl: skillUrl,
      sourceCommit: "a".repeat(40),
      contentSha256: "b".repeat(64),
    },
  };
}

function skillPreview(state: UiState) {
  return {
    source: "github",
    sourceUrl: skillUrl,
    repositoryUrl: "https://github.com/acme/skills",
    owner: "acme",
    repository: "skills",
    sourcePath: "release-operator",
    sourceCommit: "a".repeat(40),
    name: "release-operator",
    description: "Release safely with immutable operational instructions.",
    contentSha256: "b".repeat(64),
    totalBytes: 1_280,
    files: [
      { path: "SKILL.md", byteSize: 1_024, contentSha256: "c".repeat(64) },
      { path: "references/checklist.md", byteSize: 256, contentSha256: "d".repeat(64) },
    ],
    warnings: [],
    installed: state.skillInstalled,
    installationVersion: state.skillInstalled ? state.skillInstallationVersion : null,
  };
}

function installedSkill(state: UiState) {
  return {
    capabilityId: skillCapabilityId,
    pluginId: "00000000-0000-4000-8000-000000000722",
    pluginVersionId: "00000000-0000-4000-8000-000000000723",
    facetId: "00000000-0000-4000-8000-000000000724",
    pluginInstallationId: "00000000-0000-4000-8000-000000000725",
    facetInstallationId: "00000000-0000-4000-8000-000000000726",
    installationVersion: state.skillInstallationVersion,
    source: "github",
    sourceUrl: skillUrl,
    sourceCommit: "a".repeat(40),
    contentSha256: "b".repeat(64),
    name: "release-operator",
    status: "installed",
  };
}

function installedPlugin(state: UiState) {
  return {
    pluginKey,
    version: "2.0.0",
    name: "Research suite",
    description: "Research workflows with Linear and reusable Skills.",
    category: "plugins",
    tags: ["research", "linear"],
    sourceUrl: pluginUrl,
    manifestDigest: "e".repeat(64),
    installationVersion: state.pluginInstallationVersion,
    componentCount: 3,
    status: "active",
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function pluginPreview(state: UiState, connectionId: string | null) {
  return {
    sourceUrl: pluginUrl,
    manifest: {
      schemaVersion: 1,
      pluginKey,
      version: "2.0.0",
      name: "Research suite",
      description: "Research workflows with Linear and reusable Skills.",
      category: "plugins",
      tags: ["research", "linear"],
      components: [
        {
          key: "linear",
          kind: "integration",
          source: { kind: "graphql", endpoint: "https://linear.example.test/graphql" },
        },
        {
          key: "research-skill",
          kind: "skill",
          source: { url: skillUrl },
        },
        {
          key: "reference-mcp",
          kind: "mcp",
          source: { capabilityId: "mcp:reference" },
        },
      ],
    },
    manifestDigest: "e".repeat(64),
    installed: state.pluginInstalled,
    installationVersion: state.pluginInstalled ? state.pluginInstallationVersion : null,
    components: [
      {
        key: "linear",
        kind: "integration",
        name: "Linear",
        capabilityId: "api:linear",
        digest: "f".repeat(64),
        connectionRequired: true,
        connectionId,
        instanceKey: "default",
        displayName: "Linear research",
        facts: { providerDomain: "linear.example.test", protocol: "graphql" },
      },
      {
        key: "research-skill",
        kind: "skill",
        name: "Research Skill",
        capabilityId: skillCapabilityId,
        digest: "1".repeat(64),
        connectionRequired: false,
        connectionId: null,
        instanceKey: null,
        displayName: null,
        facts: { sourceCommit: "a".repeat(40) },
      },
      {
        key: "reference-mcp",
        kind: "mcp",
        name: "Reference MCP",
        capabilityId: "mcp:reference",
        digest: "2".repeat(64),
        connectionRequired: false,
        connectionId: null,
        instanceKey: null,
        displayName: null,
        facts: { transport: "streamable_http" },
      },
    ],
    diff: state.pluginInstalled
      ? {
          fromVersion: "1.5.0",
          toVersion: "2.0.0",
          added: ["reference-mcp"],
          removed: [],
          changed: ["linear"],
          unchanged: ["research-skill"],
        }
      : {
          fromVersion: null,
          toVersion: "2.0.0",
          added: ["linear", "research-skill", "reference-mcp"],
          removed: [],
          changed: [],
          unchanged: [],
        },
  };
}

function installedPluginResult(state: UiState) {
  return {
    pluginKey,
    version: "2.0.0",
    pluginId: "00000000-0000-4000-8000-000000000727",
    pluginVersionId: "00000000-0000-4000-8000-000000000728",
    pluginInstallationId: "00000000-0000-4000-8000-000000000729",
    installationVersion: state.pluginInstallationVersion,
    componentCount: 3,
    status: "installed",
  };
}

function skillUninstallPreview(state: UiState) {
  return {
    capabilityId: skillCapabilityId,
    installed: state.skillInstalled,
    installationVersion: state.skillInstalled ? state.skillInstallationVersion : null,
    directOwner: { kind: "direct", id: skillCapabilityId, removable: true },
    remainingOwners: [{ kind: "plugin", id: pluginKey, removable: true }],
    removesRuntimeSkill: false,
  };
}

function pluginUninstallPreview(state: UiState) {
  return {
    pluginKey,
    installed: state.pluginInstalled,
    version: state.pluginInstalled ? "2.0.0" : null,
    installationVersion: state.pluginInstalled ? state.pluginInstallationVersion : null,
    components: [
      { capabilityId: "api:linear", kind: "integration", retainedByOtherOwners: false },
      { capabilityId: skillCapabilityId, kind: "skill", retainedByOtherOwners: true },
      { capabilityId: "mcp:reference", kind: "mcp", retainedByOtherOwners: false },
    ],
  };
}

function connections() {
  return [
    connection(financeConnectionId, "Finance credential", null, "linear.example.test", "active"),
    connection(salesConnectionId, "Sales credential", subjectId, "linear.example.test", "active"),
    connection(
      "00000000-0000-4000-8000-000000000730",
      "Wrong-domain account",
      null,
      "other.example.test",
      "active",
    ),
    connection(
      "00000000-0000-4000-8000-000000000731",
      "Revoked Linear",
      null,
      "linear.example.test",
      "revoked",
    ),
  ];
}

function connection(
  id: string,
  credentialLabel: string,
  connectionSubjectId: string | null,
  providerDomain: string,
  status: "active" | "revoked",
) {
  return {
    id,
    accountId,
    workspaceId,
    subjectId: connectionSubjectId,
    providerDomain,
    kind: "api_key",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: status === "active" ? null : "revoked",
    version: 1,
    metadata: { credentialLabel },
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    document.documentElement.setAttribute("data-og-theme", nextTheme);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, theme);
}

async function assertAccessibleAndBounded(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
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
  await locator.waitFor({ state: "visible", timeout: 15_000 });
}

async function expectHidden(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "hidden", timeout: 15_000 });
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await expectVisible(locator);
  expect((await locator.textContent()) ?? "").toContain(expected);
}
