// Real child worker for the tool-call durability crash matrix. It runs the
// production turn activity against the parent's PostgreSQL and SIGKILLs
// itself at one exact point between a model response's end and the next
// model dispatch. The parent then runs worker-death recovery and a new
// attempt; killing this process cannot destroy any durable system.
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { createDb, recoverSessionDispatch } from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import { createActivityTestHarness } from "../../src/activities";
import {
  HistoryScriptedModel,
  adminSql,
  appendCrashLog,
  crashTestSettings,
  durableCallState,
  scriptedRuntime,
  type ModelStep,
} from "./tool-call-crash-support";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const appUrl = env("TOOL_CRASH_APP_URL");
const schema = env("TOOL_CRASH_SCHEMA");
const logFile = env("TOOL_CRASH_LOG");
const point = env("TOOL_CRASH_POINT");
const accountId = env("TOOL_CRASH_ACCOUNT_ID");
const workspaceId = env("TOOL_CRASH_WORKSPACE_ID");
const sessionId = env("TOOL_CRASH_SESSION_ID");
const attemptId = env("TOOL_CRASH_ATTEMPT_ID");

const crash = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

// The crash targets the second response (call-1); call-0 completes normally.
let latestStep: ModelStep | null = null;
let latestResponseId: string | null = null;
let call1Returned = false;
const app = createDb(appUrl, { searchPath: schema });
const sql = adminSql(env("TOOL_CRASH_ADMIN_URL"), schema);
const model = new HistoryScriptedModel({
  beforeResponse: (step) => {
    if (point === "next_dispatch" && step === "final") crash();
  },
  onResponse: async (step, responseId) => {
    latestStep = step;
    latestResponseId = responseId;
    appendCrashLog(logFile, { kind: "response", pid: process.pid, step, responseId });
    // The orchestrator declares this worker dead and fences its attempt while
    // the provider is still answering: the response's usage was incurred but
    // this attempt may not record its tool calls.
    if (point.startsWith("fenced") && step === "call-1") {
      const recovered = await recoverSessionDispatch(app.db, workspaceId, {
        sessionId,
        attemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
      });
      appendCrashLog(logFile, { kind: "fenced", pid: process.pid, action: recovered.action });
    }
  },
  afterResponse: (step) => {
    // The provider stream has ended and the SDK asked for its next event.
    if (point === "response_end" && step === "call-1") crash();
  },
});
const runtime = scriptedRuntime(model, async (callId) => {
  // What recovery could see of this call when its tool started.
  const durable = await durableCallState(sql, sessionId, callId);
  appendCrashLog(logFile, { kind: "tool_entry", pid: process.pid, callId, ...durable });
  if (point === "tool_entry" && callId === "call-1") crash();
  // The tool's side effect.
  appendCrashLog(logFile, { kind: "tool", pid: process.pid, callId });
  if (point === "tool_ran" && callId === "call-1") crash();
  if (callId === "call-1") call1Returned = true;
  return `${callId} done`;
});

const settings = crashTestSettings(appUrl);
const base = createObservability(settings, { component: "worker" });
// Response settlement of call-1: lease renewed, then its one combined commit
// (usage, history, tool-call records), then its deferred ledger writes.
let call1LeaseRenewed = false;
let call1Committed = false;
const observability: Observability = new Proxy(base, {
  get(target, key, receiver) {
    if (key === "observeHistogram") {
      return (input: { name: string; labels?: Record<string, string> }) => {
        const phase = input.labels?.phase;
        if (input.name === "opengeni_model_step_phase_duration_seconds") {
          // The latest response's deferred ledger writes committed.
          if (phase === "response_usage_billing") {
            appendCrashLog(logFile, { kind: "billed", pid: process.pid, responseId: latestResponseId! });
            if (latestStep === "call-1") call1Billed = true;
          }
          if (latestStep === "call-1") {
            if (phase === "response_usage_lease") {
              call1LeaseRenewed = true;
              if (point === "settlement_started") crash();
            }
            if (phase === "response_usage_checkpoint") {
              call1Committed = true;
              // Combined commit, or for a fenced attempt its usage-only audit row.
              if (point === "combined_committed" || point === "fenced_usage_committed") crash();
            }
            if (
              phase === "response_usage_billing" &&
              (point === "debit_committed" || point === "fenced_debit_committed")
            )
              crash();
          }
        }
        // Inside the combined transaction (usage with the call's records, so
        // more than one event): its rows are written, it has not committed.
        if (
          input.name === "opengeni_session_event_append_phase_seconds" &&
          phase === "projection" &&
          input.labels?.batch_size_class !== "1" &&
          call1LeaseRenewed &&
          !call1Committed &&
          point === "combined_write_during"
        ) {
          appendCrashLog(logFile, { kind: "in_combined_write", pid: process.pid });
          crash();
        }
        return target.observeHistogram(input as never);
      };
    }
    if (key === "incrementCounter") {
      return (input: { name: string }) => {
        // The completed call's output is about to be persisted.
        if (input.name === "opengeni_agent_tool_calls_total" && call1Returned && point === "tool_completed")
          crash();
        return target.incrementCounter(input as never);
      };
    }
    return Reflect.get(target, key, receiver);
  },
});
// output_before_debit: call-1's ledger writes are slowed in the database, so
// its tool output (which waits only for the response's usage commit) becomes
// durable while those writes are still pending; the worker dies right then.
let call1Billed = false;
let outputWatch: ReturnType<typeof setInterval> | null = null;
if (point === "output_before_debit") {
  const slow = `tool_crash_slow_ledger_${sessionId.replaceAll("-", "")}`;
  await sql.unsafe(`
    create function ${slow}() returns trigger language plpgsql as $$
    begin
      if new.session_id = '${sessionId}'::uuid and new.source_resource_id like '%resp-call-1-%' then
        perform pg_sleep(1.5);
      end if;
      return new;
    end $$;
    create trigger ${slow} before insert on usage_events
      for each row execute function ${slow}()`);
  let polling = false;
  outputWatch = setInterval(() => {
    if (polling) return;
    polling = true;
    void sql<{ id: string }[]>`
      select payload->>'id' as id from session_events
      where session_id = ${sessionId} and type = 'agent.toolCall.output'
        and payload->>'id' = 'call-1'`
      .then((rows) => {
        if (rows.length > 0 && !call1Billed) {
          appendCrashLog(logFile, { kind: "output_before_debit", pid: process.pid });
          crash();
        }
      })
      .finally(() => {
        polling = false;
      });
  }, 2);
}
// Billing of a response that completed before the crash is observed above;
// a response with no usage phase is logged as billed by the parent from the
// usage ledger instead.
const activities = createActivityTestHarness({
  settings,
  db: app.db,
  bus: new MemoryEventBus(),
  runtime,
  observability,
});
const result = await activities.runAgentTurn({
  accountId,
  workspaceId,
  sessionId,
  workflowId: `session-${sessionId}`,
  workflowRunId: crypto.randomUUID(),
  attemptId,
  trigger: { kind: "next" },
});
if (outputWatch) clearInterval(outputWatch);
console.log(`TOOL_CRASH_RESULT ${JSON.stringify({ status: result.status })}`);
await sql.end();
await app.close();
process.exit(0);
