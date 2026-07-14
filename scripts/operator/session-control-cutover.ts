import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  captureSessionControlCutoverSnapshot,
  reconcileSessionControlCutover,
  sha256,
  type CutoverPhase,
  type SessionControlCutoverSnapshot,
} from "@opengeni/db/session-control-cutover-audit";
import { getSettings } from "@opengeni/config";
import { createObjectStorage } from "@opengeni/storage";
import { Client as TemporalClient, Connection } from "@temporalio/client";
import postgres from "postgres";

type ParsedArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]!;
    if (!current.startsWith("--"))
      throw new Error(`unexpected argument: ${current}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(current);
      continue;
    }
    values.set(current, next);
    index += 1;
  }
  return { command, values, flags };
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function migrationDatabaseUrl(): string {
  const value = process.env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "OPENGENI_MIGRATIONS_DATABASE_URL is required; the runtime RLS connection is not an operator audit source",
    );
  }
  return value;
}

function assertPhase(value: string): asserts value is CutoverPhase {
  if (value !== "baseline" && value !== "migrated" && value !== "final") {
    throw new Error(`invalid --phase: ${value}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`;
  if (path.startsWith("object://")) {
    const key = path.slice("object://".length);
    if (!key || key.startsWith("/") || key.includes("..")) {
      throw new Error(`unsafe object output key: ${key}`);
    }
    const storage = createObjectStorage(getSettings());
    if (!storage) throw new Error("configured object storage is unavailable");
    const bytes = new TextEncoder().encode(serialized);
    await storage.putObject({
      key,
      contentType: "application/json",
      body: bytes,
      sha256: sha256(value),
    });
    return;
  }
  if (path === "-") {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
}

function parseJson<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${source} contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJson<T>(path: string): Promise<T> {
  if (path.startsWith("object://")) {
    const key = path.slice("object://".length);
    if (!key || key.startsWith("/") || key.includes("..")) {
      throw new Error(`unsafe object input key: ${key}`);
    }
    const storage = createObjectStorage(getSettings());
    if (!storage) throw new Error("configured object storage is unavailable");
    const value = await storage.getObjectBytes(key);
    if (!value) throw new Error(`object does not exist: ${key}`);
    return parseJson<T>(new TextDecoder().decode(value.bytes), path);
  }
  return parseJson<T>(await readFile(path, "utf8"), path);
}

function verifySnapshot(
  value: SessionControlCutoverSnapshot,
  path: string,
): void {
  const { sha256: recorded, ...body } = value;
  const calculated = sha256(body);
  if (calculated !== recorded) {
    throw new Error(
      `${path}: snapshot checksum mismatch (${recorded} != ${calculated})`,
    );
  }
}

async function readSnapshot(
  path: string,
): Promise<SessionControlCutoverSnapshot> {
  const value = await readJson<SessionControlCutoverSnapshot>(path);
  verifySnapshot(value, path);
  return value;
}

function temporalSettings(): {
  address: string;
  namespace: string;
  taskQueue: string;
} {
  const address = process.env.OPENGENI_TEMPORAL_HOST?.trim();
  const namespace = process.env.OPENGENI_TEMPORAL_NAMESPACE?.trim();
  const taskQueue = process.env.OPENGENI_TEMPORAL_TASK_QUEUE?.trim();
  if (!address || !namespace || !taskQueue) {
    throw new Error(
      "OPENGENI_TEMPORAL_HOST, OPENGENI_TEMPORAL_NAMESPACE, and OPENGENI_TEMPORAL_TASK_QUEUE are required",
    );
  }
  return { address, namespace, taskQueue };
}

async function capture(args: ParsedArgs): Promise<void> {
  const phase = required(args, "--phase");
  assertPhase(phase);
  const output = required(args, "--output");
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: `opengeni-cutover-audit-${phase}` },
  });
  try {
    const snapshot = await sql.begin(async (transaction) => {
      await transaction.unsafe(
        "set transaction isolation level repeatable read, read only",
      );
      return await captureSessionControlCutoverSnapshot(transaction, phase);
    });
    if (
      phase === "baseline" &&
      snapshot.sessions.length === 0 &&
      !args.flags.has("--allow-empty-baseline")
    ) {
      throw new Error(
        "baseline contains zero sessions; refusing a vacuous production proof (use --allow-empty-baseline only for a reviewed empty installation)",
      );
    }
    await writeJson(output, snapshot);
    process.stderr.write(
      `[cutover-audit] ${phase}: ${snapshot.sessions.length} sessions, ${snapshot.identityCount} identities, sha256 ${snapshot.sha256}\n`,
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function reconcile(args: ParsedArgs): Promise<void> {
  const baseline = await readSnapshot(required(args, "--baseline"));
  const observed = await readSnapshot(required(args, "--observed"));
  const mode = required(args, "--mode");
  if (mode !== "migration" && mode !== "final-fate") {
    throw new Error(`invalid --mode: ${mode}`);
  }
  const result = reconcileSessionControlCutover(baseline, observed, mode);
  await writeJson(required(args, "--output"), result);
  if (!result.ok) {
    for (const error of result.errors)
      process.stderr.write(`[cutover-audit] ${error}\n`);
    throw new Error(
      `${mode} reconciliation failed with ${result.errors.length} error(s)`,
    );
  }
  process.stderr.write(
    `[cutover-audit] ${mode}: all pre-cutover identities reconciled, sha256 ${result.sha256}\n`,
  );
}

type Claimable = {
  account_id: string;
  workspace_id: string;
  session_id: string;
  temporal_workflow_id: string;
};

async function wake(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const execute = args.flags.has("--execute");
  const temporalSettingsValue = temporalSettings();
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-cutover-wake-repair" },
  });
  let connection: Connection | null = null;
  try {
    const rows = (await sql.unsafe<Claimable[]>(
      "select * from opengeni_private.list_claimable_sessions(10000)",
    )) as unknown as Claimable[];
    if (rows.length === 10_000) {
      throw new Error(
        "claimable-session scan reached its hard limit; refusing a partial wake repair",
      );
    }
    const ordered = [...rows].sort((a, b) =>
      a.session_id.localeCompare(b.session_id),
    );
    const failures: Array<{ sessionId: string; error: string }> = [];
    const woken: string[] = [];
    if (execute) {
      connection = await Connection.connect({
        address: temporalSettingsValue.address,
      });
      const temporal = new TemporalClient({
        connection,
        namespace: temporalSettingsValue.namespace,
      });
      const queue = [...ordered];
      const workers = Array.from(
        { length: Math.min(20, Math.max(1, queue.length)) },
        async () => {
          for (;;) {
            const row = queue.shift();
            if (!row) return;
            try {
              await temporal.workflow.signalWithStart("sessionWorkflow", {
                taskQueue: temporalSettingsValue.taskQueue,
                workflowId: row.temporal_workflow_id,
                workflowIdReusePolicy: "ALLOW_DUPLICATE",
                args: [
                  {
                    accountId: row.account_id,
                    workspaceId: row.workspace_id,
                    sessionId: row.session_id,
                  },
                ],
                signal: "queueChanged",
              });
              woken.push(row.session_id);
            } catch (error) {
              failures.push({
                sessionId: row.session_id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
      );
      await Promise.all(workers);
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-wake/v1",
      executed: execute,
      capturedAt: new Date().toISOString(),
      claimableSessionIds: ordered.map((row) => row.session_id),
      workflowIds: ordered.map((row) => row.temporal_workflow_id),
      wokenSessionIds: woken.sort(),
      failures: failures.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    };
    const receipt = { ...draft, sha256: sha256(draft) };
    await writeJson(output, receipt);
    if (failures.length > 0) {
      throw new Error(`wake repair failed for ${failures.length} session(s)`);
    }
    process.stderr.write(
      `[cutover-wake] ${execute ? "woke" : "found"} ${ordered.length} claimable sessions, sha256 ${receipt.sha256}\n`,
    );
  } finally {
    await connection?.close().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

type SchedulePauseArtifact = {
  contractVersion: "opengeni/session-control-cutover-schedules/v1";
  action: "pause" | "resume" | "inspect";
  runId: string;
  capturedAt: string;
  schedules: Array<{
    scheduleId: string;
    wasPaused: boolean;
    paused: boolean;
    note: string | null;
  }>;
  changedScheduleIds: string[];
  sha256: string;
};

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`unsafe cutover run id: ${value}`);
  }
  return value;
}

export function schedulePauseOwnedByRun(
  wasPaused: boolean,
  currentNote: string | null | undefined,
  runNote: string,
): boolean {
  return !wasPaused || currentNote === runNote;
}

async function temporalSchedules(args: ParsedArgs): Promise<void> {
  const action = required(args, "--action");
  if (action !== "pause" && action !== "resume" && action !== "inspect") {
    throw new Error(`invalid schedule action: ${action}`);
  }
  const runId = safeRunId(required(args, "--run-id"));
  const output = required(args, "--output");
  const note = `OpenGeni production maintenance ${runId}`;
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: settings.namespace,
    });
    let expectedResumeIds: Set<string> | null = null;
    if (action === "resume") {
      const pauseArtifact = await readJson<SchedulePauseArtifact>(
        required(args, "--input"),
      );
      const { sha256: recorded, ...body } = pauseArtifact;
      if (
        pauseArtifact.contractVersion !==
          "opengeni/session-control-cutover-schedules/v1" ||
        pauseArtifact.action !== "pause" ||
        pauseArtifact.runId !== runId ||
        sha256(body) !== recorded ||
        !Array.isArray(pauseArtifact.changedScheduleIds) ||
        pauseArtifact.changedScheduleIds.some(
          (id) =>
            typeof id !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id),
        ) ||
        new Set(pauseArtifact.changedScheduleIds).size !==
          pauseArtifact.changedScheduleIds.length
      ) {
        throw new Error(
          "schedule pause artifact is stale, malformed, or belongs to another run",
        );
      }
      expectedResumeIds = new Set(pauseArtifact.changedScheduleIds);
    }
    const summaries: Array<{
      scheduleId: string;
      wasPaused: boolean;
      paused: boolean;
      note: string | null;
    }> = [];
    const changedScheduleIds: string[] = [];
    const listed: string[] = [];
    for await (const summary of temporal.schedule.list({ pageSize: 1000 })) {
      listed.push(summary.scheduleId);
    }
    listed.sort();
    for (const scheduleId of listed) {
      const handle = temporal.schedule.getHandle(scheduleId);
      const before = await handle.describe();
      const wasPaused = before.state.paused;
      if (
        action === "pause" &&
        schedulePauseOwnedByRun(wasPaused, before.state.note, note)
      ) {
        if (!wasPaused) await handle.pause(note);
        // A retry after the pause succeeded but before its receipt was committed
        // still owns this schedule. Re-emit that ownership so the eventual resume
        // receipt cannot lose schedules merely because the command is idempotent.
        changedScheduleIds.push(scheduleId);
      } else if (action === "resume" && expectedResumeIds?.has(scheduleId)) {
        if (!wasPaused || before.state.note !== note) {
          throw new Error(
            `schedule ${scheduleId} is not paused by this exact cutover run; refusing to unpause it`,
          );
        }
        await handle.unpause(note);
        changedScheduleIds.push(scheduleId);
      }
      const after = await handle.describe();
      if (action === "pause" && !after.state.paused) {
        throw new Error(`schedule ${scheduleId} did not acknowledge pause`);
      }
      if (
        action === "resume" &&
        expectedResumeIds?.has(scheduleId) &&
        after.state.paused
      ) {
        throw new Error(`schedule ${scheduleId} did not acknowledge resume`);
      }
      summaries.push({
        scheduleId,
        wasPaused,
        paused: after.state.paused,
        note: after.state.note ?? null,
      });
    }
    if (expectedResumeIds) {
      const missing = [...expectedResumeIds].filter(
        (id) => !listed.includes(id),
      );
      if (missing.length > 0) {
        throw new Error(
          `paused schedules disappeared before resume: ${missing.join(", ")}`,
        );
      }
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-schedules/v1" as const,
      action,
      runId,
      capturedAt: new Date().toISOString(),
      schedules: summaries,
      changedScheduleIds: changedScheduleIds.sort(),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-schedules] ${action}: ${summaries.length} observed, ${changedScheduleIds.length} changed, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function temporalWorkflows(args: ParsedArgs): Promise<void> {
  const action = required(args, "--action");
  if (action !== "inspect" && action !== "terminate") {
    throw new Error(`invalid workflow action: ${action}`);
  }
  const execute = args.flags.has("--execute");
  if (action === "terminate" && !execute) {
    throw new Error("workflow termination requires --execute");
  }
  const runId = safeRunId(required(args, "--run-id"));
  const output = required(args, "--output");
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: settings.namespace,
    });
    const captured: Array<{
      workflowId: string;
      runId: string;
      startTime: string;
    }> = [];
    for await (const execution of temporal.workflow.list({
      query: "ExecutionStatus='Running'",
    })) {
      if (!execution.workflowId.startsWith("session-")) continue;
      captured.push({
        workflowId: execution.workflowId,
        runId: execution.runId,
        startTime: execution.startTime.toISOString(),
      });
    }
    captured.sort(
      (a, b) =>
        a.workflowId.localeCompare(b.workflowId) ||
        a.runId.localeCompare(b.runId),
    );
    const terminated: Array<{ workflowId: string; runId: string }> = [];
    if (action === "terminate") {
      for (const execution of captured) {
        await temporal.workflow
          .getHandle(execution.workflowId, execution.runId)
          .terminate(`OpenGeni production maintenance ${runId}`);
        terminated.push({
          workflowId: execution.workflowId,
          runId: execution.runId,
        });
      }
      for (const execution of captured) {
        const description = await temporal.workflow
          .getHandle(execution.workflowId, execution.runId)
          .describe();
        if (description.status.name === "RUNNING") {
          throw new Error(
            `workflow ${execution.workflowId}/${execution.runId} remained running after termination`,
          );
        }
      }
    }
    const remaining: Array<{ workflowId: string; runId: string }> = [];
    for await (const execution of temporal.workflow.list({
      query: "ExecutionStatus='Running'",
    })) {
      if (execution.workflowId.startsWith("session-")) {
        remaining.push({
          workflowId: execution.workflowId,
          runId: execution.runId,
        });
      }
    }
    if (action === "terminate" && remaining.length > 0) {
      throw new Error(
        `${remaining.length} running session workflows remain after termination`,
      );
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-workflows/v1",
      action,
      executed: action === "terminate" && execute,
      runId,
      capturedAt: new Date().toISOString(),
      captured,
      terminated,
      remaining: remaining.sort((a, b) =>
        a.workflowId.localeCompare(b.workflowId),
      ),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-workflows] ${action}: ${captured.length} captured, ${terminated.length} terminated, ${remaining.length} remaining, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error(`${operation} returned HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

async function productionCodexCanary(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const runId = safeRunId(required(args, "--run-id"));
  const model = required(args, "--model");
  if (!model.startsWith("codex/")) {
    throw new Error(
      "production canary model must use an existing Codex subscription",
    );
  }
  const apiBaseUrl = required(args, "--api-base-url").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBaseUrl))
    throw new Error("--api-base-url must be HTTP(S)");
  const requestedWorkspaceId =
    args.values.get("--workspace-id")?.trim() || null;
  if (requestedWorkspaceId && !/^[0-9a-f-]{36}$/.test(requestedWorkspaceId)) {
    throw new Error("--workspace-id must be a UUID");
  }
  const timeoutSeconds = Number.parseInt(
    args.values.get("--timeout-seconds") ?? "600",
    10,
  );
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 30 ||
    timeoutSeconds > 1_800
  ) {
    throw new Error("--timeout-seconds must be between 30 and 1800");
  }
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-production-codex-canary" },
  });
  let apiKeyId: string | null = null;
  try {
    const candidates = (await sql.unsafe<
      Array<{ workspace_id: string; account_id: string }>
    >(
      `select w.id as workspace_id, w.account_id
       from workspaces w
       where w.inference_state = 'active'
         and ($1::uuid is null or w.id = $1::uuid)
         and exists (
           select 1 from codex_subscription_credentials c
           where c.workspace_id = w.id and c.status = 'active'
         )
       order by w.id limit 1`,
      [requestedWorkspaceId],
    )) as unknown as Array<{ workspace_id: string; account_id: string }>;
    const candidate = candidates[0];
    if (!candidate) {
      throw new Error(
        "no active workspace with an existing connected Codex subscription was found",
      );
    }
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = `ogk_${Buffer.from(randomBytes).toString("hex")}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    const inserted = await sql<Array<{ id: string }>>`
      insert into api_keys (
        account_id, workspace_id, name, prefix, key_hash, permissions, expires_at
      ) values (
        ${candidate.account_id}, ${candidate.workspace_id}, ${`OpenGeni production canary ${runId}`},
        ${token.slice(0, 14)}, ${keyHash},
        ${sql.json(["workspace:read", "sessions:create", "sessions:read", "sessions:control"])},
        now() + interval '15 minutes'
      ) returning id`;
    apiKeyId = inserted[0]?.id ?? null;
    if (!apiKeyId)
      throw new Error("failed to create the temporary canary API key");

    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const canaryMarker = `OPENGENI_CANARY_OK_${runId.replaceAll(/[^A-Za-z0-9]/g, "_")}`;
    const createResponse = await fetch(
      `${apiBaseUrl}/v1/workspaces/${candidate.workspace_id}/sessions`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          initialMessage: `Reply with exactly ${canaryMarker} and nothing else. Do not call tools.`,
          resources: [],
          tools: [],
          metadata: { productionCutoverCanary: runId },
          model,
          reasoningEffort: "low",
          sandbox: "new",
          idempotencyKey: `production-cutover-canary:${runId}`,
        }),
      },
    );
    const created = await responseJson(
      createResponse,
      "canary session creation",
    );
    const sessionId = typeof created.id === "string" ? created.id : null;
    if (!sessionId)
      throw new Error("canary session creation returned no session id");

    const deadline = Date.now() + timeoutSeconds * 1_000;
    let completedEventId: string | null = null;
    let usageEventId: string | null = null;
    let observedProvider: string | null = null;
    let observedModel: string | null = null;
    let terminalFailure = false;
    while (Date.now() < deadline) {
      const response = await fetch(
        `${apiBaseUrl}/v1/workspaces/${candidate.workspace_id}/sessions/${sessionId}/events?limit=1000`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      const rawEvents = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rawEvents)) {
        throw new Error(`canary event replay returned HTTP ${response.status}`);
      }
      for (const raw of rawEvents) {
        if (!raw || typeof raw !== "object") continue;
        const event = raw as Record<string, unknown>;
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        if (
          event.type === "agent.message.completed" &&
          payload.text === canaryMarker
        ) {
          completedEventId = typeof event.id === "string" ? event.id : null;
        }
        if (event.type === "agent.model.usage" && payload.model === model) {
          usageEventId = typeof event.id === "string" ? event.id : null;
          observedProvider =
            typeof payload.provider === "string" ? payload.provider : null;
          observedModel =
            typeof payload.model === "string" ? payload.model : null;
        }
        if (event.type === "turn.failed" || event.type === "turn.cancelled")
          terminalFailure = true;
      }
      if (completedEventId && usageEventId) break;
      if (terminalFailure)
        throw new Error("production Codex canary turn failed or was cancelled");
      await Bun.sleep(2_000);
    }
    if (!completedEventId || !usageEventId || observedModel !== model) {
      throw new Error(
        "production Codex canary did not produce the exact reply and usage evidence in time",
      );
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-canary/v1",
      runId,
      capturedAt: new Date().toISOString(),
      workspaceId: candidate.workspace_id,
      sessionId,
      completedEventId,
      usageEventId,
      provider: observedProvider,
      model: observedModel,
      exactReplyMatched: true,
      temporaryApiKeyRevoked: true,
    };
    await sql`update api_keys set revoked_at = now(), updated_at = now() where id = ${apiKeyId}`;
    apiKeyId = null;
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-canary] session ${sessionId} completed through ${observedModel}, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    if (apiKeyId) {
      await sql`
        update api_keys set revoked_at = now(), updated_at = now() where id = ${apiKeyId}`.catch(
        () => undefined,
      );
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function maintenanceServer(): Promise<never> {
  const port = Number.parseInt(
    process.env.OPENGENI_MAINTENANCE_PORT ?? "8000",
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENGENI_MAINTENANCE_PORT must be a valid TCP port");
  }
  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/healthz") {
        return Response.json({ ok: true, mode: "production-maintenance" });
      }
      return Response.json(
        {
          error: {
            code: "production_maintenance",
            message:
              "OpenGeni is briefly paused for a production update. Retry shortly.",
          },
        },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "retry-after": "120",
          },
        },
      );
    },
  });
  process.stderr.write(`[cutover-maintenance] serving on port ${port}\n`);
  // The Kubernetes pod owns this process lifetime and terminates it after the
  // ingress backend has been restored.
  return await new Promise<never>(() => undefined);
}

async function preflight(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const expectedSourceSha = required(args, "--source-sha");
  if (!/^[0-9a-f]{40}$/.test(expectedSourceSha)) {
    throw new Error("--source-sha must be a full lowercase Git commit SHA");
  }
  const bakedSourceSha = process.env.OPENGENI_SERVER_VERSION?.trim() ?? "";
  if (bakedSourceSha !== expectedSourceSha) {
    throw new Error(
      `reviewed source ${expectedSourceSha} does not match image source ${bakedSourceSha || "<unset>"}`,
    );
  }

  const migrationPath = "packages/db/drizzle/0057_durable_queue_control.sql";
  const migrationBytes = await readFile(migrationPath);
  const migrationSha256 = createHash("sha256")
    .update(migrationBytes)
    .digest("hex");
  const workerPackage = parseJson<{
    devDependencies?: Record<string, string>;
  }>(
    await readFile("apps/worker/package.json", "utf8"),
    "apps/worker/package.json",
  );
  const agentsCoreVersion =
    workerPackage.devDependencies?.["@openai/agents-core"];
  if (!agentsCoreVersion || !/^\d+\.\d+\.\d+$/.test(agentsCoreVersion)) {
    throw new Error(
      "apps/worker must pin an exact @openai/agents-core version",
    );
  }

  const schemaProbe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--cwd",
      "apps/worker",
      "-e",
      `import {Agent,RunContext,RunState} from "@openai/agents-core"; const agent=new Agent({name:"cutover-preflight",instructions:""}); const state=new RunState(new RunContext(),"",agent,1); process.stdout.write(JSON.stringify({schemaVersion:state.toJSON().$schemaVersion}));`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (schemaProbe.exitCode !== 0) {
    throw new Error(
      `RunState schema probe failed: ${schemaProbe.stderr.toString().trim() || "unknown error"}`,
    );
  }
  const schema = parseJson<{ schemaVersion?: unknown }>(
    schemaProbe.stdout.toString(),
    "RunState schema probe",
  );
  if (
    typeof schema.schemaVersion !== "string" ||
    !/^\d+\.\d+$/.test(schema.schemaVersion)
  ) {
    throw new Error("RunState schema probe returned an invalid version");
  }

  const draft = {
    contractVersion: "opengeni/session-control-cutover-preflight/v1",
    capturedAt: new Date().toISOString(),
    sourceSha: bakedSourceSha,
    migration: {
      path: migrationPath,
      sha256: migrationSha256,
    },
    agentsCoreVersion,
    runStateSchemaVersion: schema.schemaVersion,
  };
  const artifact = { ...draft, sha256: sha256(draft) };
  await writeJson(output, artifact);
  process.stderr.write(
    `[cutover-preflight] source ${bakedSourceSha}, migration ${migrationSha256}, RunState ${schema.schemaVersion}\n`,
  );
}

function usage(): void {
  process.stdout.write(`Usage:
  bun run operator:session-control-cutover preflight --source-sha SHA --output FILE
  bun run operator:session-control-cutover capture --phase baseline|migrated|final --output FILE [--allow-empty-baseline]
  bun run operator:session-control-cutover reconcile --baseline FILE --observed FILE --mode migration|final-fate --output FILE
  bun run operator:session-control-cutover wake --output FILE [--execute]
  bun run operator:session-control-cutover temporal-schedules --action pause|resume|inspect --run-id ID [--input FILE] --output FILE
  bun run operator:session-control-cutover temporal-workflows --action inspect|terminate --run-id ID --output FILE [--execute]
  bun run operator:session-control-cutover canary --run-id ID --workspace-id UUID --model codex/MODEL --api-base-url URL --output FILE [--timeout-seconds N]
  bun run operator:session-control-cutover maintenance-server

capture and wake require OPENGENI_MIGRATIONS_DATABASE_URL. wake also requires the production Temporal settings.
`);
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "preflight") await preflight(args);
    else if (args.command === "capture") await capture(args);
    else if (args.command === "reconcile") await reconcile(args);
    else if (args.command === "wake") await wake(args);
    else if (args.command === "temporal-schedules")
      await temporalSchedules(args);
    else if (args.command === "temporal-workflows")
      await temporalWorkflows(args);
    else if (args.command === "canary") await productionCodexCanary(args);
    else if (args.command === "maintenance-server") await maintenanceServer();
    else if (args.command === "help" || args.flags.has("--help")) usage();
    else throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
