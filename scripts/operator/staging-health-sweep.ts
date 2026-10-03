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
  schemaVersion: "opengeni.staging-health-sweep.v1";
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
export const CONTROL_CTE = `WITH RECURSIVE targets AS MATERIALIZED (
  SELECT id,workspace_id FROM sessions WHERE status IN ('queued','recovering')
  UNION SELECT session_id,workspace_id FROM session_turns WHERE status='queued'
    OR finished_at >= $1::timestamptz - ($2::int * interval '1 minute')
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

export function databaseQueries(): Record<string, string> {
  return {
    queued: `${CONTROL_CTE}, overdue AS (
      SELECT s.id session_id,s.workspace_id,coalesce(q.oldest,s.created_at) queued_at,
        CASE WHEN NOT c.valid THEN 'control_unknown' WHEN s.status IN ('cancelled','failed') THEN 'terminal'
          WHEN c.paused THEN 'paused'
          WHEN s.input_wait_until>$1::timestamptz THEN 'awaiting_input'
          WHEN EXISTS (SELECT 1 FROM session_turns active WHERE active.session_id=s.id AND active.workspace_id=s.workspace_id
            AND active.status IN ('running','requires_action','recovering','waiting_capacity')) THEN 'behind_active_turn'
          ELSE 'runnable' END reason
      FROM candidates s JOIN controls c ON c.id=s.id AND c.workspace_id=s.workspace_id
      LEFT JOIN LATERAL (SELECT min(created_at) oldest FROM session_turns t
        WHERE t.session_id=s.id AND t.workspace_id=s.workspace_id AND t.status='queued') q ON true
      WHERE (q.oldest IS NOT NULL OR s.status='queued') AND coalesce(q.oldest,s.created_at)<$1::timestamptz-interval '2 minutes'
    ) SELECT jsonb_build_object('total',count(*),'runnable',count(*) FILTER(WHERE reason='runnable'),
      'controlUnknown',count(*) FILTER(WHERE reason='control_unknown'),
      'excluded',coalesce((SELECT jsonb_object_agg(reason,n) FROM (SELECT reason,count(*) n FROM overdue WHERE reason!='runnable' GROUP BY reason) x),'{}'),
      'sessions',coalesce((SELECT jsonb_agg(x) FROM (SELECT session_id,workspace_id,queued_at,reason FROM overdue ORDER BY queued_at LIMIT 100) x),'[]')) facts FROM overdue`,
    recovering: `${CONTROL_CTE}, recoveries AS (
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
      SELECT id,workspace_id,session_id,source FROM session_turns WHERE finished_at>=$1::timestamptz-($2::int*interval '1 minute')
        AND finished_at<=$1::timestamptz AND status='completed'
    ), completions AS (
      SELECT e.session_id,e.workspace_id,e.turn_id,e.created_at,
        coalesce(e.payload->>'emptyFinalReply','false')='true' explicit_empty,
        CASE WHEN NOT c.valid THEN 'control_unknown' WHEN s.status IN ('cancelled','failed') THEN 'terminal'
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
      FROM completed_turns t JOIN LATERAL (
        SELECT e.* FROM session_events e WHERE e.turn_id=t.id AND e.workspace_id=t.workspace_id
          AND e.type='turn.completed' AND e.duplicate_of_event_id IS NULL
          ORDER BY e.sequence DESC LIMIT 1
      ) e ON true
      JOIN candidates s ON s.id=e.session_id AND s.workspace_id=e.workspace_id
      JOIN controls c ON c.id=s.id AND c.workspace_id=s.workspace_id
      WHERE e.type='turn.completed' AND e.duplicate_of_event_id IS NULL
        AND e.created_at>=$1::timestamptz-($2::int*interval '1 minute') AND e.created_at<=$1::timestamptz
    ), repeated AS (
      SELECT session_id,workspace_id,count(DISTINCT turn_id) empty_turns,min(created_at) first_at,max(created_at) last_at
      FROM completions WHERE classification='suspect' GROUP BY session_id,workspace_id HAVING count(DISTINCT turn_id)>=2
    ) SELECT jsonb_build_object('sample',count(*),'suspectTurns',count(*) FILTER(WHERE classification='suspect'),
      'repeatedSessions',(SELECT count(*) FROM repeated),'controlUnknown',count(*) FILTER(WHERE classification='control_unknown'),
      'classifications',coalesce((SELECT jsonb_object_agg(classification,n) FROM (SELECT classification,count(*) n FROM completions GROUP BY classification) x),'{}'),
      'sessions',coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM repeated ORDER BY empty_turns DESC LIMIT 100) x),'[]')) facts FROM completions`,
    latency: `SELECT jsonb_build_object('sample',count(*),
      'p50Seconds',percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM started_at-created_at)),
      'p95Seconds',percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at-created_at)),
      'invalidNegativeSamples',count(*) FILTER(WHERE started_at<created_at)) facts FROM session_turns
      WHERE started_at >= $1::timestamptz-($2::int*interval '1 minute') AND started_at<=$1::timestamptz`,
  };
}

// Code and credential are sent via stdin, not process argv, files, or logs.
export const DATABASE_RUNNER = `import {SQL} from 'bun';
const input=await Bun.stdin.json();const db=new SQL(input.url,{max:1,connectionTimeout:5});const result={};
try {
 for(const [name,query] of Object.entries(input.queries)) {
  try { result[name]=await db.begin('READ ONLY ISOLATION LEVEL REPEATABLE READ',async tx=>{
   await tx.unsafe("SET LOCAL statement_timeout='5000ms'");await tx.unsafe("SET LOCAL lock_timeout='1000ms'");
   await tx.unsafe('SET LOCAL row_security=off');
   const roles=await tx.unsafe('SELECT rolsuper OR rolbypassrls global FROM pg_roles WHERE rolname=current_user');
   if(!roles[0]?.global) throw new Error('global_read_role_required');
   return (await tx.unsafe(query,[input.now,input.windowMinutes]))[0].facts;
  }); } catch(error) { result[name]={gap:'database_query_failed_or_global_read_role_unavailable',
    code: typeof error.code==='string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'unavailable'}; }
 }
} finally {await db.close();} console.log(JSON.stringify(result));`;

export function memoryBytes(value: string): number {
  const m = /^([0-9.]+)([KMGTPE]i|[kMGTPE]|m)?$/.exec(value);
  if (!m) throw new Error("invalid Kubernetes quantity");
  const unit = m[2] ?? "";
  if (unit === "m") return Number(m[1]) / 1000;
  const power = unit ? "KMGTPE".indexOf(unit[0]!.toUpperCase()) + 1 : 0;
  return Number(m[1]) * (unit.endsWith("i") ? 1024 : 1000) ** power;
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
  ) => {
    try {
      const facts = await read();
      checks.push({ id, definition, facts, status: bad(facts) ? "finding" : "ok" });
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
        const limitBytes = spec.resources?.limits?.memory
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
        "Sessions with a queued turn older than 120s (or never-claimed queued session age); excludes effective pauses, live waits, and active predecessors; first 100 oldest listed.",
      recovering:
        "Recovering sessions older than 300s since latest durable recovering status event, excluding effective pauses; missing timestamps are gaps.",
      empty: `At least two distinct completed suspect turns in ${options.windowMinutes}m; explicit emptyFinalReply or no reply/tools. Excludes effective pauses, waits, maintenance and unflagged tool-only continuations; not proof of failed work.`,
      latency: `created_at to started_at for logical turns started during the preceding ${options.windowMinutes}m, all sources; includes queue residence, excludes never-started turns. Database exact percentiles, not TTFT.`,
    };
    let data: any;
    try {
      let url = process.env.OPENGENI_HEALTH_DATABASE_URL;
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
    for (const [name, definition] of Object.entries(definitions)) {
      const facts = data[name];
      const required =
        name === "queued"
          ? ["total", "runnable", "controlUnknown"]
          : name === "recovering"
            ? ["total", "controlUnknown", "missingStatusTimestamp"]
            : name === "empty"
              ? ["sample", "suspectTurns", "repeatedSessions", "controlUnknown"]
              : ["sample", "invalidNegativeSamples"];
      const invalid =
        !facts || required.some((key) => !Number.isFinite(facts[key]) || facts[key] < 0);
      const gap =
        invalid ||
        facts.gap ||
        facts.controlUnknown > 0 ||
        facts.missingStatusTimestamp > 0 ||
        facts.invalidNegativeSamples > 0;
      checks.push({
        id: name,
        definition,
        status: gap
          ? "gap"
          : (
                name === "queued"
                  ? facts.runnable > 0
                  : name === "empty"
                    ? facts.repeatedSessions > 0
                    : name === "recovering"
                      ? facts.total > 0
                      : false
              )
            ? "finding"
            : "ok",
        ...(facts && !facts.gap && !invalid ? { facts } : {}),
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
  );
  await Promise.all([kube, memory, database(), errorRates]);
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: "opengeni.staging-health-sweep.v1",
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
              ([key]) => !["sessions", "containers", "samples", "coverage"].includes(key),
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
