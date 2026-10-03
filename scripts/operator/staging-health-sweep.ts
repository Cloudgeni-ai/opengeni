#!/usr/bin/env bun
/** Read-only, bounded reliability snapshot. Never logs credentials or source errors. */
export interface SweepOptions {
  context: string;
  namespace: string;
  windowMinutes: number;
  baselineMinutes: number;
  timeoutSeconds: number;
  databaseSecret?: string;
  databaseSecretKey: string;
  dbPod: string;
  prometheusNamespace: string;
  prometheusService: string;
  format: "json" | "text";
}
export interface Check {
  id: string;
  status: "ok" | "finding" | "gap";
  definition: string;
  facts?: Record<string, unknown>;
  gap?: string;
}
export interface SweepResult {
  schemaVersion: "opengeni.staging-health-sweep.v2";
  observedAt: string;
  durationMs: number;
  context: string;
  namespace: string;
  exitCode: 0 | 1 | 2;
  checks: Check[];
}
export type Run = (args: string[], stdin?: string) => Promise<string>;

export function parseArgs(args: string[]): SweepOptions {
  const out: SweepOptions = {
    context: "opengeni-stg-neu-aks-admin",
    namespace: "opengeni",
    windowMinutes: 30,
    baselineMinutes: 120,
    timeoutSeconds: 20,
    databaseSecretKey: "OPENGENI_MIGRATIONS_DATABASE_URL",
    dbPod: "deployment/opengeni-api",
    prometheusNamespace: "observability",
    prometheusService: "opengeni-observability-prometheus",
    format: "json",
  };
  const keys: Record<string, keyof SweepOptions> = {
    "--context": "context",
    "--namespace": "namespace",
    "--window-minutes": "windowMinutes",
    "--baseline-minutes": "baselineMinutes",
    "--timeout-seconds": "timeoutSeconds",
    "--database-secret": "databaseSecret",
    "--database-secret-key": "databaseSecretKey",
    "--db-pod": "dbPod",
    "--prometheus-namespace": "prometheusNamespace",
    "--prometheus-service": "prometheusService",
    "--format": "format",
  };
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i]!];
    const value = args[++i];
    if (!key || !value) throw new Error("invalid arguments");
    if (["windowMinutes", "baselineMinutes", "timeoutSeconds"].includes(key)) {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > (key === "timeoutSeconds" ? 60 : 1440))
        throw new Error("invalid bounds");
      Object.assign(out, { [key]: n });
    } else {
      if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error("invalid identifier");
      Object.assign(out, { [key]: value });
    }
  }
  if (!["json", "text"].includes(out.format)) throw new Error("invalid format");
  return out;
}

// Canonical revision-aware inherited pause semantics: session-control.ts discovery projection.
// Only candidate paths are visited. Cycles/depth overflow fail closed rather than report active.
export function controlCte(includeRecentTurns: boolean, includeQueueWork = true): string {
  return `WITH RECURSIVE targets AS MATERIALIZED (
  SELECT id,workspace_id FROM sessions WHERE status IN ('queued','recovering')
  ${includeQueueWork ? "UNION SELECT session_id,workspace_id FROM session_turns WHERE status='queued' AND source IN ('user','api') UNION SELECT session_id,workspace_id FROM session_system_updates WHERE state='pending'" : ""}
  ${includeRecentTurns ? "UNION SELECT session_id,workspace_id FROM session_turns WHERE finished_at >= $1::timestamptz - ($2::int * interval '1 minute')" : ""}
), candidates AS MATERIALIZED (
  SELECT s.id,s.workspace_id,s.parent_session_id,s.direct_control_state,s.direct_pause_revision,
    s.subtree_run_override_revision,s.status,s.input_wait_until,s.created_at
  FROM targets t JOIN sessions s ON s.id=t.id AND s.workspace_id=t.workspace_id
), ancestry AS (
  SELECT s.id target_id,s.workspace_id,s.id,s.parent_session_id,s.direct_control_state,
    s.direct_pause_revision,s.subtree_run_override_revision,0 depth,ARRAY[s.id] visited,false cycle
  FROM candidates s UNION ALL
  SELECT a.target_id,a.workspace_id,p.id,p.parent_session_id,p.direct_control_state,
    p.direct_pause_revision,p.subtree_run_override_revision,a.depth+1,a.visited||p.id,p.id=ANY(a.visited)
  FROM ancestry a JOIN sessions p ON p.id=a.parent_session_id AND p.workspace_id=a.workspace_id
  WHERE NOT a.cycle AND a.depth<10000
), path AS (
  SELECT a.*,max(subtree_run_override_revision) OVER (PARTITION BY target_id ORDER BY depth
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) descendant_override FROM ancestry a
), controls AS (
  SELECT s.id, s.workspace_id,
    NOT EXISTS (SELECT 1 FROM path p WHERE p.target_id=s.id AND (p.cycle OR p.depth>=10000))
      AND w.workspace_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM path p WHERE p.target_id=s.id AND p.parent_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sessions parent WHERE parent.id=p.parent_session_id AND parent.workspace_id=p.workspace_id)) valid,
    EXISTS (SELECT 1 FROM path p WHERE p.target_id=s.id AND p.direct_control_state='paused'
      AND (p.direct_pause_revision IS NULL OR p.descendant_override IS NULL OR p.descendant_override<=p.direct_pause_revision))
    OR (w.workspace_state='paused' AND (w.workspace_pause_revision IS NULL OR NOT EXISTS
      (SELECT 1 FROM path p WHERE p.target_id=s.id AND p.subtree_run_override_revision>w.workspace_pause_revision))) paused
  FROM candidates s LEFT JOIN workspace_inference_controls w ON w.workspace_id=s.workspace_id
)`;
}

export const CONTROL_CTE = controlCte(true, false);

export function safeDatabaseErrorCode(error: unknown): string {
  let candidate = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!candidate || typeof candidate !== "object") break;
    const value = candidate as { errno?: unknown; code?: unknown; cause?: unknown };
    for (const code of [value.errno, value.code]) {
      if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) return code;
    }
    candidate = value.cause;
  }
  return "unavailable";
}

export function databaseQueries(): Record<string, string> {
  return {
    queued: `${controlCte(false)}, pending_work AS (
      SELECT s.id session_id,s.workspace_id,least(q.oldest,u.oldest) queued_at,
        CASE WHEN q.oldest IS NOT NULL AND (u.oldest IS NULL OR q.oldest<=u.oldest) THEN 'queued_human_api_turn'
          WHEN u.oldest IS NOT NULL THEN 'pending_system_update' ELSE 'unknown' END age_source,
        CASE WHEN NOT c.valid THEN 'control_unknown' WHEN s.status IN ('cancelled','failed') THEN 'terminal'
          WHEN c.paused THEN 'paused'
          WHEN EXISTS (SELECT 1 FROM session_turns active WHERE active.session_id=s.id AND active.workspace_id=s.workspace_id
            AND active.status IN ('running','requires_action','recovering','waiting_capacity')) THEN 'behind_active_turn'
          ELSE 'runnable' END reason
      FROM candidates s JOIN controls c ON c.id=s.id AND c.workspace_id=s.workspace_id
      LEFT JOIN LATERAL (SELECT min(created_at) oldest FROM session_turns t
        WHERE t.session_id=s.id AND t.workspace_id=s.workspace_id AND t.status='queued' AND t.source IN ('user','api')) q ON true
      LEFT JOIN LATERAL (SELECT min(created_at) oldest FROM session_system_updates u
        WHERE u.session_id=s.id AND u.workspace_id=s.workspace_id AND u.state='pending') u ON true
      WHERE s.status='queued' OR q.oldest IS NOT NULL OR u.oldest IS NOT NULL
    ), overdue AS (
      SELECT * FROM pending_work WHERE queued_at<$1::timestamptz-interval '2 minutes' OR queued_at IS NULL
    ) SELECT jsonb_build_object('total',count(*) FILTER(WHERE queued_at IS NOT NULL),
      'unknownAgeCandidates',count(*) FILTER(WHERE queued_at IS NULL),'runnable',count(*) FILTER(WHERE reason='runnable'),
      'controlUnknown',count(*) FILTER(WHERE reason='control_unknown'),
      'excluded',coalesce((SELECT jsonb_object_agg(reason,n) FROM (SELECT reason,count(*) n FROM overdue WHERE reason!='runnable' GROUP BY reason) x),'{}'),
      'sessions',coalesce((SELECT jsonb_agg(x) FROM (SELECT session_id,workspace_id,queued_at,age_source,reason FROM overdue ORDER BY queued_at NULLS FIRST LIMIT 100) x),'[]')) facts FROM overdue`,
    recovering: `${controlCte(false, false)}, recoveries AS (
      SELECT s.id session_id,s.workspace_id,r.since,c.paused,c.valid FROM candidates s
      JOIN controls c ON c.id=s.id AND c.workspace_id=s.workspace_id
      LEFT JOIN LATERAL (SELECT e.created_at since FROM session_events e WHERE e.session_id=s.id AND e.workspace_id=s.workspace_id
        AND e.type='session.status.changed' AND e.payload->>'status'='recovering' ORDER BY e.sequence DESC LIMIT 1) r ON true
      WHERE s.status='recovering'
    ) SELECT jsonb_build_object('total',count(*) FILTER(WHERE since<$1::timestamptz-interval '5 minutes' AND NOT paused),
      'missingStatusTimestamp',count(*) FILTER(WHERE since IS NULL),'controlUnknown',count(*) FILTER(WHERE NOT valid),
      'pausedExcluded',count(*) FILTER(WHERE paused),
      'sessions',coalesce((SELECT jsonb_agg(x) FROM (SELECT session_id,workspace_id,since FROM recoveries
        WHERE since<$1::timestamptz-interval '5 minutes' AND NOT paused ORDER BY since LIMIT 100) x),'[]')) facts FROM recoveries`,
    empty: `${CONTROL_CTE}, completed_turns AS MATERIALIZED (
      SELECT id,workspace_id,session_id,source,finished_at FROM session_turns WHERE finished_at>=$1::timestamptz-($2::int*interval '1 minute')
        AND finished_at<=$1::timestamptz AND status='completed'
    ), completions AS (
      SELECT t.session_id,t.workspace_id,t.id turn_id,coalesce(e.created_at,t.finished_at) created_at,
        coalesce(e.payload->>'emptyFinalReply','false')='true' explicit_empty,
        CASE WHEN e.id IS NULL OR jsonb_typeof(e.payload) IS DISTINCT FROM 'object' THEN 'missing_evidence'
          WHEN NOT c.valid THEN 'control_unknown' WHEN s.status IN ('cancelled','failed') THEN 'terminal'
          WHEN c.paused THEN 'paused'
          WHEN s.input_wait_until>$1::timestamptz OR EXISTS (SELECT 1 FROM session_events wait
            WHERE wait.workspace_id=e.workspace_id AND wait.turn_id=e.turn_id
              AND wait.type='agent.toolCall.created' AND wait.payload->>'name' IN ('wait_for_input','request_human_input')) THEN 'awaiting_input'
          WHEN t.source='compaction' THEN 'maintenance'
          WHEN coalesce(e.payload->>'emptyFinalReply','false')='true' THEN 'suspect'
          WHEN length(btrim(coalesce(e.payload->>'output','')||coalesce(e.payload->>'reply','')))>0 THEN 'reply'
          WHEN EXISTS (SELECT 1 FROM session_events tool WHERE tool.workspace_id=e.workspace_id AND tool.turn_id=e.turn_id
            AND tool.type IN ('agent.toolCall.created','agent.toolCall.output')) THEN 'tool_only'
          ELSE 'suspect' END classification
      FROM completed_turns t LEFT JOIN LATERAL (
        SELECT e.* FROM session_events e WHERE e.turn_id=t.id AND e.workspace_id=t.workspace_id
          AND e.type='turn.completed' AND e.duplicate_of_event_id IS NULL
          AND e.created_at>=$1::timestamptz-($2::int*interval '1 minute') AND e.created_at<=$1::timestamptz
          ORDER BY e.sequence DESC LIMIT 1
      ) e ON true
      JOIN candidates s ON s.id=t.session_id AND s.workspace_id=t.workspace_id
      JOIN controls c ON c.id=s.id AND c.workspace_id=s.workspace_id
    ), repeated AS (
      SELECT session_id,workspace_id,count(DISTINCT turn_id) empty_turns,min(created_at) first_at,max(created_at) last_at
      FROM completions WHERE classification='suspect' GROUP BY session_id,workspace_id HAVING count(DISTINCT turn_id)>=2
    ) SELECT jsonb_build_object('sample',count(*),'suspectTurns',count(*) FILTER(WHERE classification='suspect'),
      'missingCompletionEvidence',count(*) FILTER(WHERE classification='missing_evidence'),
      'repeatedSessions',(SELECT count(*) FROM repeated),'controlUnknown',count(*) FILTER(WHERE classification='control_unknown'),
      'classifications',coalesce((SELECT jsonb_object_agg(classification,n) FROM (SELECT classification,count(*) n FROM completions GROUP BY classification) x),'{}'),
      'sessions',coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM repeated ORDER BY empty_turns DESC LIMIT 100) x),'[]')) facts FROM completions`,
    latency: `WITH recent AS MATERIALIZED (
      SELECT id,workspace_id,session_id,created_at FROM session_turns
      WHERE started_at >= $1::timestamptz-($2::int*interval '1 minute') AND started_at<=$1::timestamptz
    ), observations AS (
      SELECT t.created_at,first.first_started_at FROM recent t LEFT JOIN LATERAL (
        SELECT min(e.created_at) first_started_at FROM session_events e
        WHERE e.workspace_id=t.workspace_id AND e.session_id=t.session_id AND e.turn_id=t.id
          AND e.type='turn.started' AND e.duplicate_of_event_id IS NULL
      ) first ON true
    ) SELECT jsonb_build_object(
      'sample',count(*) FILTER(WHERE first_started_at >= $1::timestamptz-($2::int*interval '1 minute') AND first_started_at<=$1::timestamptz),
      'p50Seconds',percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM first_started_at-created_at))
        FILTER(WHERE first_started_at >= $1::timestamptz-($2::int*interval '1 minute') AND first_started_at<=$1::timestamptz),
      'p95Seconds',percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM first_started_at-created_at))
        FILTER(WHERE first_started_at >= $1::timestamptz-($2::int*interval '1 minute') AND first_started_at<=$1::timestamptz),
      'recentLatestStartCandidates',count(*),
      'resumedFromBeforeWindow',count(*) FILTER(WHERE first_started_at<$1::timestamptz-($2::int*interval '1 minute')),
      'missingFirstStartEvents',count(*) FILTER(WHERE first_started_at IS NULL),
      'futureFirstStartEvents',count(*) FILTER(WHERE first_started_at>$1::timestamptz),
      'invalidNegativeSamples',count(*) FILTER(WHERE first_started_at<created_at),
      'startTimestampSource','earliest_nonduplicate_turn.started_created_at') facts FROM observations`,
  };
}

// Code and credential are sent via stdin, not process argv, files, or logs.
export const DATABASE_RUNNER = `import {SQL} from 'bun';
const safeDatabaseErrorCode=${safeDatabaseErrorCode.toString()};
const input=await Bun.stdin.json();const db=new SQL(input.url,{max:1,connectionTimeout:5});const result={};
try {
 for(const [name,query] of Object.entries(input.queries)) {
  try { result[name]=await db.begin('READ ONLY ISOLATION LEVEL REPEATABLE READ',async tx=>{
   await tx.unsafe("SET LOCAL statement_timeout='5000ms'");await tx.unsafe("SET LOCAL lock_timeout='1000ms'");
   await tx.unsafe('SET LOCAL row_security=off');
   const roles=await tx.unsafe('SELECT rolsuper OR rolbypassrls global FROM pg_roles WHERE rolname=current_user');
   if(!roles[0]?.global) throw new Error('global_read_role_required');
   const parameters=['empty','latency'].includes(name)?[input.now,input.windowMinutes]:[input.now];
   return (await tx.unsafe(query,parameters))[0].facts;
  }); } catch(error) { result[name]={gap:'database_query_failed_or_global_read_role_unavailable',
    code:safeDatabaseErrorCode(error)}; }
 }
} finally {await db.close();} console.log(JSON.stringify(result));`;

// Canonical peek requires FOR SHARE, which PostgreSQL prohibits in READ ONLY.
// The observer invokes only SELECT-based APIs; its entire transaction always rolls back.
// Inject only read services, suppress gauge refresh, and never provide a wake/recovery port.
export const CANONICAL_RUNNER = `
import {createDb,evaluateSessionControl} from '/app/packages/db/src/index.ts';
import {getSettings,temporalConnectionOptions} from '/app/packages/config/src/index.ts';
import {createSessionStateActivities} from '/app/apps/worker/src/activities/session-state.ts';
import {temporalActivityLeaseSettled,temporalWorkflowExecutionNotFound} from '/app/apps/worker/src/index.ts';
import {Connection} from '@temporalio/client';
import {sql} from 'drizzle-orm';
const safeDatabaseErrorCode=${safeDatabaseErrorCode.toString()};
const input=await Bun.stdin.json();const client=createDb(input.url,{max:2});
const settings=getSettings();let connection=null;const observations=[];
const rollback=new Error('health_observer_rollback');
try {
 const [role]=await client.db.execute(sql.raw('SELECT rolsuper OR rolbypassrls AS global FROM pg_roles WHERE rolname=current_user'));
 if(!role?.global) throw new Error('global_read_role_required');
 try {connection=await Connection.connect({...temporalConnectionOptions(settings),connectTimeout:3000});}catch{}
 const inspect=async(ref)=>{
  if(!connection) throw new Error('temporal_unavailable');
  let description;
  try {description=await connection.withDeadline(Date.now()+2000,()=>connection.workflowService.describeWorkflowExecution({
   namespace:settings.temporalNamespace,execution:{workflowId:ref.workflowId,runId:ref.workflowRunId}}));}
  catch(error){if(temporalWorkflowExecutionNotFound(error))return 'settled';throw error;}
  return temporalActivityLeaseSettled(description.pendingActivities?.find(a=>a.activityId===ref.activityId))?'settled':'pending';
 };
 await Promise.all(input.targets.map(async(target)=>{
  let result={session_id:target.session_id,workspace_id:target.workspace_id,gap:'canonical_observation_unavailable'};
  let rollbackProven=false;let errorCode='unavailable';
  try {await client.db.transaction(async(tx)=>{
   await tx.execute(sql.raw("SET LOCAL statement_timeout='3000ms'"));
   await tx.execute(sql.raw("SET LOCAL lock_timeout='1000ms'"));
   const control=await evaluateSessionControl(tx,target.workspace_id,target.session_id,{lock:'none'});
   const activities=createSessionStateActivities(async()=>({db:tx,observability:{warn(){}},inspectSessionAttemptActivity:inspect}),
    {countQueuedTurns:async()=>0,recordTurnsQueuedGauge:()=>{}});
   const peek=await activities.peekSessionWork({workspaceId:target.workspace_id,sessionId:target.session_id});
   result={session_id:target.session_id,workspace_id:target.workspace_id,state:control.state,
    settlement:control.settlement,kind:peek.kind,ownerActivityState:peek.ownerActivityState??null,
    turnId:peek.turnId??null,attemptId:peek.attemptId??null,executionGeneration:peek.executionGeneration??null,
    activityRef:peek.activityRef?{workflowId:peek.activityRef.workflowId,workflowRunId:peek.activityRef.workflowRunId,
      activityId:peek.activityRef.activityId,quiesced:peek.activityRef.quiesced}:null};
   throw rollback;
  },{isolationLevel:'read committed'});}catch(error){rollbackProven=error===rollback;
   const code=safeDatabaseErrorCode(error);
   if(code!=='unavailable')errorCode=code;
   else if(['TypeError','SessionControlInvariantError','SessionControlBusyError'].includes(error?.name))errorCode=error.name;
   else if(typeof error?.message==='string'){
    if(error.message.includes('still owned by attempt'))errorCode='attempt_ownership_inconsistent';
    else if(error.message.includes('terminal active turn'))errorCode='terminal_active_turn';
    else if(error.message.includes('missing active turn'))errorCode='missing_active_turn';
   }
  }
  observations.push(rollbackProven?result:{session_id:target.session_id,workspace_id:target.workspace_id,gap:'canonical_observation_unavailable',code:errorCode});
 }));
}finally{await connection?.close();await client.close();}
console.log(JSON.stringify(observations));`;

export interface OwnerObservation {
  session_id: string;
  workspace_id: string;
  state?: "active" | "paused";
  settlement?: unknown;
  kind?: string;
  ownerActivityState?: "pending" | "settled" | "unknown" | null;
  turnId?: string | null;
  attemptId?: string | null;
  executionGeneration?: number | null;
  activityRef?: {
    workflowId: string;
    workflowRunId: string;
    activityId: string;
    quiesced?: boolean;
  } | null;
  gap?: string;
  code?: string;
}

export function ownerClassification(observation: OwnerObservation | undefined): string {
  if (!observation || observation.gap || !["active", "paused"].includes(observation.state ?? ""))
    return "unknown";
  if (observation.state === "paused") return "paused";
  if (observation.kind === "attempt-owned") {
    const ref = observation.activityRef;
    if (
      !observation.turnId ||
      !observation.attemptId ||
      !Number.isSafeInteger(observation.executionGeneration) ||
      !ref?.workflowId ||
      !ref.workflowRunId ||
      !ref.activityId
    )
      return "unknown";
    if (observation.ownerActivityState === "pending") return "active_owner";
    if (observation.ownerActivityState === "settled") return "settled_owner_candidate";
    return "unknown";
  }
  if (observation.kind === "runnable")
    return observation.settlement === null ? "runnable_candidate" : "settlement_wait";
  if (
    [
      "admission-blocked",
      "capacity-wait",
      "sandbox-lifecycle-wait",
      "approval-wait",
      "approval-pending",
      "input-wait",
      "idle",
      "interruption-pending",
      "cancellation-wait",
    ].includes(observation.kind ?? "")
  )
    return observation.kind!;
  return "unknown";
}

export function applyOwnership(facts: any, observations: OwnerObservation[], recovering = false) {
  const rows = Array.isArray(facts.sessions) ? facts.sessions : [];
  const targets = rows.filter(
    (row: any) => recovering || ["runnable", "behind_active_turn"].includes(row.reason),
  );
  let ownerUnknown = 0;
  let unknownQueueAge = 0;
  let actionable = 0;
  const classifications: Record<string, number> = {};
  const ownership = targets.map((row: any) => {
    const observation = observations.find(
      (o) => o.session_id === row.session_id && o.workspace_id === row.workspace_id,
    );
    const canonicalClassification = ownerClassification(observation);
    const ageUnknown =
      !recovering &&
      row.queued_at == null &&
      ["runnable_candidate", "settled_owner_candidate"].includes(canonicalClassification);
    const classification = ageUnknown ? "queue_age_unknown" : canonicalClassification;
    if (ageUnknown) unknownQueueAge++;
    if (classification === "unknown") ownerUnknown++;
    if (["runnable_candidate", "settled_owner_candidate"].includes(classification)) actionable++;
    classifications[classification] = (classifications[classification] ?? 0) + 1;
    return {
      session_id: row.session_id,
      workspace_id: row.workspace_id,
      classification,
      ...(observation && !observation.gap ? { observation } : {}),
      ...(observation?.gap
        ? { gap: "canonical_observation_unavailable", code: observation.code ?? "unavailable" }
        : {}),
    };
  });
  // A capped SQL list cannot certify candidates outside its sample.
  const omitted = recovering
    ? Math.max(0, facts.total - rows.length)
    : Math.max(0, facts.runnable - rows.filter((row: any) => row.reason === "runnable").length) +
      Math.max(
        0,
        (facts.excluded?.behind_active_turn ?? 0) -
          rows.filter((row: any) => row.reason === "behind_active_turn").length,
      );
  const { runnable, ...otherFacts } = facts;
  return {
    ...otherFacts,
    ...(recovering ? {} : { sqlRunnableCandidates: runnable }),
    actionable,
    ownerUnknown: ownerUnknown + omitted,
    ...(recovering ? {} : { unknownQueueAge }),
    ownershipClassifications: classifications,
    ownership,
    ownershipDefinition:
      "Canonical control and double-peek owner revalidation; exact Temporal workflow run/activity metadata. Age is triage, never quiescence or permission to recover.",
  };
}

export function memoryBytes(value: unknown): number {
  if (typeof value !== "string") throw new Error("invalid Kubernetes quantity");
  const m = /^\+?((?:\d+(?:\.\d*)?|\.\d+))([KMGTPE]i|[numkMGTPE]|[eE][+-]?\d+)?$/.exec(value);
  if (!m) throw new Error("invalid Kubernetes quantity");
  const unit = m[2] ?? "";
  const power = unit ? "KMGTPE".indexOf(unit[0]!.toUpperCase()) + 1 : 0;
  const factor = /^[eE][+-]?\d+$/.test(unit)
    ? 10 ** Number(unit.slice(1))
    : unit === "n"
      ? 1e-9
      : unit === "u"
        ? 1e-6
        : unit === "m"
          ? 1e-3
          : (unit.endsWith("i") ? 1024 : 1000) ** power;
  const bytes = Number(m[1]) * factor;
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("invalid Kubernetes quantity");
  return bytes;
}

export function podFacts(value: any): Record<string, unknown> {
  if (!Array.isArray(value.items)) throw new Error("invalid pod list");
  const containers = value.items.flatMap((p: any) =>
    [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])].map(
      (c: any) => ({
        pod: p.metadata.name,
        container: c.name,
        restarts: c.restartCount,
        currentReason: c.state?.terminated?.reason ?? null,
        lastReason: c.lastState?.terminated?.reason ?? null,
        lastFinishedAt: c.lastState?.terminated?.finishedAt ?? null,
      }),
    ),
  );
  return {
    pods: value.items.length,
    restartTotal: containers.reduce((n: number, c: any) => n + c.restarts, 0),
    oomContainers: containers.filter(
      (c: any) => c.currentReason === "OOMKilled" || c.lastReason === "OOMKilled",
    ).length,
    containers: containers.filter((c: any) => c.restarts > 0 || c.currentReason === "OOMKilled"),
    coverage:
      "Current pods only; restarts are lifetime counters, lastState is only the latest termination. Deleted pods require retained telemetry.",
  };
}

export function errorComparison(
  current: { requests: number; errors: number },
  baseline: { requests: number; errors: number },
) {
  for (const n of [current.requests, current.errors, baseline.requests, baseline.errors]) {
    if (!Number.isFinite(n) || n < 0) throw new Error("invalid counter increase");
  }
  if (current.errors > current.requests || baseline.errors > baseline.requests)
    throw new Error("inconsistent error denominator");
  const currentRate = current.requests > 0 ? current.errors / current.requests : null;
  const baselineRate = baseline.requests > 0 ? baseline.errors / baseline.requests : null;
  const spike =
    current.requests >= 20 &&
    current.errors >= 3 &&
    currentRate !== null &&
    baselineRate !== null &&
    currentRate >= Math.max(0.01, baselineRate * 2) &&
    currentRate - baselineRate >= 0.01;
  return {
    current,
    baseline,
    currentRate,
    baselineRate,
    spike,
    comparison:
      currentRate === null || baselineRate === null ? "insufficient_traffic" : "available",
  };
}

export async function sweep(
  options: SweepOptions,
  run: Run,
  now = new Date(),
): Promise<SweepResult> {
  const started = performance.now();
  const k = [
    "kubectl",
    "--context",
    options.context,
    `--request-timeout=${options.timeoutSeconds}s`,
  ];
  const checks: Check[] = [];
  const add = async (
    id: string,
    definition: string,
    read: () => Promise<Record<string, unknown>>,
    bad: (f: any) => boolean,
    incomplete?: (f: any) => boolean,
  ) => {
    try {
      const facts = await read();
      const gap = incomplete?.(facts) ?? false;
      checks.push({
        id,
        definition,
        facts,
        status: gap ? "gap" : bad(facts) ? "finding" : "ok",
        ...(gap ? { gap: "source_evidence_incomplete" } : {}),
      });
    } catch {
      checks.push({
        id,
        definition,
        status: "gap",
        gap: "source_unavailable_invalid_or_timed_out",
      });
    }
  };
  const pods = run([...k, "-n", options.namespace, "get", "pods", "-o", "json"]).then(JSON.parse);
  // The rejection is also consumed by both downstream source checks.
  const kube = add(
    "pod-restarts-oom",
    "Current pod lifetime restarts and latest/current OOM terminations, not a windowed restart rate.",
    async () => podFacts(await pods),
    (f) => f.restartTotal > 0 || f.oomContainers > 0,
  );
  const memory = add(
    "api-memory",
    "Kubernetes metrics-server current container working set in bytes; timestamp and window per pod.",
    async () => {
      const [p, m] = await Promise.all([
        pods,
        run([
          ...k,
          "get",
          "--raw",
          `/apis/metrics.k8s.io/v1beta1/namespaces/${options.namespace}/pods`,
        ]).then(JSON.parse),
      ]);
      if (!Array.isArray(m.items)) throw new Error("invalid metrics list");
      const api = p.items.filter(
        (v: any) =>
          v.metadata.labels?.["app.kubernetes.io/component"] === "api" &&
          v.status.phase === "Running",
      );
      if (!api.length) throw new Error("no API pods");
      const samples = api.map((v: any) => {
        const sample = m.items.find((x: any) => x.metadata.name === v.metadata.name);
        const sampledAt = sample ? Date.parse(sample.timestamp) : NaN;
        if (
          !sample ||
          !Number.isFinite(sampledAt) ||
          now.getTime() - sampledAt > 180000 ||
          sampledAt - now.getTime() > 30000
        )
          throw new Error("missing or stale API metrics");
        const usage = sample.containers.find((c: any) => c.name === "api");
        const spec = v.spec.containers.find((c: any) => c.name === "api");
        if (!usage) throw new Error("missing API container");
        const bytes = memoryBytes(usage.usage.memory);
        const limitBytes =
          spec.resources?.limits?.memory !== undefined
            ? memoryBytes(spec.resources.limits.memory)
            : null;
        return {
          pod: v.metadata.name,
          timestamp: sample.timestamp,
          window: sample.window,
          bytes,
          limitBytes,
          fractionOfLimit: limitBytes ? bytes / limitBytes : null,
        };
      });
      return {
        expectedPods: api.length,
        samples,
        minBytes: Math.min(...samples.map((sample: any) => sample.bytes)),
        maxBytes: Math.max(...samples.map((sample: any) => sample.bytes)),
        highMemoryPods: samples.filter(
          (s: any) => s.fractionOfLimit !== null && s.fractionOfLimit >= 0.8,
        ).length,
      };
    },
    (f) => f.highMemoryPods > 0,
  );

  const database = async () => {
    const definitions: Record<string, string> = {
      queued:
        "Accepted pending human/API turns and system updates across all session projections, plus durable queued sessions. Known age >120s uses earliest pending-work created_at, never session creation. Historical internal queued-turn rows alone are not pending-work authority. Unknown-age canonical runnable work is a gap. Canonical control.peekSessionWork and exact owner metadata classify candidates; first 100 listed, at most 20 observed.",
      recovering:
        "Recovering sessions older than 300s since latest durable recovering status event; excludes effective pauses and canonical waits/pending owners. Missing transition or ownership evidence is a gap, not proof of physical quiescence.",
      empty: `All completed turns in ${options.windowMinutes}m retain denominator coverage; missing usable turn.completed evidence is a gap. At least two distinct suspect turns flag repeated empty replies; explicit emptyFinalReply or no reply/tools, excluding effective pauses, waits, maintenance and unflagged tool-only continuations; not proof of failed work.`,
      latency: `Logical acceptance created_at to FIRST nonduplicate durable turn.started event created_at, first starts during the preceding ${options.windowMinutes}m, all sources; latest-resume started_at is only a candidate filter, never the latency timestamp. Prior-window first starts are excluded; missing first-start events are a gap. Database exact percentiles, not TTFT.`,
    };
    let data: any;
    let url = process.env.OPENGENI_HEALTH_DATABASE_URL;
    try {
      if (options.databaseSecret) {
        const s = JSON.parse(
          await run([
            ...k,
            "-n",
            options.namespace,
            "get",
            "secret",
            options.databaseSecret,
            "-o",
            "json",
          ]),
        );
        if (!s.data?.[options.databaseSecretKey]) throw new Error("missing key");
        url = Buffer.from(s.data[options.databaseSecretKey], "base64").toString();
      }
      if (!url) throw new Error("no database source");
      data = JSON.parse(
        await run(
          [
            ...k,
            "-n",
            options.namespace,
            "exec",
            "-i",
            options.dbPod,
            "--",
            "bun",
            "-e",
            DATABASE_RUNNER,
          ],
          JSON.stringify({
            url,
            now: now.toISOString(),
            windowMinutes: options.windowMinutes,
            queries: databaseQueries(),
          }),
        ),
      );
    } catch {
      data = {};
    }
    const queueRows = Array.isArray(data.queued?.sessions)
      ? data.queued.sessions.filter((row: any) =>
          ["runnable", "behind_active_turn"].includes(row.reason),
        )
      : [];
    const recoveryRows = Array.isArray(data.recovering?.sessions) ? data.recovering.sessions : [];
    const targets = [
      ...new Map(
        [...queueRows, ...recoveryRows].map((row: any) => [
          `${row.workspace_id}:${row.session_id}`,
          row,
        ]),
      ).values(),
    ].slice(0, 20);
    let observations: OwnerObservation[] = [];
    if (url && targets.length) {
      try {
        const value = JSON.parse(
          await run(
            [
              ...k,
              "-n",
              options.namespace,
              "exec",
              "-i",
              options.dbPod,
              "--",
              "bun",
              "-e",
              CANONICAL_RUNNER,
            ],
            JSON.stringify({ url, targets }),
          ),
        );
        if (!Array.isArray(value)) throw new Error("invalid canonical observations");
        observations = value;
      } catch {
        /* Missing ownership evidence remains an explicit gap below. */
      }
    }
    if (data.queued && !data.queued.gap) data.queued = applyOwnership(data.queued, observations);
    if (data.recovering && !data.recovering.gap)
      data.recovering = applyOwnership(data.recovering, observations, true);
    for (const [name, definition] of Object.entries(definitions)) {
      const facts = data[name];
      const required =
        name === "queued"
          ? ["total", "sqlRunnableCandidates", "controlUnknown", "unknownQueueAge"]
          : name === "recovering"
            ? ["total", "controlUnknown", "missingStatusTimestamp"]
            : name === "empty"
              ? [
                  "sample",
                  "suspectTurns",
                  "repeatedSessions",
                  "controlUnknown",
                  "missingCompletionEvidence",
                ]
              : [
                  "sample",
                  "invalidNegativeSamples",
                  "missingFirstStartEvents",
                  "futureFirstStartEvents",
                ];
      const invalid =
        !facts || required.some((key) => !Number.isFinite(facts[key]) || facts[key] < 0);
      const gap =
        invalid ||
        facts.gap ||
        facts.controlUnknown > 0 ||
        facts.ownerUnknown > 0 ||
        facts.unknownQueueAge > 0 ||
        facts.missingCompletionEvidence > 0 ||
        facts.missingStatusTimestamp > 0 ||
        facts.missingFirstStartEvents > 0 ||
        facts.futureFirstStartEvents > 0 ||
        facts.invalidNegativeSamples > 0;
      checks.push({
        id: name,
        definition,
        status: gap
          ? "gap"
          : (
                name === "queued"
                  ? facts.actionable > 0
                  : name === "empty"
                    ? facts.repeatedSessions > 0
                    : name === "recovering"
                      ? facts.actionable > 0
                      : false
              )
            ? "finding"
            : "ok",
        ...(facts && !facts.gap && !invalid ? { facts } : {}),
        ...(facts?.gap
          ? {
              facts: {
                sourceErrorCode:
                  typeof facts.code === "string" && /^[A-Z0-9]{5}$/.test(facts.code)
                    ? facts.code
                    : "unavailable",
              },
            }
          : {}),
        ...(gap ? { gap: "database_source_or_control_evidence_unavailable" } : {}),
      });
    }
  };
  const errorRates = add(
    "api-error-rate",
    `HTTP 5xx / all API requests, preceding ${options.windowMinutes}m vs disjoint preceding ${options.baselineMinutes}m; counter-reset-safe Prometheus increase. Spike: >=20 requests, >=3 errors, rate >= max(1%,2x baseline), +1 percentage point.`,
    async () => {
      const query = async (q: string) => {
        const path = `/api/v1/namespaces/${options.prometheusNamespace}/services/http:${options.prometheusService}:9090/proxy/api/v1/query?time=${encodeURIComponent(now.toISOString())}&query=${encodeURIComponent(q)}`;
        const j = JSON.parse(await run([...k, "get", "--raw", path]));
        if (
          j.status !== "success" ||
          !Array.isArray(j.data?.result) ||
          j.data.result.length !== 1 ||
          j.warnings?.length
        )
          throw new Error("missing metrics");
        const value = Number(j.data.result[0].value[1]);
        if (!Number.isFinite(value)) throw new Error("nonfinite metric");
        return value;
      };
      // Historical counters alone cannot certify a currently unavailable scrape target.
      if ((await query(`min(up{namespace="${options.namespace}",job="opengeni-api"})`)) !== 1) {
        throw new Error("API scrape unavailable");
      }
      const selector = `namespace="${options.namespace}",component="api"`;
      const totals = async (minutes: number, offset: string) => {
        const requests = await query(
          `sum(increase(opengeni_http_requests_total{${selector}}[${minutes}m]${offset}))`,
        );
        const errors = await query(
          `sum(increase(opengeni_http_requests_total{${selector},status=~"5.."}[${minutes}m]${offset})) or vector(0)`,
        );
        return { requests, errors };
      };
      const [current, baseline] = await Promise.all([
        totals(options.windowMinutes, ""),
        totals(options.baselineMinutes, ` offset ${options.windowMinutes}m`),
      ]);
      return errorComparison(current, baseline);
    },
    (f) => f.spike,
    (f) => f.comparison !== "available",
  );
  await Promise.all([kube, memory, database(), errorRates]);
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: "opengeni.staging-health-sweep.v2",
    observedAt: now.toISOString(),
    durationMs: Math.round(performance.now() - started),
    context: options.context,
    namespace: options.namespace,
    exitCode: checks.some((c) => c.status === "gap")
      ? 2
      : checks.some((c) => c.status === "finding")
        ? 1
        : 0,
    checks,
  };
}

export function textResult(result: SweepResult): string {
  return [
    `${result.observedAt} ${result.context}/${result.namespace} exit=${result.exitCode} duration=${result.durationMs}ms`,
    ...result.checks.map((c) => {
      const facts = c.facts
        ? Object.fromEntries(
            Object.entries(c.facts).filter(
              ([key]) =>
                ![
                  "sessions",
                  "containers",
                  "samples",
                  "coverage",
                  "ownership",
                  "ownershipDefinition",
                ].includes(key),
            ),
          )
        : { gap: c.gap };
      return `${c.status.toUpperCase()} ${c.id}: ${JSON.stringify(facts)}`;
    }),
  ].join("\n");
}

export function boundedRun(seconds: number): Run {
  return async (args, stdin) => {
    const child = Bun.spawn(args, {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), seconds * 1000);
    try {
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) throw new Error("source command failed");
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await sweep(options, boundedRun(options.timeoutSeconds));
    console.log(options.format === "json" ? JSON.stringify(result) : textResult(result));
    process.exitCode = result.exitCode;
  } catch {
    console.error("Health sweep arguments invalid; see scripts/operator/staging-health-sweep.md.");
    process.exitCode = 2;
  }
}
