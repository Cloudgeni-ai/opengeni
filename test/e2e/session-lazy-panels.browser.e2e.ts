import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { fakeCapabilities } from "../../packages/react/test/sandbox-fixtures";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const fileId = "66666666-6666-4666-8666-666666666666";
const now = "2026-01-01T12:00:00.000Z";
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

type Mode = "questions" | "commands" | "attachments";
type State = {
  mode: Mode;
  answers: unknown[];
  stops: number;
  commandReads: number;
  fileReads: number;
};

describe("production session conditional loading", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  let panelAsset: string;
  let attachmentAsset: string;
  const evidenceDir = `${repoRoot}/.agent/evidence/session-lazy-panels`;

  beforeAll(async () => {
    // Exercise the normal production build, including the unmodified budget gate.
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: { NODE_ENV: "production", VITE_API_BASE_URL: "" },
      timeoutMs: 120_000,
    });
    if (build.exitCode !== 0)
      throw new Error(`Production build failed:\n${build.stderr}\n${build.stdout.slice(-6000)}`);
    const manifest = JSON.parse(
      await readFile(`${repoRoot}/apps/web/dist/.vite/manifest.json`, "utf8"),
    ) as Record<string, { file: string; name?: string }>;
    panelAsset = Object.values(manifest).find(
      (entry) => entry.name === "session-conditional-panels",
    )!.file;
    attachmentAsset = manifest["src/components/session/message-resource-attachments.tsx"]!.file;
    expect(panelAsset).toBeTruthy();
    expect(attachmentAsset).toBeTruthy();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 30_000,
      },
    );
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    await mkdir(evidenceDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const width of [320, 1280]) {
    for (const mode of ["questions", "commands", "attachments"] as const) {
      test(`${mode} remains usable across its production lazy boundary at ${width}px`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        const consoleErrors: string[] = [];
        const assets: string[] = [];
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
        page.on("console", async (message) => {
          if (message.type() !== "error") return;
          for (const argument of message.args()) {
            consoleErrors.push(
              await argument
                .evaluate((value) =>
                  value instanceof Error ? (value.stack ?? value.message) : String(value),
                )
                .catch(() => "Console argument unavailable"),
            );
          }
        });
        page.on("request", (request) => {
          if (request.url().includes("/assets/")) assets.push(request.url());
        });
        const state: State = { mode, answers: [], stops: 0, commandReads: 0, fileReads: 0 };
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const blockedAsset = mode === "attachments" ? attachmentAsset : panelAsset;
        await page.route(`${baseUrl}/${blockedAsset}`, async (route) => {
          await blocked;
          await route.continue();
        });
        await installApi(page, baseUrl, state);
        try {
          await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
          const transcript = page
            .locator('[data-testid="timeline-user"]')
            .getByText("Keep this message visible.", { exact: true });
          await Promise.race([
            transcript.waitFor({ timeout: 20_000 }),
            page
              .getByRole("button", { name: "Show Error", exact: true })
              .waitFor({ timeout: 20_000 })
              .then(() => {
                throw new Error("Route render failed");
              }),
          ]);
          if (mode === "commands") {
            expect(state.commandReads).toBe(0);
            expect(assets.some((url) => url.endsWith(panelAsset))).toBe(false);
            await page.getByRole("button", { name: "Session activity", exact: true }).click();
            await page.getByRole("button", { name: "1 command", exact: true }).waitFor();
            await page.getByText("Loading commands…", { exact: true }).waitFor();
          } else if (mode === "questions") {
            await page.getByText("Loading questions…", { exact: true }).waitFor();
          } else {
            expect(state.fileReads).toBe(0);
            expect(await page.locator('[data-testid="timeline-user"] .animate-pulse').count()).toBe(
              1,
            );
          }
          expect(await transcript.isVisible()).toBe(true);
          await page.screenshot({
            path: `${evidenceDir}/${mode}-${width}-loading.png`,
            fullPage: true,
          });
          release();

          if (mode === "questions") {
            const choice = page.getByRole("radio", { name: "Staging", exact: true });
            await choice.waitFor();
            await page.screenshot({
              path: `${evidenceDir}/${mode}-${width}-loaded.png`,
              fullPage: true,
            });
            await choice.focus();
            await page.keyboard.press("Space");
            await page.getByRole("button", { name: "Send answers", exact: true }).focus();
            await page.keyboard.press("Enter");
            await page.waitForFunction(() => !document.querySelector("[data-human-input-surface]"));
            expect(state.answers).toEqual([
              {
                outcome: "answered",
                answers: [{ questionId: "environment", values: ["staging"] }],
              },
            ]);
          } else if (mode === "commands") {
            const stop = page.getByRole("button", { name: "Stop bun run verify", exact: true });
            await stop.waitFor();
            await page.screenshot({
              path: `${evidenceDir}/${mode}-${width}-loaded.png`,
              fullPage: true,
            });
            await stop.focus();
            await page.keyboard.press("Enter");
            await page.getByText("Stopping…", { exact: true }).waitFor();
            expect(state.stops).toBe(1);
            expect(state.commandReads).toBeGreaterThanOrEqual(2);
          } else {
            const preview = page.getByRole("button", { name: "Open fixture.svg", exact: true });
            await preview.waitFor();
            await page.waitForFunction(() => {
              const image = document.querySelector(
                '[data-testid="timeline-user"] img',
              ) as HTMLImageElement | null;
              return Boolean(image?.complete && image.naturalWidth > 0);
            });
            expect(state.fileReads).toBe(1);
            await page.screenshot({
              path: `${evidenceDir}/${mode}-${width}-loaded.png`,
              fullPage: true,
            });
            await preview.click();
            await page.getByRole("dialog").waitFor();
            await page.keyboard.press("Escape");
          }
          expect(await transcript.isVisible()).toBe(true);
          expect(assets.some((url) => url.endsWith(blockedAsset))).toBe(true);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          ).toBeLessThanOrEqual(1);
          expect(errors).toEqual([]);
          await page.screenshot({
            path: `${evidenceDir}/${mode}-${width}-ready.png`,
            fullPage: true,
          });
        } catch (error) {
          const showError = page.getByRole("button", { name: "Show Error", exact: true });
          if (await showError.isVisible()) await showError.click();
          throw new Error(
            `${mode}/${width}: ${JSON.stringify({ errors, consoleErrors })}\n${await page.locator("body").innerText()}`,
            { cause: error },
          );
        } finally {
          release();
          await context.close();
        }
      }, 45_000);
    }
  }
});

async function installApi(page: Page, baseUrl: string, state: State) {
  const workspace = {
    id: workspaceId,
    accountId,
    kind: "shared",
    name: "Session loading test",
    slug: "session-loading",
    settings: {},
    agentInstructions: null,
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: now,
    updatedAt: now,
  };
  const resources = state.mode === "attachments" ? [{ kind: "file", fileId }] : [];
  const session = {
    id: sessionId,
    workspaceId,
    accountId,
    status: state.mode === "questions" ? "requires_action" : "idle",
    title: "Conditional session surfaces",
    titleSource: "user",
    initialMessage: "Keep this message visible.",
    instructions: null,
    policyRole: null,
    resources,
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
    activeTurnId: state.mode === "questions" ? turnId : null,
    queueVersion: 0,
    queueHeadPosition: 0,
    queueTailPosition: 0,
    effectiveControl,
    lastSequence: 1,
    codexCompactionMode: "portable",
    createdAt: now,
    updatedAt: now,
    backgroundCommandActivity: { state: "running", count: state.mode === "commands" ? 1 : 0 },
  };
  const event = {
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId,
    sessionId,
    turnId,
    sequence: 1,
    type: "user.message",
    payload: { text: "Keep this message visible.", resources },
    occurredAt: now,
  };
  await page.route(`${baseUrl}/fixture.svg`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#7861a8"/></svg>',
    }),
  );
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
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
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
              "sessions:control",
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
    if (path === `/v1/workspaces/${workspaceId}/sessions`)
      return json({ sessions: [session], pinned: [], pinnedTruncated: false, nextCursor: null });
    if (path === `/v1/workspaces/${workspaceId}/sessions/${sessionId}`) return json(session);
    if (path.endsWith("/events/stream"))
      return route.fulfill({
        contentType: "text/event-stream",
        headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
        body: ": fixture\n\n",
      });
    if (path.endsWith("/events") && request.method() === "POST") {
      const input = request.postDataJSON();
      if (input.type === "user.humanInputResponse") state.answers.push(input.payload.response);
      return json({
        ...event,
        id: crypto.randomUUID(),
        sequence: 2,
        type: input.type,
        payload: input.payload,
      });
    }
    if (path.endsWith("/events")) return json([event]);
    if (path.endsWith("/human-input-requests"))
      return json({
        requests:
          state.mode === "questions" && !state.answers.length
            ? [
                {
                  id: requestId,
                  workspaceId,
                  sessionId,
                  turnId,
                  turnGeneration: 1,
                  creationAttemptId: requestId,
                  toolCallId: "question",
                  status: "pending",
                  questions: [
                    {
                      id: "environment",
                      kind: "single_select",
                      prompt: "Choose an environment",
                      options: [{ id: "staging", label: "Staging" }],
                      required: true,
                      allowOther: false,
                    },
                  ],
                  allowSkip: true,
                  response: null,
                  respondedBy: null,
                  respondedAt: null,
                  expiresAt: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]
            : [],
      });
    const command = {
      id: "command-1",
      workspaceId,
      sessionId,
      provider: "managed",
      state: state.stops ? "stopping" : "running",
      commandPreview: "bun run verify",
      cancelRequestedAt: state.stops ? now : null,
      exitCode: null,
      settlementReason: null,
      startedAt: now,
      settledAt: null,
      updatedAt: now,
    };
    if (path.endsWith("/background-commands/command-1")) {
      state.stops++;
      return json({ accepted: true, command: { ...command, state: "stopping" } });
    }
    if (path.endsWith("/background-commands")) {
      state.commandReads++;
      return json({ commands: [command] });
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
      return json({
        revision: 0,
        text: "",
        resources: [],
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: null,
      });
    if (path.endsWith("/lineage")) return json({ ancestors: [], children: [], truncated: false });
    if (path.endsWith(`/files/${fileId}`)) {
      state.fileReads++;
      return json({
        id: fileId,
        workspaceId,
        filename: "fixture.svg",
        contentType: "image/svg+xml",
        sizeBytes: 140,
        createdAt: now,
      });
    }
    if (path.includes(`/files/${fileId}/`))
      return json({ url: `${baseUrl}/fixture.svg`, expiresAt: "2099-01-01T00:00:00.000Z" });
    if (path.endsWith("/models") || path.endsWith("/model-catalog")) return json({ models: [] });
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
    if (path.endsWith("/editable-artifacts") || path.endsWith("/published-artifacts"))
      return json({ artifacts: [], nextCursor: null });
    if (path.endsWith("/connection-authorities")) return json({ authorities: [] });
    if (path.endsWith("/skills")) return json({ skills: [] });
    if (path.endsWith("/plugins")) return json({ plugins: [] });
    if (path.endsWith("/packs")) return json({ packs: [], installations: [] });
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
