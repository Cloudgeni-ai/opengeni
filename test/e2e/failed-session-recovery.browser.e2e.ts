import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION, type SandboxRecoveryProjection } from "@opengeni/sdk";
import { fakeCapabilities } from "../../packages/react/test/sandbox-fixtures";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const failureId = "55555555-5555-4555-8555-555555555555";
const now = "2026-09-20T09:00:00.000Z";
const effectiveControl = {
  state: "active",
  directState: "active",
  controlVersion: 0,
  controlEtag: "fixture-0",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};
let web: StartedProcess;
let browser: Browser;
let baseUrl: string;
const evidenceDir = process.env.FAILED_SESSION_ARTIFACT_DIR;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  web = await startProcess(
    ["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: "" },
      ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const executablePath = [
    process.env.CHROMIUM_EXECUTABLE_PATH,
    "/opt/google/chrome/chrome",
    "/usr/local/bin/chromium",
  ].find((path): path is string => Boolean(path && existsSync(path)));
  browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

for (const unsupported of [true, false]) {
  test(`real desktop session shows compact ${unsupported ? "unsupported model" : "retry"} recovery`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", async (message) => {
      if (message.type() === "error")
        for (const argument of message.args()) {
          console.error(
            await argument
              .evaluate((value) => (value instanceof Error ? value.stack : String(value)))
              .catch(() => "console error"),
          );
        }
    });
    const retries: unknown[] = [];
    await installApi(page, unsupported, retries);
    try {
      await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
      const banner = page.getByTestId("failed-session-banner");
      await Promise.race([
        banner.waitFor({ timeout: 45_000 }),
        page
          .getByRole("heading", { name: /^(Something went wrong|OpenGeni has been updated)$/ })
          .waitFor({ timeout: 45_000 })
          .then(() => {
            throw new Error("Route failed");
          }),
      ]);
      const picker = page.getByRole("button", { name: "Model and effort", exact: true });
      await picker.waitFor();
      expect(await banner.locator("details").count()).toBe(0);
      expect(await banner.getByRole("button", { name: /Choose/ }).count()).toBe(0);
      if (unsupported) {
        expect(await banner.textContent()).toBe(
          "This model isn’t available. Choose another below.",
        );
        expect(await banner.getByRole("button").count()).toBe(0);
      } else {
        await banner.getByRole("button", { name: "Retry", exact: true }).waitFor();
        expect(await banner.getByRole("button").count()).toBe(1);
      }
      const dimensions = await banner.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        background: getComputedStyle(node).backgroundColor,
        overflow: document.documentElement.scrollWidth - innerWidth,
      }));
      expect(dimensions.height).toBeLessThanOrEqual(40);
      expect(dimensions.background).toBe("rgba(0, 0, 0, 0)");
      expect(dimensions.overflow).toBeLessThanOrEqual(1);
      const request = page.getByText("Review the implementation and verify the tests.", {
        exact: true,
      });
      await request.waitFor();
      expect(
        await banner.evaluate((node) => Boolean(node.closest("[data-og-timeline-trailing-state]"))),
      ).toBe(true);
      const requestBox = await request.boundingBox();
      const bannerBox = await banner.boundingBox();
      const pickerBox = await picker.boundingBox();
      expect(bannerBox!.y).toBeGreaterThanOrEqual(requestBox!.y + requestBox!.height);
      expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(pickerBox!.y);
      expect(
        await banner.evaluate((node) => getComputedStyle(node.parentElement!).position),
      ).not.toBe("sticky");
      if (evidenceDir)
        await page.screenshot({
          path: `${evidenceDir}/${unsupported ? "unsupported-model" : "retry"}-desktop.png`,
          fullPage: true,
        });
      if (unsupported) {
        await picker.click();
        await page.getByTestId("model-picker-choice-supported-model").click();
        const retry = banner.getByRole("button", { name: "Retry", exact: true });
        await retry.waitFor();
        expect(await banner.getByRole("button").count()).toBe(1);
        expect(await request.textContent()).toBe("Review the implementation and verify the tests.");
        expect(retries).toHaveLength(0);
        if (evidenceDir)
          await page.screenshot({
            path: `${evidenceDir}/supported-model-selected-desktop.png`,
            fullPage: true,
          });
        await retry.click();
        await banner.getByRole("button", { name: "Check retry", exact: true }).waitFor();
        expect(retries[0]).toMatchObject({ model: "supported-model", failureEventId: failureId });
        expect(await picker.isDisabled()).toBe(true);
      }
      if (!unsupported) {
        const retry = banner.getByRole("button", { name: "Retry", exact: true });
        const composer = page.getByPlaceholder("Send a follow-up…");
        await composer.fill("Keep this draft intact");
        await retry.waitFor({ state: "detached" });
        expect(await composer.inputValue()).toBe("Keep this draft intact");
        expect(retries).toHaveLength(0);
        await composer.fill("");
        await retry.waitFor();
        await retry.focus();
        await page.keyboard.press("Enter");
        const check = banner.getByRole("button", { name: "Check retry", exact: true });
        await check.waitFor();
        expect(await picker.isDisabled()).toBe(true);
        await check.click();
        await banner.getByRole("status").waitFor();
        expect(retries).toHaveLength(2);
        expect(retries[1]).toEqual(retries[0]);
        expect(await banner.getByRole("button").count()).toBe(0);
      }
      expect(errors).toEqual([]);
    } catch (error) {
      console.error({ errors, body: (await page.locator("body").innerText()).slice(0, 4000) });
      throw error;
    } finally {
      await page.close();
    }
  }, 60_000);
}

for (const uncertainFirst of [false, true]) {
  test(`Clear view preserves recovery ${uncertainFirst ? "after an uncertain response" : "before retry"}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const retries: unknown[] = [];
    try {
      await installApi(page, false, retries);
      await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
      const banner = page.getByTestId("failed-session-banner");
      const composer = page.getByPlaceholder("Send a follow-up…");
      const picker = page.getByRole("button", { name: "Model and effort", exact: true });
      const retry = banner.getByRole("button", { name: "Retry", exact: true });
      const check = banner.getByRole("button", { name: "Check retry", exact: true });
      await retry.waitFor();
      if (uncertainFirst) {
        await retry.click();
        await check.waitFor();
        expect(await picker.isDisabled()).toBe(true);
      }
      await composer.fill("/clear-view");
      await composer.press("Enter");
      await page
        .getByText("Review the implementation and verify the tests.", { exact: true })
        .waitFor({ state: "detached" });
      await (uncertainFirst ? check : retry).waitFor();
      expect(await banner.count()).toBe(1);
      expect(await banner.textContent()).toContain("Connection interrupted.");
      expect(retries).toHaveLength(uncertainFirst ? 1 : 0);
      expect(await picker.isDisabled()).toBe(uncertainFirst);

      await composer.fill("Keep this draft after Clear view");
      await banner.getByRole("button").waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe("Keep this draft after Clear view");
      expect(await banner.textContent()).toContain("Connection interrupted.");
      expect(retries).toHaveLength(uncertainFirst ? 1 : 0);
      await composer.fill("");
      await (uncertainFirst ? check : retry).waitFor();
      if (evidenceDir)
        await page.screenshot({
          path: `${evidenceDir}/clear-view-${uncertainFirst ? "uncertain" : "retry"}-desktop.png`,
          fullPage: true,
        });
      if (!uncertainFirst) {
        await retry.click();
        await check.waitFor();
      }
      expect(await picker.isDisabled()).toBe(true);
      await check.click();
      await banner.getByRole("status").waitFor();
      expect(retries).toHaveLength(2);
      expect(retries[1]).toEqual(retries[0]);
      expect(retries[0]).toMatchObject({ failureEventId: failureId, model: "gpt-5.6-sol" });
      expect(await banner.getByRole("button").count()).toBe(0);
      expect(await composer.inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("a failure without a retained logical turn never offers Retry", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await installApi(page, false, [], false);
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
    const banner = page.getByTestId("failed-session-banner");
    await banner.waitFor();
    await page.getByRole("button", { name: "Model and effort", exact: true }).waitFor();
    expect(await banner.getByRole("button").count()).toBe(0);
    expect(await page.getByPlaceholder("Send a follow-up…").isEnabled()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

test("permission-disabled model picker never receives recovery guidance", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await installApi(page, true, [], true, false);
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
    const banner = page.getByTestId("failed-session-banner");
    await banner.waitFor();
    const picker = page.getByRole("button", { name: "Model and effort", exact: true });
    await picker.waitFor();
    expect(await picker.isDisabled()).toBe(true);
    expect(await banner.textContent()).toBe("This model isn’t available.");
    expect(await banner.getByRole("alert").count()).toBe(0);
    expect(await banner.getByRole("button").count()).toBe(0);
    if (evidenceDir)
      await page.screenshot({
        path: `${evidenceDir}/permission-disabled-desktop.png`,
        fullPage: true,
      });
  } finally {
    await page.close();
  }
}, 60_000);

async function installApi(
  page: Page,
  unsupported: boolean,
  retries: unknown[],
  retainedTurn = true,
  canControl = true,
) {
  const workspace = {
    id: workspaceId,
    accountId,
    kind: "shared",
    name: "Recovery review",
    slug: "recovery-review",
    settings: {},
    agentInstructions: null,
    defaultRigId: null,
    createdAt: now,
    updatedAt: now,
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
  };
  const session = {
    id: sessionId,
    workspaceId,
    accountId,
    status: "failed",
    title: "Failed-session recovery",
    titleSource: "user",
    initialMessage: "Review the implementation and verify the tests.",
    instructions: null,
    policyRole: null,
    resources: [],
    skills: [],
    tools: [],
    toolPolicy: { mode: "explicit" },
    toolPolicyVersion: 0,
    metadata: {},
    createdBy: { type: "user", id: "fixture" },
    createdByContext: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
    sandboxOs: "linux",
    sandboxGroupId: sessionId,
    activeSandboxId: null,
    activeEpoch: 0,
    workingDir: null,
    variableSetIds: [],
    variableSetId: null,
    environmentId: null,
    rigId: null,
    rigVersionId: null,
    channelId: null,
    firstPartyMcpPermissions: null,
    firstPartyMcpTools: [],
    mcpServers: [],
    parentSessionId: null,
    rootSessionId: sessionId,
    nestedAgentDepth: 0,
    maxNestedAgentDepthOverride: null,
    effectiveMaxNestedAgentDepth: 8,
    nestedAgentDepthPolicySource: "default",
    nestedAgentDepthPolicySessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: null,
    activeTurnId: null,
    queueVersion: 0,
    queueHeadPosition: 0,
    queueTailPosition: 0,
    effectiveControl,
    lastSequence: 2,
    codexCompactionMode: "portable",
    createdAt: now,
    updatedAt: now,
    backgroundCommandActivity: { state: "idle", count: 0 },
    failureDiagnostics: {
      eventId: failureId,
      turnId: retainedTurn ? turnId : null,
      sequence: 2,
      occurredAt: now,
      payload: {
        error: unsupported
          ? "The model `example` is not supported with this account."
          : "Connection interrupted.",
      },
    },
  };
  const event = {
    id: "66666666-6666-4666-8666-666666666666",
    workspaceId,
    sessionId,
    turnId,
    sequence: 1,
    type: "user.message",
    payload: { text: session.initialMessage, resources: [] },
    occurredAt: now,
  };
  await page.route(`${baseUrl}/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
        body: JSON.stringify(body),
      });
    if (path === "/v1/config/client")
      return json({
        deploymentRevision: "",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: session.model,
        allowedModels: [session.model],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1048576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    if (path === "/v1/access/me")
      return json({
        mode: "configured",
        subjectId: "fixture",
        subjectLabel: "Fixture",
        accountGrants: [
          {
            accountId,
            subjectId: "fixture",
            role: "owner",
            permissions: ["account:admin", "workspace:admin"],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "fixture",
            permissions: [
              "workspace:admin",
              "sessions:read",
              "sessions:write",
              ...(canControl ? ["sessions:control"] : []),
              "files:read",
              "capabilities:read",
              "connections:read",
            ],
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    if (path === "/v1/workspaces") return json([workspace]);
    if (path === `/v1/workspaces/${workspaceId}`) return json(workspace);
    if (path.endsWith("/sessions"))
      return json({ sessions: [session], pinned: [], pinnedTruncated: false, nextCursor: null });
    if (path.endsWith(`/sessions/${sessionId}`)) return json(session);
    if (
      request.method() === "GET" &&
      path === `/v1/workspaces/${workspaceId}/sessions/${sessionId}/sandbox-recovery`
    ) {
      // Recovery reads require session control. This fixture has no sandbox,
      // so an authorized read reports unsupported, never checkpoint eligibility.
      if (!canControl) return json({ error: "Permission denied" }, 403);
      return json({
        version: 1,
        status: "unsupported",
        reason: "managed_modal_home_required",
        checkpoint: null,
        operationId: null,
      } satisfies SandboxRecoveryProjection);
    }
    if (path.endsWith("/events/stream"))
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path.endsWith("/events")) return json([event]);
    if (path.endsWith("/retry")) {
      retries.push(request.postDataJSON());
      return retries.length === 1
        ? json({ error: "Response unavailable" }, 503)
        : json({ outcome: "accepted", turnId, failureEventId: failureId });
    }
    if (path.endsWith("/queue"))
      return json({
        version: 0,
        effectiveControl,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: [],
        pendingInputs: [],
        pendingInputAttachment: null,
      });
    if (path.endsWith("/goal")) return json({ message: "No goal" }, 404);
    if (path.endsWith("/composer-draft"))
      return !canControl
        ? json({ error: "Permission denied" }, 403)
        : json({
            revision: 0,
            text: "",
            resources: [],
            model: session.model,
            reasoningEffort: "low",
            latencyMode: "standard",
            sourceTurnId: null,
            sourceTurnVersion: null,
            updatedAt: null,
          });
    if (path.endsWith("/lineage")) return json({ ancestors: [], children: [], truncated: false });
    if (path.endsWith("/human-input-requests")) return json({ requests: [] });
    if (path.endsWith("/background-commands")) return json({ commands: [] });
    if (path.endsWith("/models") || path.endsWith("/model-catalog"))
      return json({
        models: [
          {
            id: "supported-model",
            label: "Supported model",
            provider: "openai",
            providerLabel: "OpenAI",
            api: "responses",
            source: "opengeni",
            cost: "credits",
            credentialReadiness: {
              status: "ready",
              reason: null,
              basis: "configuration",
              checkedAt: null,
            },
            availability: { status: "available", selectable: true, reason: null, checkedAt: null },
          },
        ],
      });
    if (path.endsWith("/stream-capabilities"))
      return json(
        fakeCapabilities({
          sessionId,
          FileSystem: {
            available: false,
            readOnly: true,
            root: "/",
            pathSep: "/",
            treeMode: "lazy",
            reason: "backend_unsupported",
          },
          Git: { available: false, repos: [], reason: "backend_unsupported" },
        }),
      );
    if (path.endsWith("/machines"))
      return json({ machines: [], activeSandboxId: null, activeEpoch: 0 });
    if (path.endsWith("/capabilities")) return json({ items: [], installations: [] });
    if (path.endsWith("/connections")) return json({ connections: [] });
    if (path.endsWith("/integrations")) return json({ integrations: [] });
    if (path.endsWith("/connection-authorities")) return json({ authorities: [] });
    if (path.endsWith("/skills")) return json({ skills: [] });
    if (path.endsWith("/plugins")) return json({ plugins: [] });
    if (path.endsWith("/editable-artifacts") || path.endsWith("/published-artifacts"))
      return json({ artifacts: [], nextCursor: null });
    if (path.endsWith("/github/app"))
      return json({ configured: false, missing: [], installUrl: null });
    if (path.endsWith("/connections/github")) return json({ enabled: false, connection: null });
    if (path.endsWith("/feedback") || path.endsWith("/feedback/mine"))
      return json({ feedback: [], turns: [] });
    if (/\/(channels|variable-sets|rigs|machines|sandboxes|repositories)$/.test(path))
      return json([]);
    return json({ message: "Endpoint not provided by this fixture" }, 404);
  });
}
