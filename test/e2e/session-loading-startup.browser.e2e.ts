// Production app + staged API responses, not a component imitation.
// The production artifact is built once and shared by both viewport tests.
import { afterAll, beforeAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { fakeCapabilities } from "../../packages/react/test/sandbox-fixtures";

const repo = new URL("../..", import.meta.url).pathname;
const output =
  process.env.SESSION_LOADING_ARTIFACT_DIR ?? `${repo}/.agent/evidence/session-loading-startup`;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const otherSessionId = "33333333-3333-4333-8333-444444444444";
const turnId = "44444444-4444-4444-8444-444444444444";
let base: string;
let web: StartedProcess | undefined;
let browser: Browser;

async function cleanup() {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}

beforeAll(async () => {
  try {
    // Match session-lazy-panels: production chunks and the unchanged budget gate,
    // with one build for the suite rather than a build per viewport/state.
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repo}/apps/web`,
      env: { NODE_ENV: "production", VITE_API_BASE_URL: "" },
      timeoutMs: 180_000,
    });
    if (build.exitCode !== 0)
      throw new Error(
        `Production web build failed:\n${build.stderr}\n${build.stdout.slice(-6000)}`,
      );
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
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
        cwd: `${repo}/apps/web`,
        ready: async () =>
          (await fetch(base, { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok === true,
        timeoutMs: 30_000,
      },
    );
    const executablePath =
      process.env.CHROMIUM_EXECUTABLE_PATH ??
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      process.env.OPENGENI_BROWSER_BIN ??
      ["/opt/google/chrome/chrome", "/usr/local/bin/chromium"].find(existsSync);
    browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    await mkdir(output, { recursive: true });
  } catch (error) {
    // Includes launch failure after the preview server has already started.
    await cleanup();
    throw error;
  }
}, 210_000);
afterAll(cleanup);

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
  const now = new Date(Date.now() - 60_000).toISOString();
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
    failHistory: false,
    emptyHistory: false,
    paginatedHistory: false,
    failStream: false,
    deferDetail: false,
    gates: {
      config: gate(),
      access: gate(),
      detail: gate(),
      history: gate(),
      send: gate(),
      other: gate(),
      stream: gate(),
      streamError: gate(),
      dispatchDetail: gate(),
    },
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
        sessions: [
          state.session,
          { ...state.session, id: otherSessionId, title: "Unloaded other session" },
        ],
        pinned: [],
        pinnedTruncated: false,
        nextCursor: null,
        filtersApplied: true,
        sortBy: new URL(request.url()).searchParams.get("sortBy") ?? "updated",
        archiveStatus: new URL(request.url()).searchParams.get("archiveStatus") ?? "active",
      });
    if (
      path === `/v1/workspaces/${workspaceId}/sessions/${otherSessionId}` ||
      path === `/v1/workspaces/${workspaceId}/sessions/${otherSessionId}/events`
    ) {
      await state.gates.other.wait();
      return json(
        path.endsWith("/events")
          ? []
          : { ...state.session, id: otherSessionId, title: "Unloaded other session" },
      );
    }
    if (path === `/v1/workspaces/${workspaceId}/sessions/${sessionId}`) {
      await state.gates.detail.wait();
      if (state.deferDetail) await state.gates.dispatchDetail.wait();
      return json(state.session);
    }
    if (path.endsWith("/events/stream")) {
      if (state.failStream) {
        await state.gates.streamError.wait();
        return json({ message: "Live event stream unavailable" }, 400);
      }
      await state.gates.stream.wait();
      const after = Number(new URL(request.url()).searchParams.get("after") ?? 0);
      return route.fulfill({
        contentType: "text/event-stream",
        body: state.events
          .filter((event) => Number(event.sequence) > after)
          .map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    }
    if (path.endsWith("/events")) {
      await state.gates.history.wait();
      if (state.failHistory) return json({ message: "Initial history unavailable" }, 503);
      if (state.paginatedHistory) {
        const params = new URL(request.url()).searchParams;
        const limit = Number(params.get("limit") ?? 200);
        const before = Number(params.get("before") ?? Number.MAX_SAFE_INTEGER);
        const after = Number(params.get("after") ?? 0);
        const matching = state.events.filter(
          (event) => Number(event.sequence) > after && Number(event.sequence) < before,
        );
        return json(
          params.has("before") || params.get("direction") === "before"
            ? matching.slice(-limit)
            : matching.slice(0, limit),
        );
      }
      return json(state.emptyHistory ? [] : state.events);
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
      state.events.push({
        id: crypto.randomUUID(),
        workspaceId,
        sessionId,
        turnId,
        sequence: 3,
        type: "session.status.changed",
        payload: { status: "queued" },
        occurredAt: accepted.occurredAt,
      });
      // Match getSessionQueueSnapshot: direct admission is a physical queued
      // turn, but is intentionally absent from the operator-visible queue.
      state.turns = [];
      Object.assign(state.session, {
        status: "queued",
        lastSequence: 3,
        queueVersion: 1,
        updatedAt: accepted.occurredAt,
      });
      state.draft = { ...state.draft, text: "", revision: state.draft.revision + 1 };
      state.deferDetail = true;
      state.gates.stream.release();
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

for (const width of [1280, 390]) {
  test(`production refresh and truthful startup at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = fixtures();
    state.failHistory = true;
    await installApi(page, state);
    const capture = async (name: string) =>
      page.screenshot({ path: `${output}/${width}-${name}.png` });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      let anchor: { x: number; y: number; width: number; height: number } | null = null;
      let animationOrigin: number | null = null;
      for (const phase of ["config", "access", "detail", "history"] as const) {
        await state.gates[phase].entered;
        await page.locator("[data-page-loading]").waitFor();
        const loading = page.locator("[data-page-loading]");
        const box = await loading.boundingBox();
        assert(box);
        if (anchor) {
          for (const axis of ["x", "y", "width", "height"] as const)
            assert(
              Math.abs(box[axis] - anchor[axis]) <= 1,
              `Loading anchor changed during ${phase}: ${JSON.stringify({ box, anchor })}`,
            );
        } else anchor = box;
        assert.equal(
          await loading.evaluate((element) => getComputedStyle(element).pointerEvents),
          "none",
        );
        const origin = await loading.locator("svg").evaluate((element) => {
          const animation = element.getAnimations()[0];
          return animation
            ? Number(animation.startTime) + Number(animation.effect!.getTiming().delay)
            : null;
        });
        assert(origin !== null, "loading animation is active");
        if (animationOrigin !== null) {
          const delta = (((origin - animationOrigin) % 1000) + 1000) % 1000;
          assert(
            Math.min(delta, 1000 - delta) < 120,
            `Loading animation restarted during ${phase}: ${delta}`,
          );
        } else animationOrigin = origin;
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
      await page.emulateMedia({ reducedMotion: "reduce" });
      const transcript = page.locator('[data-testid="timeline-user"]');
      await page.getByRole("button", { name: "Retry conversation", exact: true }).waitFor();
      assert.equal(
        await transcript.count(),
        0,
        "failed first history read must not show genesis fallback",
      );
      await capture("history-error");
      state.failHistory = false;
      state.emptyHistory = true;
      state.failStream = true;
      state.gates.history = gate();
      await page.getByRole("button", { name: "Retry conversation", exact: true }).click();
      await state.gates.history.entered;
      await page.locator("[data-page-loading]").waitFor();
      assert.equal(await transcript.count(), 0, "retry must remain pending until history succeeds");
      await capture("history-retry");
      state.gates.history.release();
      await transcript.getByText(state.session.initialMessage, { exact: true }).waitFor();
      // Let the real transient error notification settle before capturing the
      // recovered conversation and exercising the unrelated startup sequence.
      await page.locator("[data-sonner-toast]").waitFor({ state: "hidden" });
      await capture("empty-history-ready");
      assert.equal(await page.getByRole("button", { name: "Retry conversation" }).count(), 0);
      await page
        .getByRole("textbox", { name: /Message|Prompt/i })
        .first()
        .waitFor();
      await state.gates.streamError.entered;
      state.gates.streamError.release();
      await page.getByText(/Live event stream unavailable/).waitFor();
      assert.equal(await page.locator("[data-page-loading]").count(), 0);
      assert.equal(
        await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
        1,
      );
      await page
        .getByRole("textbox", { name: /Message|Prompt/i })
        .first()
        .waitFor();
      await capture("post-open-stream-error");
      state.failStream = false;
      state.emptyHistory = false;
      if (width < 1024)
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.locator(`a[data-session-row="${otherSessionId}"]:visible`).click();
      await state.gates.other.entered;
      await page.locator("[data-page-loading]").waitFor();
      await capture("other-pending");
      state.gates.history = gate();
      await page.goBack();
      await state.gates.history.entered;
      await page.locator("[data-page-loading]").waitFor();
      assert.equal(
        await transcript.count(),
        0,
        "returning A through unloaded B must not reuse A's opening lifetime",
      );
      const returnedAnchor = await page.locator("[data-page-loading]").boundingBox();
      assert(returnedAnchor && anchor);
      assert(
        Math.abs(returnedAnchor.x - anchor.x) <= 1 && Math.abs(returnedAnchor.y - anchor.y) <= 1,
      );
      await capture("return-pending");
      state.gates.history.release();
      state.gates.other.release();
      await transcript.getByText(state.session.initialMessage, { exact: true }).waitFor();
      await page.locator("[data-sonner-toast]").waitFor({ state: "hidden" });
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
      await state.gates.dispatchDetail.entered;
      assert.equal(await page.getByText("Still waiting to start", { exact: true }).count(), 0);
      await capture("delayed-detail");
      state.deferDetail = false;
      state.gates.dispatchDetail.release();
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
  }, 90_000);

  test(`production latest-tail reload never resurrects genesis at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const state = fixtures();
    state.paginatedHistory = true;
    state.session.initialMessage = "Original first question must not reappear.";
    state.session.lastSequence = 5000;
    state.events = Array.from({ length: 5000 }, (_, index) => ({
      id: crypto.randomUUID(),
      workspaceId,
      sessionId,
      turnId: crypto.randomUUID(),
      sequence: index + 1,
      type: "user.message",
      payload: {
        text: index === 0 ? state.session.initialMessage : `History question ${index + 1}`,
        resources: [],
      },
      occurredAt: state.session.createdAt,
    }));
    for (const name of ["config", "access", "detail", "history"] as const)
      state.gates[name].release();
    await installApi(page, state);
    const capture = (name: string) => page.screenshot({ path: `${output}/${width}-${name}.png` });
    const transcript = page.locator('[data-testid="timeline-user"]');
    const input = page.getByRole("textbox", { name: /Message|Prompt/i }).first();
    const assertRetained = async () => {
      assert.equal(
        await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
        0,
      );
      assert.equal(await input.getAttribute("data-reload-probe"), "same-composer");
      assert(await input.isVisible());
    };
    try {
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      await transcript.getByText("History question 5000", { exact: true }).waitFor();
      await input.evaluate((node) => node.setAttribute("data-reload-probe", "same-composer"));
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.hover();
      await page.mouse.wheel(0, -500);
      await scroller.evaluate((node) => {
        node.scrollTop = 0;
      });
      // Use the production keyboard action; the adjacent question-navigation
      // overlay can cover this top-gutter pointer target while scrolling.
      const oldest = page.getByRole("button", { name: "Jump to start", exact: true });
      await oldest.focus();
      await oldest.press("Enter");
      await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
      state.gates.history = gate();
      await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
      await state.gates.history.entered;
      await page.locator("[data-page-loading]").waitFor();
      await assertRetained();
      await capture("latest-pending");
      state.failHistory = true;
      state.gates.history.release();
      await page.getByRole("button", { name: "Retry conversation", exact: true }).waitFor();
      await assertRetained();
      await capture("latest-failed");
      state.failHistory = false;
      state.gates.history = gate();
      await page.getByRole("button", { name: "Retry conversation", exact: true }).click();
      await state.gates.history.entered;
      await page.locator("[data-page-loading]").waitFor();
      await assertRetained();
      await capture("latest-retry");
      state.gates.history.release();
      await transcript.getByText("History question 5000", { exact: true }).waitFor();
      await assertRetained();
      await capture("latest-ready");
    } catch (error) {
      await capture("latest-failure");
      throw new Error(`${width}px latest reload: ${await page.locator("body").innerText()}`, {
        cause: error,
      });
    } finally {
      for (const deferred of Object.values(state.gates)) deferred.release();
      await context.close();
    }
  }, 90_000);
}
