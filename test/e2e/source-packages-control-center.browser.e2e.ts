import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = new URL("../../.agent/evidence/capabilities-source-packages/", import.meta.url)
  .pathname;
const workspaceId = "00000000-0000-4000-8000-000000000717";
const accountId = "00000000-0000-4000-8000-000000000718";
const subjectId = "user:capabilities-source-browser";
const financeConnectionId = "00000000-0000-4000-8000-000000000719";
const salesConnectionId = "00000000-0000-4000-8000-000000000720";
const skillCapabilityId = "skill:release-operator-browser";
const pluginKey = "example/research";
const skillUrl = "https://github.com/acme/skills/tree/main/release-operator";
const pluginUrl = "https://plugins.example.test/research.json";
const packId = "infra-ops-browser";
const packManifestDigest = "e".repeat(64);
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;
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
  packInstalled: boolean;
  packUninstallRequests: Record<string, unknown>[];
};

describe("Bundles section browser acceptance", () => {
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

      const skillRow = page.locator(`[data-integration-row="imported:${skillCapabilityId}"]`);
      await expectVisible(skillRow);
      await expectText(skillRow, "release-operator");
      await expectText(skillRow, "Skill · Imported from source");
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

      const pluginRow = page.locator(`[data-integration-row="plugin:${pluginKey}"]`);
      await expectVisible(pluginRow);
      await expectText(pluginRow, "Research suite");
      await expectText(pluginRow, "Plugin · Imported from source");
      expect(state.pluginPreviewRequests).toHaveLength(2);
      expect(state.pluginInstallRequests).toHaveLength(1);
      expect(state.pluginInstallRequests[0]).toMatchObject({
        url: pluginUrl,
        bindings: { linear: { connectionId: financeConnectionId } },
      });
      // One Bundles section, one search, and a row for every kind in it.
      await expectVisible(page.getByRole("heading", { name: "Bundles" }));
      const search = page.getByLabel("Search bundles");
      await search.fill("research");
      await expectVisible(pluginRow);
      await expectHidden(skillRow);
      await search.fill("");
      await expectVisible(skillRow);
      await assertAccessibleAndBounded(page, '[aria-labelledby="bundles-heading"]');
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

      const pluginRow = page.locator(`[data-integration-row="plugin:${pluginKey}"]`);
      await openBundleSheet(page, `plugin:${pluginKey}`);
      await page
        .locator('[data-integration-sheet="bundle-plugin-example/research"]')
        .getByRole("button", { name: "Review update" })
        .click();
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

      await expectVisible(pluginRow);
      await openBundleSheet(page, `plugin:${pluginKey}`);
      await page
        .locator('[data-integration-sheet="bundle-plugin-example/research"]')
        .getByRole("button", { name: "Remove" })
        .click();
      dialog = page.getByRole("dialog");
      await expectText(dialog, "3 components are in this Plugin. 1 will remain");
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await dialog.screenshot({ path: `${evidenceDir}remove-impact-dialog-dark.png` });
      await dialog.getByRole("button", { name: "Remove Plugin" }).click();
      await expectHidden(pluginRow);
      expect(state.pluginRemoveRequests.at(-1)).toMatchObject({
        expectedInstallationVersion: 3,
      });

      const skillRow = page.locator(`[data-integration-row="imported:${skillCapabilityId}"]`);
      await openBundleSheet(page, `imported:${skillCapabilityId}`);
      await page
        .locator(`[data-integration-sheet="bundle-skill-${skillCapabilityId}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      dialog = page.getByRole("dialog");
      await expectText(
        dialog,
        "The runtime Skill will be removed because no other owner retains it",
      );
      await dialog.getByRole("button", { name: "Remove direct Skill" }).click();
      await expectHidden(skillRow);
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
        page.locator('[aria-labelledby="bundles-heading"]'),
        "Workspace administrators can install, update, and remove Bundles",
      );
      expect(await page.getByRole("button", { name: "Import Skill" }).first().isDisabled()).toBe(
        true,
      );
      // A viewer who cannot act is told so, rather than shown buttons that do
      // nothing when pressed.
      await openBundleSheet(page, `plugin:${pluginKey}`);
      const pluginSheet = page.locator('[data-integration-sheet="bundle-plugin-example/research"]');
      await expectText(
        pluginSheet,
        "Workspace administrators can install, update, and remove imported Skills and Plugins.",
      );
      expect(await pluginSheet.getByRole("button", { name: "Review update" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await expectHidden(pluginSheet);
      await assertAccessibleAndBounded(page, '[aria-labelledby="bundles-heading"]');
      await page.locator('[aria-labelledby="bundles-heading"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidenceDir}permission-mobile-dark.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  // A Pack lists through the same uniform row as every other Bundle, and its
  // two destructive verbs release ownership, so the whole chain - open the row,
  // read the installed identity, uninstall, confirm - is exercised for real.
  test("a Pack row opens its plan, names the installed identity, and uninstalls", async () => {
    const state = readyState({ packInstalled: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      await installApi(page, state);
      await openCapabilities(page);
      await setTheme(page, "light");

      const packRow = page.locator(`[data-integration-row="pack:${packId}"]`);
      await expectVisible(packRow);
      await expectText(packRow, "Pack · Registered in this workspace");
      // Provenance is read from the catalog row, never assumed to be OpenGeni's.
      expect((await packRow.textContent()) ?? "").not.toContain("Curated by OpenGeni");
      expect(await packRow.locator("> button").getAttribute("aria-label")).toBe(
        "Infrastructure operations. Pack, registered in this workspace. Installed",
      );

      await openBundleSheet(page, `pack:${packId}`);
      const dialog = page.locator(`[data-pack-dialog="${packId}"]`);
      await expectVisible(dialog);
      // The version, role, category, and installed digest a repair turns on.
      const identity = dialog.locator(`[data-pack-identity="${packId}"]`);
      await expectText(identity, "v1.4.0");
      await expectText(identity, "infrastructure");
      await expectText(identity, "operations");
      await expectText(identity, packManifestDigest.slice(0, 12));
      await expectText(identity, "Pinned infrastructure automation capabilities.");
      await expectText(dialog, "Ready to install");
      await assertAccessibleAndBounded(page, `[data-pack-dialog="${packId}"]`);
      await dialog.screenshot({ path: `${evidenceDir}pack-detail-dialog-light.png` });

      // Unregistering a live installation is the one order that cannot work.
      expect(await dialog.getByRole("button", { name: "Unregister" }).isDisabled()).toBe(true);

      await dialog.getByRole("button", { name: "Uninstall" }).click();
      // Two dialogs are mounted now; the confirmation is the one that names it.
      const confirm = page
        .getByRole("dialog")
        .filter({ hasText: "Uninstall Infrastructure operations?" });
      await expectText(confirm, "Retained by another Pack");
      await confirm.getByRole("button", { name: "Uninstall Pack" }).click();
      expect(state.packUninstallRequests).toHaveLength(1);
      expect(state.packUninstallRequests[0]).toMatchObject({ expectedInstallationVersion: 4 });
      await expectText(packRow, "Not installed");
    } finally {
      await context.close();
    }
  }, 90_000);
});

function readyState(
  patch: Partial<
    Pick<UiState, "canManage" | "skillInstalled" | "pluginInstalled" | "packInstalled">
  > = {},
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
    packInstalled: false,
    packUninstallRequests: [],
    ...patch,
  };
}

async function openCapabilities(page: Page): Promise<void> {
  await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
    waitUntil: "networkidle",
  });
  await expectVisible(page.getByRole("heading", { name: "Bundles" }));
}

async function openBundleSheet(page: Page, rowId: string): Promise<void> {
  await page.locator(`[data-integration-row="${rowId}"] > button`).first().click();
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
      return json({
        packs: [capabilityPack()],
        installations: state.packInstalled ? [packInstallation()] : [],
      });
    }
    if (
      request.method() === "POST" &&
      decodeURIComponent(url.pathname) ===
        `/v1/workspaces/${workspaceId}/packs/${packId}/installation-preview`
    ) {
      return json(packInstallationPreview(state));
    }
    if (
      request.method() === "GET" &&
      decodeURIComponent(url.pathname) ===
        `/v1/workspaces/${workspaceId}/packs/${packId}/uninstall-preview`
    ) {
      return json(packUninstallPreview());
    }
    if (
      request.method() === "DELETE" &&
      decodeURIComponent(url.pathname) ===
        `/v1/workspaces/${workspaceId}/packs/${packId}/installation`
    ) {
      state.packUninstallRequests.push(request.postDataJSON() as Record<string, unknown>);
      state.packInstalled = false;
      return json({ packId, status: "uninstalled", retainedComponents: [skillCapabilityId] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/rigs`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      return json({ definitions: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: [] });
    }
    if (request.method() === "GET" && url.pathname === `/v1/workspaces/${workspaceId}/skills`) {
      return json({ skills: state.skillInstalled ? [installedSkillSummary(state)] : [] });
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
        status: state.pluginInstalled ? "retained_by_other_owners" : "uninstalled",
        remainingOwners: state.pluginInstalled
          ? [{ kind: "plugin", id: pluginInstallationId, removable: true }]
          : [],
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
    deploymentRevision: "capabilities-source-browser",
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
    subjectLabel: "Capabilities source browser",
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
  if (!state.skillInstalled) return { items: [packCatalogItem()], installations: [] };
  return {
    items: [installedSkillItem(), packCatalogItem()],
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
      installedSkill: { source: "github" },
    },
  };
}

/**
 * The Pack's catalog row. Its `source` is the fact the Bundles row reads for
 * provenance, so an admin-registered Pack must not be projected as built in.
 */
function packCatalogItem() {
  return {
    id: `pack:${packId}`,
    kind: "pack",
    source: "manual",
    name: "Infrastructure operations",
    description: "Pinned infrastructure automation capabilities.",
    category: "operations",
    tags: ["infrastructure", "operations", "pack"],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: null,
    credentialFacts: [],
    tier: "community",
    provenance: null,
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    lifecycle: {
      status: "available",
      readiness: "ready",
      detail: "available",
      managedBy: "workspace",
    },
    actions: ["inspect"],
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: { packId, version: "1.4.0" },
  };
}

function capabilityPack() {
  return {
    id: packId,
    name: "Infrastructure operations",
    description: "Pinned infrastructure automation capabilities.",
    role: "infrastructure",
    category: "operations",
    version: "1.4.0",
    skills: [],
    components: [
      {
        key: "skills/release-operator",
        kind: "skill",
        capabilityId: skillCapabilityId,
        contentSha256: "b".repeat(64),
        required: true,
      },
    ],
    tools: [],
    connectors: [],
    knowledge: [],
    scheduledTaskTemplates: [],
    metadata: {},
  };
}

function packInstallation() {
  return {
    id: "00000000-0000-4000-8000-000000000731",
    accountId,
    workspaceId,
    packId,
    status: "active",
    version: 4,
    manifestSnapshot: capabilityPack(),
    manifestDigest: packManifestDigest,
    selectedRigId: null,
    installedBySubjectId: subjectId,
    metadata: {},
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function packInstallationPreview(state: UiState) {
  return {
    packId,
    packVersion: "1.4.0",
    manifestDigest: packManifestDigest,
    installationVersion: state.packInstalled ? 4 : null,
    action: state.packInstalled ? "update" : "install",
    ready: true,
    blockers: [],
    components: [
      {
        key: "skills/release-operator",
        kind: "skill",
        capabilityId: skillCapabilityId,
        required: true,
        status: "ready",
        expectedDigest: "b".repeat(64),
        actualDigest: "b".repeat(64),
        resolvedId: skillCapabilityId,
        label: "release-operator",
      },
    ],
    rig: {
      required: false,
      status: "not_required",
      requestedRigId: null,
      rigId: null,
      rigVersionId: null,
      name: null,
      image: null,
    },
    variableSetId: null,
    legacyInlineSkillCount: 0,
    legacySandboxImage: null,
  };
}

function packUninstallPreview() {
  return {
    packId,
    installed: true,
    installationVersion: 4,
    components: [
      {
        key: "skills/release-operator",
        kind: "skill",
        capabilityId: skillCapabilityId,
        retainedByOtherOwners: true,
      },
    ],
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

const pluginInstallationId = "00000000-0000-4000-8000-000000000729";

function installedSkillSummary(state: UiState) {
  return {
    capabilityId: skillCapabilityId,
    pluginKey: "skill/acme/skills/release-operator",
    installationVersion: state.skillInstallationVersion,
    name: "release-operator",
    description: "Release safely with immutable operational instructions.",
    category: "skills",
    tags: ["skill", "release"],
    provenance: "workspace_import",
    source: "github",
    version: "0.0.0",
    sourceUrl: skillUrl,
    repositoryUrl: "https://github.com/acme/skills",
    sourceCommit: "a".repeat(40),
    sourcePath: "release-operator",
    contentSha256: "b".repeat(64),
    fileCount: 2,
    totalBytes: 1_280,
    license: null,
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    owners: [
      { kind: "direct", id: skillCapabilityId, removable: true },
      ...(state.pluginInstalled
        ? [{ kind: "plugin", id: pluginInstallationId, removable: true } as const]
        : []),
    ],
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
    pluginInstallationId,
    installationVersion: state.pluginInstallationVersion,
    componentCount: 3,
    status: "installed",
  };
}

function skillUninstallPreview(state: UiState) {
  const remainingOwners = state.pluginInstalled
    ? [{ kind: "plugin", id: pluginInstallationId, removable: true } as const]
    : [];
  return {
    capabilityId: skillCapabilityId,
    installed: state.skillInstalled,
    installationVersion: state.skillInstalled ? state.skillInstallationVersion : null,
    directOwner: { kind: "direct", id: skillCapabilityId, removable: true },
    remainingOwners,
    removesRuntimeSkill: remainingOwners.length === 0,
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
  const deadline = Date.now() + 15_000;
  let text = "";
  while (Date.now() < deadline) {
    text = (await locator.textContent()) ?? "";
    if (text.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(text).toContain(expected);
}
