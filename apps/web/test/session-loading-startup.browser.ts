// Production app + staged API responses, not a component imitation.
// Run after building apps/web: bun apps/web/test/session-loading-startup.browser.ts
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { fakeCapabilities } from "../../../packages/react/test/sandbox-fixtures";

const repo = new URL("../../..", import.meta.url).pathname;
const output = `${repo}/.agent/evidence/session-loading-startup`;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const web = await startProcess(
  ["bun", "run", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: `${repo}/apps/web`,
    ready: async () => (await fetch(base).catch(() => null))?.ok === true,
  },
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
await mkdir(output, { recursive: true });

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    release,
    entered,
    wait: async () => {
      reached();
      await pending;
    },
  };
}

const control = {
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
function fixtures() {
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    workspaceId,
    accountId,
    status: "idle",
    title: "Loading and startup verification",
    titleSource: "user",
    initialMessage: "Keep this conversation visible.",
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
    activeTurnId: null as string | null,
    queueVersion: 0,
    queueHeadPosition: 0,
    queueTailPosition: 0,
    effectiveControl: control,
    lastSequence: 1,
    codexCompactionMode: "portable",
    createdAt: now,
    updatedAt: now,
    dispatchWait: {
      state: "acknowledged",
      attempts: 1,
      nextAttemptAt: null,
      lastError: null as string | null,
    },
  };
  const workspace = {
    id: workspaceId,
    accountId,
    kind: "shared",
    name: "UX verification",
    slug: "ux-verification",
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
  const events: Record<string, unknown>[] = [
    {
      id: crypto.randomUUID(),
      workspaceId,
      sessionId,
      turnId,
      sequence: 1,
      type: "user.message",
      payload: { text: session.initialMessage, resources: [] },
      occurredAt: now,
    },
  ];
  return {
    session,
    workspace,
    events,
    turns: [] as Record<string, unknown>[],
    denyAccess: false,
    gates: { config: gate(), access: gate(), detail: gate(), history: gate(), send: gate() },
    draft: {
      revision: 0,
      text: "",
      resources: [],
      model: session.model,
      reasoningEffort: "low",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null as string | null,
    },
  };
}

async function installApi(page: Page, state: ReturnType<typeof fixtures>) {
  await page.route(`${base}/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
        body: JSON.stringify(body),
      });
    if (path === "/v1/config/client") {
      await state.gates.config.wait();
      return json({
        deploymentRevision: "",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: state.session.model,
        allowedModels: [state.session.model],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1048576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (path === "/v1/access/me") {
      await state.gates.access.wait();
      if (state.denyAccess) return json({ message: "Workspace access revoked" }, 403);
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
    }
    if (path === "/v1/workspaces") return json([state.workspace]);
    if (path === `/v1/workspaces/${workspaceId}`) return json(state.workspace);
    if (path === `/v1/workspaces/${workspaceId}/sessions`)
      return json({
        sessions: [state.session],
        pinned: [],
        pinnedTruncated: false,
        nextCursor: null,
        filtersApplied: true,
        sortBy: new URL(request.url()).searchParams.get("sortBy") ?? "updated",
        archiveStatus: new URL(request.url()).searchParams.get("archiveStatus") ?? "active",
      });
    if (path === `/v1/workspaces/${workspaceId}/sessions/${sessionId}`) {
      await state.gates.detail.wait();
      return json(state.session);
    }
    if (path.endsWith("/events/stream"))
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path.endsWith("/events")) {
      await state.gates.history.wait();
      return json(state.events);
    }
    if (path.endsWith("/composer-draft/submit")) {
      const input = request.postDataJSON();
      await state.gates.send.wait();
      const accepted = {
        id: crypto.randomUUID(),
        clientEventId: input.clientEventId,
        workspaceId,
        sessionId,
        turnId,
        sequence: 2,
        type: "user.message",
        payload: { text: input.text, resources: [], routing: "accepted_for_execution" },
        occurredAt: new Date().toISOString(),
      };
      const turn = {
        id: turnId,
        workspaceId,
        sessionId,
        triggerEventId: accepted.id,
        status: "queued",
        source: "user",
        position: 1,
        prompt: input.text,
        annotations: [],
        resources: [],
        tools: [],
        metadata: {},
        version: 1,
        executionGeneration: 0,
        activeAttemptId: null,
        createdAt: accepted.occurredAt,
        updatedAt: accepted.occurredAt,
      };
      state.events.push(accepted);
      // Match getSessionQueueSnapshot: direct admission is a physical queued
      // turn, but is intentionally absent from the operator-visible queue.
      state.turns = [];
      Object.assign(state.session, {
        status: "queued",
        lastSequence: 2,
        queueVersion: 1,
        updatedAt: accepted.occurredAt,
      });
      state.draft = { ...state.draft, text: "", revision: state.draft.revision + 1 };
      return json({
        accepted,
        turn,
        draft: state.draft,
        routing: "accepted_for_execution",
        receipt: { appliedQueueVersion: 1, affectedTurnIds: [turnId] },
        interruptionCount: 0,
        replay: false,
      });
    }
    if (path.endsWith("/composer-draft")) {
      if (request.method() === "PUT")
        state.draft = {
          ...state.draft,
          ...request.postDataJSON(),
          revision: state.draft.revision + 1,
        };
      return json(state.draft);
    }
    if (path.endsWith("/queue"))
      return json({
        version: state.session.queueVersion,
        effectiveControl: state.session.effectiveControl,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: state.turns,
        pendingInputs: [],
        pendingInputAttachment: null,
      });
    if (path.endsWith("/goal")) return json({ message: "No goal" }, 404);
    if (path.endsWith("/lineage")) return json({ ancestors: [], children: [], truncated: false });
    if (path.endsWith("/human-input-requests")) return json({ requests: [] });
    if (path.endsWith("/background-commands")) return json({ commands: [] });
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
    if (path.endsWith("/skills") || path.endsWith("/skills/content"))
      return json({ skills: [], nextCursor: null });
    if (path.endsWith("/plugins")) return json({ plugins: [] });
    if (path.endsWith("/github/app"))
      return json({ configured: false, missing: [], installUrl: null });
    if (path.endsWith("/connections/github")) return json({ enabled: false, connection: null });
    if (path.endsWith("/feedback") || path.endsWith("/feedback/mine"))
      return json({ feedback: [], turns: [] });
    if (/\/(channels|variable-sets|rigs|sandboxes|repositories)$/.test(path)) return json([]);
    return json({ message: "Endpoint not provided by fixture" }, 404);
  });
}

try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = fixtures();
    await installApi(page, state);
    const capture = async (name: string) =>
      page.screenshot({ path: `${output}/${width}-${name}.png` });
    try {
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      for (const phase of ["config", "access", "detail", "history"] as const) {
        await state.gates[phase].entered;
        await page.locator("[data-page-loading]").waitFor();
        assert.equal(
          await page.getByText(state.session.initialMessage, { exact: true }).count(),
          0,
          `No stale/genesis content during ${phase}`,
        );
        assert(
          !/Checking session|Opening session|Preparing session|Loading conversation|Loading page/.test(
            await page.locator("body").innerText(),
          ),
        );
        if (phase === "config" || phase === "access")
          assert.equal(
            await page.locator("[data-rail-scroll-viewport]").count(),
            0,
            "No tenant rail before access",
          );
        await capture(phase);
        state.gates[phase].release();
      }
      const transcript = page.locator('[data-testid="timeline-user"]');
      await transcript.getByText(state.session.initialMessage, { exact: true }).waitFor();
      await capture("ready");
      const input = page.getByRole("textbox", { name: /Message|Prompt/i }).first();
      await input.fill("Start this next step.");
      await input.press("Enter");
      await state.gates.send.entered;
      await transcript.getByText("Start this next step.", { exact: true }).waitFor();
      await capture("optimistic");
      state.gates.send.release();
      await page
        .locator('[data-session-dispatch-wait] [role="status"]')
        .getByText("Starting", { exact: true })
        .waitFor();
      assert.equal(await transcript.getByText("Start this next step.", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: /queued prompt/i }).count(), 0);
      assert.equal(await page.locator('[data-og-session-chrome-panel="queue"]').count(), 0);
      assert.equal(
        await page.locator("header [data-status=queued]").first().textContent(),
        "Starting",
      );
      await capture("starting");
      // A hard reconnect must recover durable admission without moving the bubble.
      await page.reload();
      await transcript.getByText("Start this next step.", { exact: true }).waitFor();
      await capture("reconnected");
      state.session.updatedAt = new Date(Date.now() - 60_000).toISOString();
      await page.reload();
      await page.getByText("Still waiting to start", { exact: true }).waitFor();
      assert.equal(await transcript.getByText("Start this next step.", { exact: true }).count(), 1);
      await capture("stalled");
      state.session.dispatchWait = {
        state: "pending",
        attempts: 3,
        nextAttemptAt: null,
        lastError: "Worker dispatch unavailable",
      };
      await page.reload();
      await page.getByText("Unable to start yet", { exact: true }).waitFor();
      await page.getByText("Start details", { exact: true }).click();
      await page
        .getByText("Last recorded dispatch error: Worker dispatch unavailable", { exact: true })
        .waitFor();
      await capture("retry");
      Object.assign(state.session, { status: "waiting_capacity" });
      await page.reload();
      await page.locator("header [data-status=waiting_capacity]:visible").waitFor();
      await capture("capacity");
      Object.assign(state.session, { status: "running", activeTurnId: turnId });
      state.turns = [];
      await page.reload();
      await page.locator("header [data-status=running]:visible").waitFor();
      await transcript.getByText("Start this next step.", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-session-dispatch-wait]").count(), 0);
      await capture("running");
      state.turns = [
        {
          id: "55555555-5555-4555-8555-555555555555",
          sessionId,
          workspaceId,
          triggerEventId: crypto.randomUUID(),
          status: "queued",
          source: "user",
          position: 2,
          prompt: "A genuine follow-up behind running work",
          resources: [],
          tools: [],
          metadata: {},
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      await page.reload();
      await page.getByRole("button", { name: /1 queued prompt/ }).waitFor();
      await page.getByRole("list", { name: "Queued prompts" }).waitFor();
      await capture("genuine-queue");
      state.session.effectiveControl = { ...control, state: "paused", directState: "paused" };
      await page.reload();
      await page.getByRole("list", { name: "Queued prompts" }).waitFor();
      assert.equal(await page.locator("[data-session-dispatch-wait]").count(), 0);
      await capture("paused-queue");
      state.denyAccess = true;
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.equal(await page.locator("[data-rail-scroll-viewport]").count(), 0);
      assert.equal(await transcript.count(), 0);
      await capture("access-error");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      console.log(
        `Verified staged production refresh + optimistic/accepted/reconnect/stall/retry/capacity/running/genuine+paused-queue/access-error at ${width}px`,
      );
    } catch (error) {
      await capture("failure");
      throw new Error(
        `${width}px: ${JSON.stringify(errors)}\n${await page.locator("body").innerText()}`,
        { cause: error },
      );
    } finally {
      for (const deferred of Object.values(state.gates)) deferred.release();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await web.stop();
}
