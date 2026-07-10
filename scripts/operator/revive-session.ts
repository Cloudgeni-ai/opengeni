import {
  dbSearchPath,
  getSettings,
  resolveNatsControlPlaneAuth,
  type Settings,
} from "@opengeni/config";
import {
  AccessGrant,
  ReasoningEffort,
  type Session,
  type SessionEvent,
  type SessionStatus,
  type SessionTurn,
  type SessionTurnStatus,
} from "@opengeni/contracts";
import {
  acceptSessionUserMessage,
  type AcceptSessionUserMessageDependencies,
} from "@opengeni/core";
import {
  createDb,
  getSession,
  getSessionEventByClientEventId,
  listPendingSessionTurns,
  type Database,
} from "@opengeni/db";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { Client as TemporalClient, Connection as TemporalConnection } from "@temporalio/client";
import { readFile } from "node:fs/promises";
import { parseArgs as parseNodeArgs } from "node:util";

const operatorSubjectId = "operator:session-revival";
const deterministicClientEventPrefix = "operator-revival";
const maxRecoveryMessageCharacters = 32_768;
const canonicalUuid =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const clientEventOperationKey = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const busySessionStatuses = new Set<SessionStatus>(["queued", "running", "requires_action"]);

export type OperatorQueuePolicy = "reject" | "append";

export type OperatorSessionRevivalInput = {
  workspaceId: string;
  sessionId: string;
  clientEventId: string;
  apply: boolean;
  queuePolicy?: OperatorQueuePolicy;
  message?: string;
  model?: string;
  reasoningEffort?: string;
};

type SafePendingTurn = {
  turnId: string;
  status: SessionTurnStatus;
};

export type OperatorSessionRevivalResult = {
  operation: "operator_session_revival";
  mode: "dry_run" | "apply";
  status: "ready" | "accepted" | "refused";
  workspaceId: string;
  sessionId: string;
  clientEventId: string;
  sessionStatus?: SessionStatus;
  pendingTurns?: SafePendingTurn[];
  eventId?: string;
  turnId?: string;
  turnStatus?: SessionTurnStatus;
  refusal?:
    | "session_not_found_in_workspace"
    | "scope_mismatch"
    | "cancelled_session"
    | "conflicting_work"
    | "duplicate_client_event";
};

export type OperatorSessionRevivalDependencies = {
  getSession: (workspaceId: string, sessionId: string) => Promise<Session | null>;
  getEventByClientEventId: (
    workspaceId: string,
    sessionId: string,
    clientEventId: string,
  ) => Promise<SessionEvent | null>;
  listPendingTurns: (workspaceId: string, sessionId: string) => Promise<SessionTurn[]>;
  acceptUserMessage: (input: {
    grant: ReturnType<typeof AccessGrant.parse>;
    workspaceId: string;
    sessionId: string;
    text: string;
    model: string;
    reasoningEffort: ReturnType<typeof ReasoningEffort.parse>;
    clientEventId: string;
    queuePolicy: "append" | "reject_conflicts";
  }) => Promise<{ accepted: SessionEvent; turn: SessionTurn }>;
};

export function deterministicOperatorClientEventId(
  workspaceId: string,
  sessionId: string,
  operationKey: string,
): string {
  requireCanonicalUuid("workspace ID", workspaceId);
  requireCanonicalUuid("session ID", sessionId);
  if (!clientEventOperationKey.test(operationKey)) {
    throw new Error(
      "operation key must be 1-64 lowercase alphanumeric, dot, underscore, or hyphen characters",
    );
  }
  return `${deterministicClientEventPrefix}:${workspaceId}:${sessionId}:${operationKey}`;
}

export function validateOperatorSessionRevivalInput(input: OperatorSessionRevivalInput): void {
  requireCanonicalUuid("workspace ID", input.workspaceId);
  requireCanonicalUuid("session ID", input.sessionId);
  const expectedPrefix = `${deterministicClientEventPrefix}:${input.workspaceId}:${input.sessionId}:`;
  const operationKey = input.clientEventId.slice(expectedPrefix.length);
  if (
    !input.clientEventId.startsWith(expectedPrefix) ||
    !clientEventOperationKey.test(operationKey)
  ) {
    throw new Error(
      `client event ID must equal ${expectedPrefix}<stable-operation-key> using a 1-64 character lowercase safe key`,
    );
  }
  if (!input.apply) {
    return;
  }
  if (!input.message || input.message.trim().length === 0) {
    throw new Error("apply requires a non-empty recovery message file");
  }
  if (input.message.length > maxRecoveryMessageCharacters) {
    throw new Error(`recovery message exceeds ${maxRecoveryMessageCharacters} characters`);
  }
  if (!input.model || input.model.trim() !== input.model || input.model.length === 0) {
    throw new Error("apply requires an explicit non-empty --model");
  }
  ReasoningEffort.parse(input.reasoningEffort);
}

/**
 * Preflight and optionally revive one exact session through the shared message
 * admission path. This function has no DB, NATS, Temporal, or environment
 * construction so unit tests can prove dry-run performs no write.
 */
export async function runOperatorSessionRevival(
  deps: OperatorSessionRevivalDependencies,
  input: OperatorSessionRevivalInput,
): Promise<OperatorSessionRevivalResult> {
  validateOperatorSessionRevivalInput(input);
  const mode: OperatorSessionRevivalResult["mode"] = input.apply ? "apply" : "dry_run";
  const queuePolicy = input.queuePolicy ?? "reject";
  const base = {
    operation: "operator_session_revival" as const,
    mode,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    clientEventId: input.clientEventId,
  };
  const session = await deps.getSession(input.workspaceId, input.sessionId);
  if (!session) {
    return { ...base, status: "refused", refusal: "session_not_found_in_workspace" };
  }
  if (session.workspaceId !== input.workspaceId || session.id !== input.sessionId) {
    return {
      ...base,
      status: "refused",
      sessionStatus: session.status,
      refusal: "scope_mismatch",
    };
  }

  const [existingEvent, pendingTurns] = await Promise.all([
    deps.getEventByClientEventId(input.workspaceId, input.sessionId, input.clientEventId),
    deps.listPendingTurns(input.workspaceId, input.sessionId),
  ]);
  if (
    pendingTurns.some(
      (turn) => turn.workspaceId !== input.workspaceId || turn.sessionId !== input.sessionId,
    )
  ) {
    return {
      ...base,
      status: "refused",
      sessionStatus: session.status,
      refusal: "scope_mismatch",
    };
  }
  const safePendingTurns = pendingTurns
    .map((turn) => ({ turnId: turn.id, status: turn.status }))
    .sort((left, right) => left.turnId.localeCompare(right.turnId));
  const preflight = {
    ...base,
    sessionStatus: session.status,
    pendingTurns: safePendingTurns,
  };

  if (existingEvent) {
    return duplicateClientEventResult(input, preflight, existingEvent);
  }
  if (session.status === "cancelled") {
    return { ...preflight, status: "refused", refusal: "cancelled_session" };
  }
  if (
    queuePolicy !== "append" &&
    (busySessionStatuses.has(session.status) || safePendingTurns.length > 0)
  ) {
    return { ...preflight, status: "refused", refusal: "conflicting_work" };
  }
  if (!input.apply) {
    return { ...preflight, status: "ready" };
  }

  const reasoningEffort = ReasoningEffort.parse(input.reasoningEffort);
  const grant = AccessGrant.parse({
    workspaceId: input.workspaceId,
    accountId: session.accountId,
    subjectId: operatorSubjectId,
    permissions: ["workspace:admin"],
  });
  try {
    const result = await deps.acceptUserMessage({
      grant,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      text: input.message as string,
      model: input.model as string,
      reasoningEffort,
      clientEventId: input.clientEventId,
      queuePolicy: queuePolicy === "append" ? "append" : "reject_conflicts",
    });
    if (
      result.accepted.workspaceId !== input.workspaceId ||
      result.accepted.sessionId !== input.sessionId ||
      result.turn.workspaceId !== input.workspaceId ||
      result.turn.sessionId !== input.sessionId
    ) {
      throw new Error("shared admission returned a result outside the requested session scope");
    }
    return {
      ...preflight,
      status: "accepted",
      eventId: result.accepted.id,
      turnId: result.turn.id,
      turnStatus: result.turn.status,
    };
  } catch (error) {
    // Close the concurrent same-client-event race without masking any other
    // core failure. postgres.js exposes SQLSTATE 23505 on unique violations.
    if (isUniqueViolation(error)) {
      const racedEvent = await deps.getEventByClientEventId(
        input.workspaceId,
        input.sessionId,
        input.clientEventId,
      );
      if (!racedEvent) {
        throw error;
      }
      return duplicateClientEventResult(input, preflight, racedEvent);
    }
    if (isConflict(error)) {
      // The locked shared admission path checks for newly-active work before
      // attempting the deterministic insert. Two identical callers can both
      // pass the unlocked preflight, then the winner queues the session while
      // the loser waits for the lock. In that case the loser receives 409
      // rather than 23505, so give the exact client-event lookup precedence
      // over generic busy-work classification.
      const racedEvent = await deps.getEventByClientEventId(
        input.workspaceId,
        input.sessionId,
        input.clientEventId,
      );
      if (racedEvent) {
        return duplicateClientEventResult(input, preflight, racedEvent);
      }
      const [currentSession, currentPendingTurns] = await Promise.all([
        deps.getSession(input.workspaceId, input.sessionId),
        deps.listPendingTurns(input.workspaceId, input.sessionId),
      ]);
      if (
        currentSession?.workspaceId === input.workspaceId &&
        currentSession.id === input.sessionId
      ) {
        if (
          currentPendingTurns.some(
            (turn) => turn.workspaceId !== input.workspaceId || turn.sessionId !== input.sessionId,
          )
        ) {
          return {
            ...base,
            status: "refused",
            sessionStatus: currentSession.status,
            refusal: "scope_mismatch",
          };
        }
        const currentPreflight = {
          ...base,
          sessionStatus: currentSession.status,
          pendingTurns: currentPendingTurns.map((turn) => ({
            turnId: turn.id,
            status: turn.status,
          })),
        };
        if (currentSession.status === "cancelled") {
          return { ...currentPreflight, status: "refused", refusal: "cancelled_session" };
        }
        if (
          busySessionStatuses.has(currentSession.status) ||
          currentPreflight.pendingTurns.length > 0
        ) {
          return { ...currentPreflight, status: "refused", refusal: "conflicting_work" };
        }
      }
      return { ...preflight, status: "refused", refusal: "conflicting_work" };
    }
    throw error;
  }
}

function duplicateClientEventResult(
  input: OperatorSessionRevivalInput,
  preflight: Omit<OperatorSessionRevivalResult, "status">,
  event: SessionEvent,
): OperatorSessionRevivalResult {
  if (event.workspaceId !== input.workspaceId || event.sessionId !== input.sessionId) {
    return { ...preflight, status: "refused", refusal: "scope_mismatch" };
  }
  return {
    ...preflight,
    status: "refused",
    eventId: event.id,
    refusal: "duplicate_client_event",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 409);
}

function requireCanonicalUuid(label: string, value: string): void {
  if (!canonicalUuid.test(value)) {
    throw new Error(`${label} must be a canonical lowercase UUID`);
  }
}

type ParsedCliArgs = OperatorSessionRevivalInput & {
  messageFile?: string;
  help: boolean;
};

export function parseOperatorSessionRevivalArgs(argv: string[]): ParsedCliArgs {
  const { values, tokens } = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      "workspace-id": { type: "string" },
      "session-id": { type: "string" },
      "client-event-id": { type: "string" },
      "message-file": { type: "string" },
      model: { type: "string" },
      "reasoning-effort": { type: "string" },
      "queue-policy": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) {
      throw new Error(`duplicate argument: --${token.name}`);
    }
    seen.add(token.name);
  }

  const workspaceId = values["workspace-id"];
  const sessionId = values["session-id"];
  const clientEventId = values["client-event-id"];
  const messageFile = values["message-file"];
  const model = values.model;
  const reasoningEffort = values["reasoning-effort"];
  const rawQueuePolicy = values["queue-policy"];
  const apply = values.apply ?? false;
  const help = values.help ?? false;
  if (rawQueuePolicy !== undefined && rawQueuePolicy !== "append" && rawQueuePolicy !== "reject") {
    throw new Error("--queue-policy must be reject or append");
  }
  const queuePolicy = rawQueuePolicy as OperatorQueuePolicy | undefined;
  if (help) {
    return {
      workspaceId: workspaceId ?? "",
      sessionId: sessionId ?? "",
      clientEventId: clientEventId ?? "",
      apply,
      help,
      ...(messageFile ? { messageFile } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(queuePolicy ? { queuePolicy } : {}),
    };
  }
  if (!workspaceId) throw new Error("missing --workspace-id");
  if (!sessionId) throw new Error("missing --session-id");
  if (!clientEventId) throw new Error("missing --client-event-id");
  if (apply && !messageFile) throw new Error("--apply requires --message-file");
  if (apply && !model) throw new Error("--apply requires --model");
  if (apply && !reasoningEffort) throw new Error("--apply requires --reasoning-effort");
  return {
    workspaceId,
    sessionId,
    clientEventId,
    apply,
    help,
    ...(messageFile ? { messageFile } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(queuePolicy ? { queuePolicy } : {}),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run operator:revive-session --workspace-id <uuid> --session-id <uuid> \\
    --client-event-id operator-revival:<workspace-id>:<session-id>:<stable-key>

Dry-run is the default. Apply additionally requires:
  --apply --message-file <path> --model <id> --reasoning-effort <effort>

When active, queued, or requires-action work exists, the default policy refuses.
Use --queue-policy append only after explicitly deciding to enqueue behind it.`);
}

function databaseReadDependencies(db: Database) {
  return {
    getSession: async (workspaceId: string, sessionId: string) =>
      await getSession(db, workspaceId, sessionId),
    getEventByClientEventId: async (
      workspaceId: string,
      sessionId: string,
      clientEventId: string,
    ) => await getSessionEventByClientEventId(db, workspaceId, sessionId, clientEventId),
    listPendingTurns: async (workspaceId: string, sessionId: string) =>
      await listPendingSessionTurns(db, workspaceId, sessionId),
  };
}

async function createApplyDependencies(
  settings: Settings,
  db: Database,
): Promise<{
  bus: EventBus;
  temporalConnection: TemporalConnection;
  core: AcceptSessionUserMessageDependencies;
}> {
  const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
  const bus = await createNatsEventBus(
    settings.natsUrl,
    controlPlaneAuth ? { user: controlPlaneAuth.user, pass: controlPlaneAuth.password } : undefined,
  );
  try {
    const temporalConnection = await TemporalConnection.connect({ address: settings.temporalHost });
    const temporal = new TemporalClient({
      connection: temporalConnection,
      namespace: settings.temporalNamespace,
    });
    return {
      bus,
      temporalConnection,
      core: {
        settings,
        db,
        bus,
        objectStorage: null,
        workflowClient: {
          wakeSessionWorkflow: async ({ accountId, workspaceId, sessionId, workflowId }) => {
            await temporal.workflow.signalWithStart("sessionWorkflow", {
              taskQueue: settings.temporalTaskQueue,
              workflowId,
              workflowIdReusePolicy: "ALLOW_DUPLICATE",
              args: [{ accountId, workspaceId, sessionId }],
              signal: "queueChanged",
            });
          },
          signalInterrupt: async ({ accountId, workspaceId, sessionId, eventId, workflowId }) => {
            await temporal.workflow.signalWithStart("sessionWorkflow", {
              taskQueue: settings.temporalTaskQueue,
              workflowId,
              workflowIdReusePolicy: "ALLOW_DUPLICATE",
              args: [{ accountId, workspaceId, sessionId }],
              signal: "interrupt",
              signalArgs: [eventId],
            });
          },
        },
      },
    };
  } catch (error) {
    await bus.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseOperatorSessionRevivalArgs(process.argv.slice(2));
    if (parsed.help) {
      printUsage();
      return;
    }
  } catch {
    console.error(
      JSON.stringify({ operation: "operator_session_revival", status: "invalid_input" }),
    );
    process.exitCode = 2;
    return;
  }

  const input: OperatorSessionRevivalInput = {
    workspaceId: parsed.workspaceId,
    sessionId: parsed.sessionId,
    clientEventId: parsed.clientEventId,
    apply: parsed.apply,
    ...(parsed.queuePolicy ? { queuePolicy: parsed.queuePolicy } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
  };
  try {
    if (parsed.messageFile) {
      input.message = await readFile(parsed.messageFile, "utf8");
    }
    validateOperatorSessionRevivalInput(input);
  } catch {
    console.error(
      JSON.stringify({ operation: "operator_session_revival", status: "invalid_input" }),
    );
    process.exitCode = 2;
    return;
  }

  let dbClient: ReturnType<typeof createDb> | undefined;
  let applyDeps: Awaited<ReturnType<typeof createApplyDependencies>> | undefined;
  try {
    const settings = getSettings();
    const searchPath = dbSearchPath(settings);
    dbClient = createDb(settings.databaseUrl, {
      ...(searchPath ? { searchPath } : {}),
      rlsStrategy: settings.rlsStrategy,
    });
    const db = dbClient.db;
    const reads = databaseReadDependencies(db);
    const deps: OperatorSessionRevivalDependencies = {
      ...reads,
      acceptUserMessage: async (request) => {
        if (!applyDeps) {
          applyDeps = await createApplyDependencies(settings, db);
        }
        return await acceptSessionUserMessage(
          applyDeps.core,
          request.grant,
          request.workspaceId,
          request.sessionId,
          {
            text: request.text,
            resources: [],
            tools: [],
            toolsProvided: true,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            clientEventId: request.clientEventId,
            queuePolicy: request.queuePolicy,
          },
        );
      },
    };
    const result = await runOperatorSessionRevival(deps, input);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "refused") {
      process.exitCode = 2;
    }
  } catch {
    // Never echo an upstream error: provider/database errors can contain
    // connection details. The stable target ids are sufficient to correlate
    // control-plane logs and the incident audit trail.
    console.error(
      JSON.stringify({
        operation: "operator_session_revival",
        status: "error",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        clientEventId: input.clientEventId,
      }),
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      applyDeps?.temporalConnection.close(),
      applyDeps?.bus.close(),
      dbClient?.close(),
    ]);
  }
}

if (import.meta.main) {
  await main();
}
