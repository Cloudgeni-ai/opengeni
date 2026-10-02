/**
 * Old published SDK compatibility check (opt-in; driven by scripts/public-api/sdk-compat.ts).
 *
 * Loads a PUBLISHED `@opengeni/sdk` build from `OPENGENI_SDK_COMPAT_MODULE` (an
 * npm install outside this repository, with its own npm `@opengeni/contracts`)
 * and drives the core product-embedding flow against the CURRENT API source:
 *
 *   organization API key -> ensureWorkspace -> addExternalWorkspaceMember ->
 *   asUser -> createSession -> sendMessage -> listEvents -> streamEvents (SSE
 *   replay) -> createScheduledTask -> triggerScheduledTask
 *
 * Boundary, deliberately:
 * - The API is the real `createApp` served over real HTTP (`Bun.serve`) against a
 *   real, fully migrated PostgreSQL clone, so headers, the API-contract gate, and
 *   SSE framing are exercised exactly as in production.
 * - `settings.environment` is NOT "test": the API-contract 409 gate
 *   (`API_CONTRACT_CHANGED`) is skipped only for "test", and this suite exists
 *   to exercise it.
 * - There is NO Temporal worker, sandbox, or model. Temporal is a recording stub.
 *   The check stops at API acceptance plus durable PostgreSQL state: accepted
 *   session/message rows, durable `session_events`, their SSE replay, the
 *   scheduled-task row, and the manual-trigger hand-off to the workflow client.
 *   It never asserts agent output.
 *
 * Fails on: any 5xx, any 409 whose body code is `API_CONTRACT_CHANGED`, any
 * SDK-thrown contract-mismatch error, or any flow step that no longer works.
 * A method genuinely absent from an old SDK is logged as "not in vX" and skipped.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import { createDb, createOrganizationApiKey, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../../apps/api/src/app";
import { organizationApiKeyPermissionsForAccess } from "../../apps/api/src/routes/api-keys";

const MODULE_PATH = process.env.OPENGENI_SDK_COMPAT_MODULE;
const VERSION = process.env.OPENGENI_SDK_COMPAT_VERSION ?? "unknown";
const REQUIRE_REAL_DB = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const TAG = `[sdk-compat ${VERSION}]`;

type Json = Record<string, unknown>;
type OldSessionEvent = { id?: string; sequence: number; type: string; payload?: unknown };
type OldClientInstance = Record<string, unknown> & {
  ensureWorkspace(request: Json): Promise<{ workspace: { id: string }; created: boolean }>;
  addExternalWorkspaceMember(
    workspaceId: string,
    request: Json,
  ): Promise<{ subjectId?: string } & Json>;
  asUser(externalId: string, options: { source?: string }): OldClientInstance;
  createSession(workspaceId: string, request: Json): Promise<{ id: string } & Json>;
  sendMessage(workspaceId: string, sessionId: string, text: string): Promise<OldSessionEvent>;
  listEvents(
    workspaceId: string,
    sessionId: string,
    options?: { after?: number; limit?: number },
  ): Promise<OldSessionEvent[]>;
  streamEvents(
    workspaceId: string,
    sessionId: string,
    options: Json,
  ): AsyncGenerator<OldSessionEvent, void, void>;
  createScheduledTask(workspaceId: string, request: Json): Promise<{ id: string } & Json>;
  triggerScheduledTask(
    workspaceId: string,
    taskId: string,
    options?: { triggerId?: string },
  ): Promise<{ id: string } & Json>;
};
type OldSdkModule = {
  OpenGeniClient: new (options: {
    baseUrl: string;
    apiKey?: string;
    fetch?: typeof fetch;
  }) => OldClientInstance;
  OPENGENI_API_CONTRACT_REVISION?: string;
};

type ExchangeRecord = {
  method: string;
  path: string;
  status: number;
  contract: string | null;
  code?: string;
};
type Violation = ExchangeRecord & { reason: string };

class RecordingWorkflowClient {
  wakes: unknown[] = [];
  scheduledSyncs: unknown[] = [];
  scheduledTriggers: unknown[] = [];

  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakes.push(input);
  }
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(input: unknown): Promise<void> {
    this.scheduledSyncs.push(input);
  }
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(input: unknown): Promise<void> {
    this.scheduledTriggers.push(input);
  }
}

let shared: SharedTestDatabase | null = null;
let dbClient: DbClient | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let sdk: OldSdkModule | null = null;
let skipReason: string | null = null;

beforeAll(async () => {
  if (!MODULE_PATH) {
    throw new Error(
      "OPENGENI_SDK_COMPAT_MODULE is required; run through `bun scripts/public-api/sdk-compat.ts`",
    );
  }
  sdk = (await import(MODULE_PATH)) as OldSdkModule;
  if (typeof sdk.OpenGeniClient !== "function") {
    throw new Error(`${MODULE_PATH} does not export OpenGeniClient`);
  }
  shared = await acquireSharedTestDatabase("sdk-compat");
  if (!shared) {
    if (REQUIRE_REAL_DB) throw new Error("PostgreSQL (docker) unavailable and REQUIRE_REAL_DB=1");
    skipReason = "PostgreSQL (docker) unavailable";
    console.warn(`${TAG} SKIP ${skipReason}`);
    return;
  }
  dbClient = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  await dbClient?.close().catch(() => undefined);
  await shared?.release();
});

test(`published @opengeni/sdk ${VERSION} drives the embedding flow against current API`, async () => {
  if (skipReason || !shared || !dbClient || !sdk) return;
  const admin = shared.admin;
  const db = dbClient.db;
  const workflow = new RecordingWorkflowClient();
  const settings = testSettings({
    // Anything but "test": keeps the API-contract 409 gate on (apps/api/src/app.ts).
    environment: "sdk-compat",
    databaseUrl: shared.appUrl,
    productAccessMode: "configured",
    sandboxBackend: "none",
  });
  const noop = async () => undefined;
  const deps = {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: workflow as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "sdk-compat-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => {
      throw new Error("document services are not used by the SDK compatibility flow");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
  const app = createApp(deps);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const exchanges: ExchangeRecord[] = [];
  const violations: Violation[] = [];
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    const url = new URL(request.url);
    const record: ExchangeRecord = {
      method: request.method,
      path: url.pathname,
      status: response.status,
      contract: response.headers.get(OPENGENI_API_CONTRACT_HEADER),
    };
    if (response.status === 409 || response.status >= 500) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown; error?: { code?: unknown } } | null;
      const code = body?.code ?? body?.error?.code;
      if (typeof code === "string") record.code = code;
      if (response.status >= 500) violations.push({ ...record, reason: "5xx" });
      else if (code === "API_CONTRACT_CHANGED") {
        violations.push({ ...record, reason: "409 API_CONTRACT_CHANGED" });
      }
    }
    exchanges.push(record);
    return response;
  }) as typeof fetch;

  // Self-check: the contract gate must really be live in this harness, or a
  // green result would prove nothing about 409 API_CONTRACT_CHANGED.
  const gateProbe = await fetch(`${baseUrl}/v1/workspaces/external`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: "sdk-compat-probe",
    },
    body: "{}",
  });
  expect(gateProbe.status).toBe(409);
  expect(((await gateProbe.json()) as { code?: string }).code).toBe("API_CONTRACT_CHANGED");

  const oldRevision = sdk.OPENGENI_API_CONTRACT_REVISION ?? "(not exported)";
  console.log(
    `${TAG} sdk contract revision=${oldRevision} api contract revision=${OPENGENI_API_CONTRACT_REVISION}`,
  );

  const skipped: string[] = [];
  const has = (client: OldClientInstance, method: string): boolean => {
    if (typeof client[method] === "function") return true;
    skipped.push(method);
    console.log(`${TAG} SKIP ${method}: not in v${VERSION}`);
    return false;
  };
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const before = exchanges.length;
    const violationsBefore = violations.length;
    try {
      const result = await run();
      if (violations.length > violationsBefore) {
        throw new Error("recorded API contract violation (5xx or 409 API_CONTRACT_CHANGED)");
      }
      const statuses = exchanges
        .slice(before)
        .map((e) => `${e.method} ${e.path} ${e.status}`)
        .join(", ");
      console.log(`${TAG} OK ${name} [${statuses}]`);
      return result;
    } catch (error) {
      const err = error as { name?: string; message?: string; status?: number; code?: string };
      const last = exchanges.at(-1);
      const detail = [
        `step=${name}`,
        `error=${err?.name ?? "Error"}`,
        err?.status !== undefined ? `status=${err.status}` : null,
        err?.code ? `code=${err.code}` : null,
        `message=${JSON.stringify(String(err?.message ?? error).slice(0, 400))}`,
        last
          ? `lastResponse=${last.method} ${last.path} ${last.status} contract=${last.contract ?? "-"}${last.code ? ` code=${last.code}` : ""}`
          : null,
        violations.length > 0
          ? `violations=${JSON.stringify(violations.map((v) => `${v.reason} ${v.method} ${v.path}`))}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`${TAG} FAIL ${detail}`);
      throw error;
    }
  };

  // --- Seed: one organization (managed account) + one full organization API key.
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`SDK compat ${VERSION}`}) returning id`;
  const accountId = account!.id;
  const token = `ogk_compat_${crypto.randomUUID().replaceAll("-", "")}`;
  await createOrganizationApiKey(db, {
    accountId,
    name: `sdk-compat ${VERSION}`,
    prefix: token.slice(0, 12),
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });

  const service = new sdk.OpenGeniClient({ baseUrl, apiKey: token, fetch: recordingFetch });
  const tenantId = `tenant-${crypto.randomUUID()}`;
  const userRef = { externalId: `user-${crypto.randomUUID()}`, source: "sdk-compat" };

  // --- ensureWorkspace (create, then idempotent re-ensure).
  let workspaceId = "";
  if (has(service, "ensureWorkspace")) {
    const created = await step("ensureWorkspace(create)", () =>
      service.ensureWorkspace({
        accountId,
        externalSource: "sdk-compat",
        externalId: tenantId,
        name: `Tenant ${VERSION}`,
      }),
    );
    expect(created.created).toBe(true);
    workspaceId = created.workspace.id;
    const again = await step("ensureWorkspace(existing)", () =>
      service.ensureWorkspace({
        accountId,
        externalSource: "sdk-compat",
        externalId: tenantId,
        name: `Tenant ${VERSION}`,
      }),
    );
    expect(again.created).toBe(false);
    expect(again.workspace.id).toBe(workspaceId);
  }
  expect(workspaceId).not.toBe("");

  // --- addExternalWorkspaceMember: explicit grant for the host's end user.
  if (has(service, "addExternalWorkspaceMember")) {
    const member = await step("addExternalWorkspaceMember", () =>
      service.addExternalWorkspaceMember(workspaceId, {
        identity: userRef,
        permissions: [
          "workspace:read",
          "sessions:create",
          "sessions:read",
          "sessions:control",
          "scheduled_tasks:manage",
          "scheduled_tasks:run",
        ],
        operationId: crypto.randomUUID(),
      }),
    );
    expect(typeof member.subjectId).toBe("string");
  }

  // --- asUser: server-side organization-key client scoped to the end user.
  expect(has(service, "asUser")).toBe(true);
  const user = service.asUser(userRef.externalId, { source: userRef.source });

  // --- createSession + sendMessage.
  expect(has(user, "createSession")).toBe(true);
  const initialMessage = `compat hello from sdk ${VERSION}`;
  const session = await step("createSession", () =>
    user.createSession(workspaceId, { initialMessage, model: "scripted-model" }),
  );
  expect(typeof session.id).toBe("string");
  const followUp = `compat follow-up from sdk ${VERSION}`;
  if (has(user, "sendMessage")) {
    const sent = await step("sendMessage", () =>
      user.sendMessage(workspaceId, session.id, followUp),
    );
    expect(sent.type).toBe("user.message");
  }

  // --- listEvents: accepted input is durable in PostgreSQL.
  expect(has(user, "listEvents")).toBe(true);
  const listed = await step("listEvents", () =>
    user.listEvents(workspaceId, session.id, { after: 0, limit: 200 }),
  );
  const listedTypes = listed.map((event) => event.type);
  console.log(`${TAG} durable event types: ${listedTypes.join(", ")}`);
  const userMessages = listed.filter((event) => event.type === "user.message");
  const texts = userMessages.map((event) => JSON.stringify(event.payload));
  expect(texts.some((text) => text.includes(initialMessage))).toBe(true);
  if (!skipped.includes("sendMessage")) {
    expect(texts.some((text) => text.includes(followUp))).toBe(true);
  }
  const [durable] = await admin<{ count: number; max: number | null }[]>`
    select count(*)::int as count, max(sequence)::int as max
    from session_events where session_id = ${session.id}`;
  expect(durable!.count).toBeGreaterThanOrEqual(listed.length);
  const sequences = listed.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

  // --- streamEvents: SSE replay from 0 yields the same durable events, then abort.
  if (has(user, "streamEvents")) {
    const lastListed = Math.max(...sequences);
    const streamed = await step("streamEvents(replay)", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const seen: OldSessionEvent[] = [];
      try {
        for await (const event of user.streamEvents(workspaceId, session.id, {
          after: 0,
          signal: controller.signal,
          reconnect: false,
          maxReconnectAttempts: 0,
        })) {
          seen.push(event);
          if (event.sequence >= lastListed) break;
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return seen;
    });
    const streamedBySequence = new Map(streamed.map((event) => [event.sequence, event]));
    for (const event of listed) {
      const replayed = streamedBySequence.get(event.sequence);
      expect(replayed?.type).toBe(event.type);
      if (event.id !== undefined) expect(replayed?.id).toBe(event.id);
    }
  }

  // --- Scheduled task create + manual trigger (hand-off to the workflow client).
  if (has(user, "createScheduledTask")) {
    const task = await step("createScheduledTask", () =>
      user.createScheduledTask(workspaceId, {
        name: `compat task ${VERSION}`,
        schedule: { type: "once", runAt: "2035-01-01T00:00:00.000Z", timeZone: "UTC" },
        agentConfig: { prompt: `compat scheduled prompt ${VERSION}` },
      }),
    );
    expect(typeof task.id).toBe("string");
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from scheduled_tasks
      where workspace_id = ${workspaceId} and id = ${task.id}`;
    expect(row!.count).toBe(1);
    if (has(user, "triggerScheduledTask")) {
      const triggersBefore = workflow.scheduledTriggers.length;
      const triggerId = crypto.randomUUID();
      const triggered = await step("triggerScheduledTask", () =>
        user.triggerScheduledTask(workspaceId, task.id, { triggerId }),
      );
      expect(triggered.id).toBe(task.id);
      expect(workflow.scheduledTriggers.length).toBeGreaterThan(triggersBefore);
      // Same triggerId is an idempotent retry and must still be accepted.
      await step("triggerScheduledTask(retry same triggerId)", () =>
        user.triggerScheduledTask(workspaceId, task.id, { triggerId }),
      );
    }
  }

  // --- Whole-flow contract assertions.
  // A published SDK throws on a response revision header that differs from its
  // own, so a mismatch already failed the step above. Record the advertised
  // revisions for the report instead of pinning the server to one value.
  const advertised = [
    ...new Set(
      exchanges.filter((e) => e.path.startsWith("/v1/")).map((e) => e.contract ?? "(absent)"),
    ),
  ];
  console.log(
    `${TAG} SUMMARY requests=${exchanges.length} violations=${violations.length} advertised=${advertised.join(",")} skipped=${skipped.join(",") || "none"}`,
  );
  expect(violations).toEqual([]);
}, 120_000);
