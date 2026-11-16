// Real child worker for the tool-call durability crash matrix. It runs the
// production turn activity against the parent's PostgreSQL and SIGKILLs
// itself at one exact point between a model response's end and the next
// model dispatch. The parent then runs worker-death recovery and a new
// attempt; killing this process cannot destroy any durable system.
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createDb } from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import { createActivityTestHarness } from "../../src/activities";
import {
  HistoryScriptedModel,
  adminSql,
  appendCrashLog,
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
const sql = adminSql(appUrl, schema);
const model = new HistoryScriptedModel({
  beforeResponse: (step) => {
    if (point === "next_dispatch" && step === "final") crash();
  },
  onResponse: (step, responseId) => {
    latestStep = step;
    latestResponseId = responseId;
    appendCrashLog(logFile, { kind: "response", pid: process.pid, step, responseId });
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

const settings = testSettings({ databaseUrl: appUrl, openaiModel: "scripted-model", sandboxBackend: "none" });
const base = createObservability(settings, { component: "worker" });
const observability: Observability = new Proxy(base, {
  get(target, key, receiver) {
    if (key === "observeHistogram") {
      return (input: { name: string; labels?: Record<string, string> }) => {
        const phase = input.labels?.phase;
        if (input.name === "opengeni_model_step_phase_duration_seconds") {
          // Billing of the latest response committed.
          if (phase === "response_usage_billing")
            appendCrashLog(logFile, { kind: "billed", pid: process.pid, responseId: latestResponseId! });
          if (latestStep === "call-1") {
            if (phase === "response_usage_lease" && point === "settlement_started") crash();
            if (phase === "response_usage_billing" && point === "billing_committed") crash();
            if (phase === "response_usage_checkpoint" && point === "usage_committed") crash();
          }
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
console.log(`TOOL_CRASH_RESULT ${JSON.stringify({ status: result.status })}`);
await sql.end();
await app.close();
process.exit(0);
