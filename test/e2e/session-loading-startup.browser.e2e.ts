// Production app + staged API responses, not a component imitation.
// The production artifact is built once and shared by both viewport tests.
import { afterAll, beforeAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
let questionAsset: string;
let composerMenuAsset: string;
let workspaceFilesAsset: string;

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
    const manifest = JSON.parse(
      await readFile(`${repo}/apps/web/dist/.vite/manifest.json`, "utf8"),
    ) as Record<string, { file: string; name?: string }>;
    const questionEntry = Object.entries(manifest).find(
      ([key, entry]) =>
        key.endsWith("/hooks/latest-question.ts") || entry.name === "session-question-navigation",
    );
    assert.ok(questionEntry, "Latest question must retain its optional production chunk");
    questionAsset = questionEntry[1].file;
    composerMenuAsset = manifest["src/components/composer-mobile-plus-panel.tsx"]!.file;
    assert.ok(composerMenuAsset, "Composer menu must retain its optional production chunk");
    workspaceFilesAsset = manifest["../../packages/react/src/components/sandbox-files.tsx"]!.file;
    assert.ok(workspaceFilesAsset, "Files must retain its optional production chunk");
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
    enableCreate: false,
    created: false,
    failStream: false,
    failQueue: false,
    deferQueue: false,
    nextQueueTransition: "" as "" | "fail" | "withdraw" | "hold",
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
      queue: gate(),
      create: gate(),
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
    newDraft: {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: session.model,
      reasoningEffort: "low",
      latencyMode: "standard",
      options: { sandboxBackend: "none" },
      selectionHistory: { projects: [] },
      updatedAt: null,
    } as Record<string, unknown>,
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
        defaultSandboxBackend: "none",
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
    if (path === `/v1/workspaces/${workspaceId}/sessions` && request.method() === "POST") {
      const input = request.postDataJSON();
      await state.gates.create.wait();
      state.created = true;
      state.session.initialMessage = input.initialMessage;
      state.session.lastSequence = 1;
      state.events = [
        {
          id: crypto.randomUUID(),
          workspaceId,
          sessionId,
          turnId,
          sequence: 1,
          clientEventId: input.clientEventId,
          type: "user.message",
          payload: { text: input.initialMessage, resources: [] },
          occurredAt: state.session.createdAt,
        },
      ];
      state.newDraft = {
        ...state.newDraft,
        text: "",
        revision: Number(state.newDraft.revision) + 1,
      };
      return json(state.session);
    }
    if (path === `/v1/workspaces/${workspaceId}/sessions`)
      return json({
        sessions:
          state.enableCreate && !state.created
            ? []
            : [
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
    if (path === `/v1/workspaces/${workspaceId}/sessions/${otherSessionId}/events/stream`)
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
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
        const includeTypes = params.get("includeTypes")?.split(",");
        const matching = state.events.filter(
          (event) =>
            Number(event.sequence) > after &&
            Number(event.sequence) < before &&
            (!includeTypes || includeTypes.includes(String(event.type))),
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
    if (path.endsWith("/queue")) {
      if (path.includes(otherSessionId))
        return json({
          version: 0,
          effectiveControl: control,
          items: [],
          pendingInputs: [],
          pendingInputAttachment: null,
        });
      if (state.deferQueue) await state.gates.queue.wait();
      if (state.failQueue) return json({ message: "Queue unavailable" }, 503);
      const snapshot = {
        version: state.session.queueVersion,
        effectiveControl: state.session.effectiveControl,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: state.turns,
        pendingInputs: [],
        pendingInputAttachment: null,
      };
      const transition = state.nextQueueTransition;
      state.nextQueueTransition = "";
      if (transition === "fail") state.failQueue = true;
      if (transition === "withdraw") {
        state.turns = [];
        state.session.queueVersion += 1;
        state.events.push({
          id: crypto.randomUUID(),
          workspaceId,
          sessionId,
          turnId: snapshot.items[0]?.id,
          sequence: 5,
          type: "session.queue.changed",
          payload: { operation: "delete", turnId: snapshot.items[0]?.id },
          occurredAt: state.session.updatedAt,
        });
      }
      if (transition === "hold") state.deferQueue = true;
      return json(snapshot);
    }
    if (path.endsWith("/goal")) return json({ message: "No goal" }, 404);
    if (path.endsWith("/lineage")) return json({ ancestors: [], children: [], truncated: false });
    if (path.endsWith("/human-input-requests")) return json({ requests: [] });
    if (path.endsWith("/background-commands")) return json({ commands: [] });
    if (path.endsWith("/session-tenancy/capabilities"))
      return json({ activated: true, canCreatePrivate: false, reason: "available" });
    if (path.endsWith("/session-message-search")) {
      const query = new URL(request.url()).searchParams.get("query") ?? "";
      const match = state.events.find(
        (event) => (event.payload as { text?: string })?.text === query,
      );
      return json({
        matches: match
          ? [
              {
                sessionId,
                sessionTitle: state.session.title,
                eventId: match.id,
                sequence: match.sequence,
                turnId: match.turnId,
                role: "user",
                messageId: null,
                messageMatchOffset: 0,
                snippet: { text: query, matchStart: 0, matchEnd: query.length },
              },
            ]
          : [],
        nextCursor: null,
        hasMore: false,
        scannedMessages: state.events.length,
        matchedMessageCount: match ? 1 : 0,
        matchedOccurrenceCount: match ? 1 : 0,
        countIsExact: true,
      });
    }
    if (path.endsWith("/new-session-draft")) {
      if (request.method() === "PUT")
        state.newDraft = {
          ...state.newDraft,
          ...request.postDataJSON(),
          revision: Number(state.newDraft.revision) + 1,
        };
      return json(state.newDraft);
    }
    if (state.enableCreate && path.endsWith("/model-catalog"))
      return json({
        models: [
          {
            id: state.session.model,
            label: "Fixture model",
            provider: "openai",
            providerLabel: "OpenAI",
            api: "responses",
            source: "opengeni",
            cost: "credits",
            policyAllowed: true,
            capabilities: {
              reasoning: { efforts: ["low"], defaultEffort: "low" },
              latencyModes: [],
            },
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

  for (const origin of ["existing", "created"] as const) {
    test(`production ${origin} latest-tail reload never resurrects genesis at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const state = fixtures();
      state.paginatedHistory = true;
      state.enableCreate = origin === "created";
      state.session.initialMessage = "Original first question must not reappear.";
      state.session.lastSequence = 5000;
      const history = Array.from({ length: 5000 }, (_, index) => ({
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
      state.events = history;
      for (const name of ["config", "access", "detail", "create"] as const)
        state.gates[name].release();
      if (origin === "existing") state.gates.history.release();
      await installApi(page, state);
      const capture = (name: string) =>
        page.screenshot({ path: `${output}/${width}-${origin}-${name}.png` });
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
        if (origin === "created") {
          await page.goto(`${base}/workspaces/${workspaceId}/sessions`);
          const create = page.getByRole("textbox", { name: /Message|Prompt/i }).first();
          await create.fill(state.session.initialMessage);
          await create.press("Enter");
          await state.gates.create.entered;
          await state.gates.history.entered;
          await transcript.getByText(state.session.initialMessage, { exact: true }).waitFor();
          await capture("creation-pending");
          state.gates.history.release();
          await state.gates.stream.entered;
          assert.equal(
            await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
            1,
          );
          await capture("creation-reconciled");
          state.events = [state.events[0]!, ...history.slice(1)];
          state.session.lastSequence = 5000;
          state.gates.stream.release();
        } else await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
        await transcript.getByText("History question 5000", { exact: true }).waitFor();
        if (origin === "created") {
          await page.getByRole("button", { name: "Find in conversation", exact: true }).click();
          await page
            .getByRole("searchbox", { name: "Find in conversation", exact: true })
            .fill("History question 4000");
          await page.locator('[data-og-search-sequence="4000"]').first().waitFor();
          await page
            .getByRole("button", { name: "Close conversation search", exact: true })
            .click();
        }
        assert.equal(
          await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
          0,
        );
        await input.evaluate((node) => node.setAttribute("data-reload-probe", "same-composer"));
        const scroller = page.locator("[data-og-timeline-scroller]");
        await scroller.hover();
        await page.mouse.wheel(0, -500);
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        const oldest = page.getByRole("button", { name: "Jump to start", exact: true });
        await oldest.click();
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
        if (origin === "created") {
          if (width < 1024)
            await page.getByRole("button", { name: "Open navigation", exact: true }).click();
          state.gates.other.release();
          await page.locator(`a[data-session-row="${otherSessionId}"]:visible`).click();
          await page.waitForURL(`**/sessions/${otherSessionId}`);
          state.gates.history = gate();
          await page.goBack();
          await state.gates.history.entered;
          await page.locator("[data-page-loading]").waitFor();
          assert.equal(
            await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
            0,
          );
          await capture("creation-return-pending");
          state.gates.history.release();
          await transcript.getByText("History question 5000", { exact: true }).waitFor();
          assert.equal(
            await transcript.getByText(state.session.initialMessage, { exact: true }).count(),
            0,
          );
        }
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

  test(`production Latest question focuses only the saved queued row at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const state = fixtures();
    const queuedId = "55555555-5555-4555-8555-555555555555";
    const queuedEventId = crypto.randomUUID();
    const prompt = "Next queued question stays saved.";
    const queued = {
      id: queuedId,
      workspaceId,
      sessionId,
      triggerEventId: queuedEventId,
      status: "queued",
      source: "user",
      position: 1,
      prompt,
      resources: [],
      tools: [],
      annotations: [],
      metadata: {},
      version: 1,
      createdAt: state.session.createdAt,
      updatedAt: state.session.updatedAt,
    };
    state.paginatedHistory = true;
    state.turns = [queued];
    Object.assign(state.session, {
      status: "running",
      activeTurnId: turnId,
      queueVersion: 1,
      lastSequence: 4,
    });
    state.events.push(
      {
        id: crypto.randomUUID(),
        workspaceId,
        sessionId,
        turnId,
        sequence: 2,
        type: "agent.message.completed",
        payload: {
          text: Array.from(
            { length: 60 },
            (_, i) =>
              `Completed answer paragraph ${i + 1}. This is retained conversation history, not the next queued question.`,
          ).join("\n\n"),
        },
        occurredAt: state.session.createdAt,
      },
      {
        id: queuedEventId,
        workspaceId,
        sessionId,
        turnId: queuedId,
        sequence: 3,
        type: "user.message",
        payload: { text: prompt, resources: [], routing: "queued_for_execution" },
        occurredAt: state.session.createdAt,
      },
      {
        id: crypto.randomUUID(),
        workspaceId,
        sessionId,
        turnId: queuedId,
        sequence: 4,
        type: "turn.queued",
        payload: { triggerEventId: queuedEventId, turnId: queuedId },
        occurredAt: state.session.createdAt,
      },
    );
    for (const name of ["config", "access", "detail", "history", "other"] as const)
      state.gates[name].release();
    await installApi(page, state);
    const queueWrites: string[] = [];
    let questionAssetRequested = false;
    let composerMenuRequested = false;
    const menuLoad = gate();
    await page.route(`**/${composerMenuAsset}`, async (route) => {
      composerMenuRequested = true;
      await menuLoad.wait();
      await route.continue();
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/${questionAsset}`) questionAssetRequested = true;
      if (
        request.method() !== "GET" &&
        /\/(queue|turns)(\/|$)/.test(new URL(request.url()).pathname)
      )
        queueWrites.push(`${request.method()} ${request.url()}`);
    });
    const capture = (name: string) => page.screenshot({ path: `${output}/${width}-${name}.png` });
    const latest = page.getByRole("button", { name: "Latest question", exact: true });
    const row = page.locator(`[data-queue-turn-id="${queuedId}"]`);
    const collapseQueue = async () => {
      if (await page.locator('[data-og-session-chrome-panel="queue"]').count())
        await page.getByRole("button", { name: /1 queued prompt/ }).click();
    };
    const assertNotFocused = async () => {
      assert.equal(
        await page.evaluate(
          (id) => document.activeElement?.closest(`[data-queue-turn-id="${id}"]`) !== null,
          queuedId,
        ),
        false,
      );
    };
    try {
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      await row.waitFor();
      await collapseQueue();
      await latest.waitFor();
      assert.equal(composerMenuRequested, false, "optional composer menu must not load with chat");
      const composerActions = page.getByRole("button", {
        name: "More composer actions",
        exact: true,
      });
      await composerActions.click();
      await menuLoad.entered;
      await page.getByRole("status").filter({ hasText: "Loading actions…" }).waitFor();
      await capture("composer-menu-loading");
      menuLoad.release();
      await page.getByRole("menuitem", { name: "Connectors", exact: true }).waitFor();
      await capture("composer-menu-ready");
      await page.getByRole("menuitem", { name: "Repositories", exact: true }).click();
      await page.getByRole("menuitem", { name: "Back", exact: true }).click();
      await page.getByRole("menuitem", { name: "Connectors", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "More composer actions",
      );
      assert.equal(questionAssetRequested, false, "optional navigation must not load with chat");
      await latest.click();
      await page.waitForFunction(
        (id) => document.activeElement?.closest(`[data-queue-turn-id="${id}"]`) !== null,
        queuedId,
      );
      assert.equal(questionAssetRequested, true, "Latest question loads its resolver on demand");
      assert.equal(
        await page
          .locator('[data-testid="timeline-user"]')
          .getByText(prompt, { exact: true })
          .count(),
        0,
      );
      await capture("queued-question-focused");

      await collapseQueue();
      state.nextQueueTransition = "fail";
      await latest.click();
      await page.waitForFunction(() =>
        document
          .querySelector("[data-og-jump-to-question]")
          ?.getAttribute("title")
          ?.includes("Could not load"),
      );
      await assertNotFocused();
      await capture("queued-question-refresh-error");

      state.failQueue = false;
      state.nextQueueTransition = "hold";
      await latest.click();
      await state.gates.queue.entered;
      await page.getByRole("button", { name: "Find in conversation", exact: true }).click();
      await page
        .getByRole("searchbox", { name: "Find in conversation", exact: true })
        .fill(state.session.initialMessage);
      await page.locator('[data-og-search-sequence="1"]').first().waitFor();
      await page.getByRole("button", { name: "Close conversation search", exact: true }).click();
      state.deferQueue = false;
      state.gates.queue.release();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-og-jump-to-question]")?.getAttribute("aria-busy") !==
          "true",
      );
      await assertNotFocused();
      assert.equal(await page.locator('[data-og-session-chrome-panel="queue"]').count(), 0);
      await capture("queued-question-history-navigation");
      await page.locator("[data-og-timeline-scroller]").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await latest.waitFor();
      state.nextQueueTransition = "withdraw";
      await latest.click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-og-jump-to-question]")?.getAttribute("aria-busy") !==
          "true",
      );
      await assertNotFocused();
      await row.waitFor({ state: "hidden" });
      await capture("queued-question-withdrawn");

      const replacementId = crypto.randomUUID();
      const replacementEventId = crypto.randomUUID();
      state.turns = [{ ...queued, id: replacementId, triggerEventId: replacementEventId }];
      state.session.queueVersion += 1;
      state.session.lastSequence = 7;
      state.events.push(
        {
          id: replacementEventId,
          workspaceId,
          sessionId,
          turnId: replacementId,
          sequence: 6,
          type: "user.message",
          payload: { text: prompt, resources: [], routing: "queued_for_execution" },
          occurredAt: state.session.updatedAt,
        },
        {
          id: crypto.randomUUID(),
          workspaceId,
          sessionId,
          turnId: replacementId,
          sequence: 7,
          type: "turn.queued",
          payload: { triggerEventId: replacementEventId, turnId: replacementId },
          occurredAt: state.session.updatedAt,
        },
      );
      await page.locator("[data-og-timeline-scroller]").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      state.gates.queue = gate();
      state.nextQueueTransition = "hold";
      await latest.click();
      await state.gates.queue.entered;
      if (width < 1024)
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.locator(`a[data-session-row="${otherSessionId}"]:visible`).click();
      await page
        .getByRole("textbox", { name: /Message|Prompt/i })
        .first()
        .waitFor();
      state.deferQueue = false;
      state.gates.queue.release();
      await assertNotFocused();
      assert.equal(await row.count(), 0);
      assert.equal(await page.locator('[data-og-session-chrome-panel="queue"]').count(), 0);
      await capture("queued-question-session-switch");
      assert.deepEqual(queueWrites, []);
      assert.equal(
        state.turns[0]?.id,
        replacementId,
        "navigation must not consume the saved prompt",
      );
    } catch (error) {
      await capture("queued-question-failure");
      throw new Error(`${width}px queued question: ${await page.locator("body").innerText()}`, {
        cause: error,
      });
    } finally {
      menuLoad.release();
      for (const deferred of Object.values(state.gates)) deferred.release();
      await context.close();
    }
  }, 90_000);

  test(`production composer menu failure after deployment recovery preserves chat at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const state = fixtures();
    for (const name of ["config", "access", "detail", "history"] as const)
      state.gates[name].release();
    await installApi(page, state);
    await page.route(`**/${composerMenuAsset}`, (route) => route.abort("failed"));
    try {
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      const input = page.getByRole("textbox", { name: /Message|Prompt/i }).first();
      await input.waitFor();
      // Preserve the app's existing one-time stale-chunk reload; exercise the
      // local fallback when that recovery has already been attempted.
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "More composer actions", exact: true }).click(),
      ]);
      await input.waitFor();
      await input.fill("Draft survives optional menu failure");
      await page.getByRole("button", { name: "More composer actions", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Composer actions could not be loaded." })
        .waitFor();
      assert.equal(await page.getByRole("button", { name: "Reload", exact: true }).count(), 1);
      await page.screenshot({ path: `${output}/${width}-composer-menu-load-error.png` });
      await page.keyboard.press("Escape");
      assert.equal(await input.inputValue(), "Draft survives optional menu failure");
      await input.fill("Still editable");
      assert.equal(await input.inputValue(), "Still editable");
    } finally {
      for (const deferred of Object.values(state.gates)) deferred.release();
      await context.close();
    }
  }, 30_000);

  test(`production Files failure after deployment recovery preserves chat at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const state = fixtures();
    for (const name of ["config", "access", "detail", "history"] as const)
      state.gates[name].release();
    await installApi(page, state);
    const first = gate();
    const second = gate();
    let requests = 0;
    await page.route(`**/${workspaceFilesAsset}`, async (route) => {
      await (++requests === 1 ? first : second).wait();
      await route.abort("failed");
    });
    const input = page.getByRole("textbox", { name: /Message|Prompt/i }).first();
    const openFiles = async () => {
      const open = page.getByRole("button", { name: "Open workspace", exact: true });
      if (await open.isVisible()) await open.click();
      await page.getByRole("tab", { name: "Files", exact: true }).click();
    };
    const showChat = async () => {
      // A phone restores the dock as an overlay; close it before editing chat.
      // Its inert/aria-hidden primary pane is deliberately absent from role queries.
      if (width < 1024)
        await page
          .locator("[data-dock-chrome]")
          .getByRole("button", { name: "Hide workspace", exact: true })
          .click();
      await input.waitFor();
    };
    try {
      await page.goto(`${base}/workspaces/${workspaceId}/sessions/${sessionId}`);
      await input.waitFor();
      await openFiles();
      await first.entered;
      // A stale deployment still gets the app's existing one guarded reload.
      const reloaded = page.waitForEvent("load");
      first.release();
      await reloaded;
      await showChat();
      await input.fill("Draft survives optional Files failure");
      const originalInput = await input.elementHandle();
      await openFiles();
      await second.entered;
      await page.getByText("Opening Files", { exact: true }).waitFor();
      second.release();
      await page.getByRole("alert").filter({ hasText: "Files could not be loaded." }).waitFor();
      assert.equal(await originalInput!.evaluate((node) => node.isConnected), true);
      assert.equal(await page.getByRole("button", { name: "Reload", exact: true }).count(), 1);
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-og-theme", value),
          theme,
        );
        await page.screenshot({ path: `${output}/${width}-files-load-error-${theme}.png` });
      }
      await page
        .locator("[data-dock-chrome]")
        .getByRole("button", { name: "Hide workspace", exact: true })
        .click();
      assert.equal(await input.inputValue(), "Draft survives optional Files failure");
      await input.fill("Still editable after Files failed");
      assert.equal(await input.inputValue(), "Still editable after Files failed");
      await openFiles();
      await page.getByRole("alert").filter({ hasText: "Files could not be loaded." }).waitFor();
      assert.equal(requests, 2, "reopening keeps the failure local without a request loop");
      await page.unroute(`**/${workspaceFilesAsset}`);
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Reload", exact: true }).click(),
      ]);
      await showChat();
      await openFiles();
      await page
        .getByRole("tabpanel", { name: "Files", exact: true })
        .getByText("Files unavailable", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("alert").filter({ hasText: "Files could not be loaded." }).count(),
        0,
      );
    } catch (error) {
      await page.screenshot({ path: `${output}/${width}-files-load-error-failure.png` });
      throw new Error(`${width}px Files failure: ${await page.locator("body").innerText()}`, {
        cause: error,
      });
    } finally {
      first.release();
      second.release();
      await context.close();
    }
  }, 45_000);
}
