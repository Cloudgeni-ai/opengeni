import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000701";
const accountId = "00000000-0000-4000-8000-000000000702";
const artifactId = "00000000-0000-4000-8000-000000000703";
const versionId = "00000000-0000-4000-8000-000000000704";
const releaseId = "00000000-0000-4000-8000-000000000705";
const runtimeSessionId = "00000000-0000-4000-8000-000000000706";
const sessionId = "00000000-0000-4000-8000-000000000707";
const approvalId = "site-runtime-write-approval";
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;

type BrowserState = {
  sitePublishes: Array<Record<string, unknown>>;
  runtimeStarts: Array<Record<string, unknown>>;
  approvalDecisions: Array<Record<string, unknown>>;
};

describe("Sites browser e2e", () => {
  let browser: Browser;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
        "--force",
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
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("runs a credential-free Site bridge while OpenGeni owns AI and approvals", async () => {
    const state: BrowserState = {
      sitePublishes: [],
      runtimeStarts: [],
      approvalDecisions: [],
    };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installSitesApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sites`, {
        waitUntil: "networkidle",
      });

      await page.getByRole("heading", { name: "Sites", exact: true }).waitFor();
      expect(await page.getByText("SINTEF Local Data Copilot", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Advanced deployments", { exact: true }).count()).toBe(0);

      await page.getByRole("button", { name: "Configure & publish" }).click();
      await page
        .getByRole("heading", {
          name: "Review capabilities for SINTEF Local Data Copilot",
        })
        .waitFor();
      expect(await page.getByLabel("Allowed models (comma separated)").inputValue()).toBe(
        "gpt-5.6-sol",
      );
      expect(await page.getByLabel("Write actions").inputValue()).toBe("platform_prompt");
      await page.getByRole("button", { name: "Publish immutable release" }).click();
      await page.getByText("Site published", { exact: true }).waitFor();
      expect(state.sitePublishes).toHaveLength(1);
      expect(state.sitePublishes[0]?.reason).toBe("Initial Site release after capability review");

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sites/${artifactId}/run`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText("Workspace authenticated", { exact: true }).waitFor();
      const iframe = page.locator('iframe[title="SINTEF Local Data Copilot"]');
      await iframe.waitFor();
      expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");

      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeDefined();
      await frame!.waitForFunction(() => document.body.dataset.runtimeReady === "yes");
      expect(await frame!.locator("body").getAttribute("data-storage-blocked")).toBe("yes");
      expect(await frame!.locator("body").getAttribute("data-network-blocked")).toBe("yes");
      expect(await frame!.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(1);

      await frame!.getByRole("button", { name: "Ask OpenGeni" }).click();
      await frame!.getByText(`Session ${sessionId}`, { exact: true }).waitFor();
      expect(state.runtimeStarts).toHaveLength(1);
      expect(state.runtimeStarts[0]?.initialMessage).toBe("Summarize the local SINTEF dataset");

      const approval = page.getByText("Approval required outside the Site", {
        exact: true,
      });
      await approval.waitFor();
      expect(await frame!.getByText("Approval required outside the Site").count()).toBe(0);
      await page.getByRole("button", { name: "Approve once" }).click();
      expect(state.approvalDecisions).toHaveLength(1);
      expect(state.approvalDecisions[0]).toMatchObject({
        type: "user.approvalDecision",
        payload: { approvalId, decision: "approve" },
      });

      const frameAuthority = await frame!.evaluate(() => {
        const blocked = (read: () => unknown) => {
          try {
            read();
            return false;
          } catch {
            return true;
          }
        };
        return {
          localStorageBlocked: blocked(() => localStorage.length),
          sessionStorageBlocked: blocked(() => sessionStorage.length),
          cookiesBlocked: blocked(() => document.cookie),
        };
      });
      expect(frameAuthority).toEqual({
        localStorageBlocked: true,
        sessionStorageBlocked: true,
        cookiesBlocked: true,
      });
    } finally {
      await context.close();
    }
  }, 60_000);
});

async function installSitesApi(page: Page, state: BrowserState): Promise<void> {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const responseHeaders = { "x-opengeni-api-contract": apiContractRevision };
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers: responseHeaders,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/v1/config/client") {
      return json({
        deploymentRevision: "sites-browser-e2e",
        apiContractRevision,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "medium",
        allowedReasoningEfforts: ["medium"],
        mcpServers: [],
        firstPartyMcpTools: {
          default: ["memory_search"],
          allowed: ["memory_search"],
        },
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        sites: { enabled: true },
        advancedDeployments: { enabled: false },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: {
          fileSystem: false,
          git: false,
          terminalEvents: false,
        },
      });
    }
    if (url.pathname === "/v1/access/me") {
      const permissions = [
        "account:admin",
        "workspace:admin",
        "artifacts:read",
        "artifacts:publish",
        "sessions:create",
        "sessions:control",
      ];
      return json({
        mode: "configured",
        subjectId: "sites-browser-subject",
        subjectLabel: "Sites browser test",
        accountGrants: [
          {
            accountId,
            subjectId: "sites-browser-subject",
            role: "owner",
            permissions,
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "sites-browser-subject",
            permissions,
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    }
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}`) return json(workspace());
    if (url.pathname === `/v1/workspaces/${workspaceId}/sites`) {
      return json({ sites: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/published-artifacts`) {
      return json({
        artifacts: [artifact()],
        nextCursor: null,
        truncated: false,
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sites/${artifactId}`) {
      return json({
        site: site(),
        currentRelease: release(),
        releases: [release()],
        events: [],
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/sites/${artifactId}/releases`
    ) {
      state.sitePublishes.push(request.postDataJSON() as Record<string, unknown>);
      return json({ site: site(), release: release() }, 201);
    }
    if (
      url.pathname === `/v1/workspaces/${workspaceId}/published-artifacts/${artifactId}/content`
    ) {
      return json({
        artifactId,
        versionId,
        contentType: "text/html",
        contentSha256: "0".repeat(64),
        html: siteHtml(),
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/sites/${artifactId}/runtime/sessions`
    ) {
      state.runtimeStarts.push(request.postDataJSON() as Record<string, unknown>);
      return json(
        {
          runtimeSession: {
            schemaVersion: 1,
            id: runtimeSessionId,
            accountId,
            workspaceId,
            siteId: artifactId,
            releaseId,
            sessionId,
            createdBySubjectId: "sites-browser-subject",
            createdAt: new Date(0).toISOString(),
          },
          sessionId,
          eventsPath: `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events/stream`,
        },
        202,
      );
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events/stream`) {
      const event = {
        id: "00000000-0000-4000-8000-000000000708",
        workspaceId,
        sessionId,
        sequence: 1,
        type: "session.requiresAction",
        payload: {
          approvals: [
            {
              id: approvalId,
              name: "local_dataset_write",
              arguments: { dataset: "sintef-local" },
            },
          ],
        },
        occurredAt: new Date(1).toISOString(),
        clientEventId: null,
        turnId: "00000000-0000-4000-8000-000000000709",
      };
      return route.fulfill({
        status: 200,
        headers: { ...responseHeaders, "content-type": "text/event-stream" },
        body: `id: 1\nevent: session.requiresAction\ndata: ${JSON.stringify(event)}\n\n`,
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`
    ) {
      state.approvalDecisions.push(request.postDataJSON() as Record<string, unknown>);
      return json({
        id: "00000000-0000-4000-8000-000000000710",
        workspaceId,
        sessionId,
        sequence: 2,
        type: "user.approvalDecision",
        payload: { approvalId, decision: "approve" },
        occurredAt: new Date(2).toISOString(),
        clientEventId: null,
        turnId: "00000000-0000-4000-8000-000000000709",
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({
        sessions: [],
        pinned: [],
        pinnedTruncated: false,
        nextCursor: null,
      });
    }
    return json({});
  });
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    name: "SINTEF Internal Apps",
    slug: "sintef-internal-apps",
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
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function artifactVersion() {
  return {
    id: versionId,
    accountId,
    workspaceId,
    artifactId,
    revision: 1,
    contentType: "text/html",
    contentSha256: "0".repeat(64),
    sizeBytes: 1_024,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    createdBySubjectId: "sites-browser-subject",
    createdAt: new Date(0).toISOString(),
  };
}

function artifact() {
  return {
    id: artifactId,
    accountId,
    workspaceId,
    slug: "sintef-local-data-copilot",
    title: "SINTEF Local Data Copilot",
    description: "A local-data Site with native OpenGeni AI.",
    status: "active",
    currentVersion: artifactVersion(),
    createdBySubjectId: "sites-browser-subject",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function site() {
  return {
    schemaVersion: 1,
    runtimeKind: "static_spa",
    id: artifactId,
    accountId,
    workspaceId,
    artifactId,
    slug: "sintef-local-data-copilot",
    title: "SINTEF Local Data Copilot",
    description: "A local-data Site with native OpenGeni AI.",
    status: "active",
    currentReleaseId: releaseId,
    createdBySubjectId: "sites-browser-subject",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function release() {
  return {
    schemaVersion: 1,
    id: releaseId,
    accountId,
    workspaceId,
    siteId: artifactId,
    artifactVersionId: versionId,
    revision: 1,
    manifestHash: `sha256:${"0".repeat(64)}`,
    manifest: {
      schemaVersion: 1,
      ai: {
        enabled: true,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        reasoningEffort: "medium",
        instructions: "Use only approved local SINTEF data.",
        monthlyBudgetMicros: null,
      },
      integrations: {
        firstPartyPermissions: ["workspace:read"],
        firstPartyTools: ["memory_search"],
        mcpServers: [],
        allowedPersonalConnectionServerIds: [],
      },
      approvals: { writeActions: "platform_prompt" },
      access: { audience: "workspace" },
    },
    createdBySubjectId: "sites-browser-subject",
    createdAt: new Date(0).toISOString(),
  };
}

function siteHtml(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>SINTEF Local Data Copilot</title></head>
  <body>
    <h1>SINTEF Local Data Copilot</h1>
    <button id="ask" type="button">Ask OpenGeni</button>
    <output id="result">Waiting</output>
    <script>
      (async function () {
        try { localStorage.setItem("site-secret", "must-not-persist"); }
        catch (_) { document.body.dataset.storageBlocked = "yes"; }
        try { await fetch("https://example.invalid/must-not-run"); }
        catch (_) { document.body.dataset.networkBlocked = "yes"; }
        var runtime = await window.OpenGeniSite.connect();
        document.body.dataset.runtimeReady = "yes";
        document.getElementById("ask").addEventListener("click", async function () {
          var receipt = await runtime.ai.start({
            message: "Summarize the local SINTEF dataset",
            modelContext: "screen=sintef-local-data"
          });
          document.getElementById("result").textContent = "Session " + receipt.sessionId;
        });
      })();
    </script>
  </body>
</html>`;
}
