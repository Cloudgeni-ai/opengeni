/**
 * Rich, clearly fake (Acme Robotics) conversations for the design preview.
 *
 * Each seed is a script over ConversationBuilder, which emits the same event
 * shapes a real worker persists. Scripts receive the ids of seeded children,
 * artifacts and files so links and cards resolve to real rows.
 */
import { ConversationBuilder, mcpJson, mcpText } from "./timeline";
import type { HumanInputQuestion, Initiator } from "./timeline";

export type SeededFile = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  updatedAt: string;
  dimensions?: { width: number; height: number };
};

/** A seeded artifact a conversation can link to or show as a card. */
export type ArtifactRef =
  | { kind: "file"; id: string; href: string; file: SeededFile }
  | { kind: "editable"; id: string; href: string }
  | { kind: "site"; id: string; href: string; title: string; revision: number };

export type ScriptContext = {
  workspaceId: string;
  /** Child session ids by child key. */
  children: Record<string, string>;
  /** Seeded artifacts by seed key (see files.ts and the Site seeds). */
  artifacts: Record<string, ArtifactRef | undefined>;
};

export type GoalSeed = {
  text: string;
  status: "completed" | "paused";
  successCriteria?: string;
  evidence?: string;
  pausedReason?: string;
};

export type RichSessionSeed = {
  title: string;
  hoursAgo: number;
  /** Who sent the first message; defaults to the owner. */
  initiator?: Initiator;
  unread?: boolean;
  pinned?: boolean;
  folder?: string;
  goal?: GoalSeed;
  children?: { key: string; title: string; script: (b: ConversationBuilder) => void }[];
  script: (b: ConversationBuilder, ctx: ScriptContext) => void;
};

const GITHUB = (toolName: string, title: string) => ({
  toolName,
  title,
  accountLabel: "GitHub · acme-robotics",
});
const LINEAR = (toolName: string, title: string) => ({
  toolName,
  title,
  accountLabel: "Linear · Acme Robotics",
});
const DATADOG = (toolName: string, title: string) => ({
  toolName,
  title,
  accountLabel: "Datadog · datadoghq.eu",
});
const PAGERDUTY = (toolName: string, title: string) => ({
  toolName,
  title,
  accountLabel: "PagerDuty · acme-robotics",
});

const link = (label: string, ref: ArtifactRef | undefined) =>
  ref ? `[${label}](${ref.href})` : `**${label}**`;
const image = (alt: string, ref: ArtifactRef | undefined) =>
  ref?.kind === "file" ? `![${alt}](artifact:${ref.id})` : "";
const publish = (b: ConversationBuilder, ctx: ScriptContext, key: string, path: string) => {
  const ref = ctx.artifacts[key];
  if (ref?.kind === "file") b.publishFile(ctx.workspaceId, ref.file, path);
};

// ---------------------------------------------------------------------------
// Personal workspace
// ---------------------------------------------------------------------------

const planReliabilitySprint: RichSessionSeed = {
  title: "Plan the Q4 reliability sprint",
  hoursAgo: 2,
  pinned: true,
  folder: "Planning",
  goal: {
    text: "A prioritized three-week reliability plan for two engineers, based on the open Linear backlog and our SLOs.",
    status: "completed",
    successCriteria: "Every open reliability issue is either scheduled or explicitly deferred.",
    evidence:
      "Plan covers 8 of 8 open issues: 6 scheduled across three weeks, 2 deferred with reasons.",
  },
  script: (b, ctx) => {
    b.user(
      "Help me plan the Q4 reliability sprint. Pull the open reliability issues from Linear, check what our runbooks say about SLOs, and give me a prioritized plan for two engineers over three weeks.",
      {
        startup: [
          ["sandbox", 2100],
          ["tools", 640],
          ["provider_first_byte", 1180],
        ],
      },
    )
      .goal("goal.set", "A prioritized three-week reliability plan for two engineers.")
      .think(
        "I need three inputs: the open reliability backlog, the current SLO targets, and which incidents hurt us last quarter. Linear has the backlog, the workspace knowledge has the SLOs and incident notes. Then I can size the work against 2 engineers × 15 working days.",
      )
      .tool({
        name: "linear__list_issues",
        display: LINEAR("list_issues", "List issues"),
        args: { team: "PLAT", labels: ["reliability"], state: "open", limit: 25 },
        output: mcpJson({
          issues: [
            {
              id: "PLAT-412",
              title: "Checkout mock server races test startup",
              priority: 2,
              estimate: 2,
            },
            {
              id: "PLAT-398",
              title: "Backups take 3h when analytics prune fails",
              priority: 1,
              estimate: 3,
            },
            {
              id: "PLAT-377",
              title: "No alert before TLS certificates expire",
              priority: 1,
              estimate: 2,
            },
            {
              id: "PLAT-366",
              title: "Webhook consumer can stall without alerting",
              priority: 1,
              estimate: 5,
            },
            {
              id: "PLAT-351",
              title: "Deploy lock is left held after a cancelled pipeline",
              priority: 2,
              estimate: 2,
            },
            {
              id: "PLAT-340",
              title: "Cache node restart drops checkout p95 by 4x",
              priority: 2,
              estimate: 5,
            },
            { id: "PLAT-322", title: "Move job queue off Redis", priority: 3, estimate: 8 },
            {
              id: "PLAT-301",
              title: "Runbook for regional failover is out of date",
              priority: 3,
              estimate: 2,
            },
          ],
        }),
      })
      .tool({
        name: "opengeni__knowledge_search",
        args: { query: "SLO targets checkout availability latency error budget" },
        output: mcpJson({
          results: [
            {
              title: "Checkout SLO",
              snippet: "99.9% of checkout requests succeed over 28 days; p95 latency under 400 ms.",
            },
            {
              title: "Deploy freeze on Fridays after 14:00",
              snippet:
                "No production deploys after 14:00 on Fridays unless it fixes an active incident.",
            },
            {
              title: "March staging outage",
              snippet:
                "Staging was down for 3 hours after a certificate expired. We now alert 14 days before expiry.",
            },
          ],
        }),
      })
      .say(
        "I have 8 open issues and the checkout SLO (99.9%, p95 < 400 ms). Two of last month's incidents map directly to PLAT-366 and PLAT-340, so those go first.",
      )
      .answer(
        [
          "Here is a plan that fits **2 engineers × 3 weeks (≈30 engineer-days)** with a 20% buffer for interrupts.",
          "",
          "## Priorities",
          "",
          "| # | Issue | Why now | Size | Owner |",
          "| --- | --- | --- | ---: | --- |",
          "| 1 | PLAT-366 Webhook consumer stalls silently | Caused Thursday's 1 h delay; no alert fired | 5 d | Jonas |",
          "| 2 | PLAT-340 Cache restart hurts checkout p95 | Burned 38% of the monthly error budget | 5 d | Bendik |",
          "| 3 | PLAT-398 Slow backups when prune fails | Backup window overlaps EU morning traffic | 3 d | Jonas |",
          "| 4 | PLAT-377 Certificate expiry alert | Same failure mode as the March outage | 2 d | Bendik |",
          "| 5 | PLAT-351 Stuck deploy lock | Blocks hotfixes, weekly occurrence | 2 d | Jonas |",
          "| 6 | PLAT-412 Test mock race | Flaky CI slows every other item | 2 d | Bendik |",
          "",
          "**Deferred:** PLAT-322 (queue migration, 8 d, better as its own project) and PLAT-301 (runbook refresh, pair it with the Q1 failover drill).",
          "",
          "## Week by week",
          "",
          "- [x] Week 1: PLAT-366 alerting + consumer heartbeat, PLAT-412 readiness wait",
          "- [ ] Week 2: PLAT-340 cache warm-up on restart, PLAT-377 expiry alert",
          "- [ ] Week 3: PLAT-398 prune job permissions + alert, PLAT-351 lock release",
          "- [ ] Retro and error-budget review on the last Friday",
          "",
          "> Keep deploys out of Friday afternoons; the freeze starts at 14:00.",
          "",
          `I also turned this into a deck for Monday's planning meeting: ${link("Q4 reliability sprint", ctx.artifacts.reliabilityDeck)}.`,
        ].join("\n"),
      );
  },
};

const billingQueueMigration: RichSessionSeed = {
  title: "Migrate billing worker to the Postgres queue",
  hoursAgo: 5,
  pinned: true,
  folder: "Billing",
  script: (b, ctx) => {
    b.user(
      "Move the billing worker off the Redis queue and onto a Postgres-backed job queue (SKIP LOCKED), like we decided in the architecture notes. Keep the job handlers unchanged.",
      {
        startup: [
          ["sandbox", 3400],
          ["repository", 5200],
          ["tools", 700],
          ["provider_first_byte", 950],
        ],
      },
    )
      .think(
        "The handlers should not change, so I'll put the new queue behind the same `enqueue`/`process` interface the worker already uses. First find every place that constructs the Redis queue.",
      )
      .exec(
        'rg -n "new Queue\\(" services/billing',
        'services/billing/src/worker.ts:14:const invoices = new Queue("invoices", { connection: redis });\nservices/billing/src/worker.ts:15:const payouts = new Queue("payouts", { connection: redis });\nservices/billing/src/api/retry.ts:9:const invoices = new Queue("invoices", { connection: redis });',
        { seconds: 0.08 },
      )
      .exec(
        "sed -n '1,40p' services/billing/src/worker.ts",
        [
          'import { Queue, Worker } from "bullmq";',
          'import { redis } from "./redis";',
          'import { handleInvoice } from "./jobs/invoice";',
          'import { handlePayout } from "./jobs/payout";',
          "",
          "// Two queues, one worker each. Concurrency is tuned for the m6i.large pool.",
          'const invoices = new Queue("invoices", { connection: redis });',
          'const payouts = new Queue("payouts", { connection: redis });',
          "",
          'new Worker("invoices", handleInvoice, { connection: redis, concurrency: 8 });',
          'new Worker("payouts", handlePayout, { connection: redis, concurrency: 2 });',
          "",
          "export { invoices, payouts };",
        ].join("\n"),
        { seconds: 0.02 },
      )
      .say(
        "Three call sites, all using the same small surface (`add` and a worker callback). I'll add a `PgQueue` with that surface so the handlers stay untouched.",
      )
      .patch([
        {
          type: "create_file",
          path: "services/billing/src/queue/pg-queue.ts",
          diff: [
            '+import type { Sql } from "postgres";',
            "+",
            "+export type Handler<T> = (job: { id: string; data: T; attempt: number }) => Promise<void>;",
            "+",
            "+export class PgQueue<T> {",
            "+  constructor(",
            "+    private readonly sql: Sql,",
            "+    readonly name: string,",
            "+  ) {}",
            "+",
            "+  async add(data: T, options: { runAt?: Date } = {}) {",
            "+    await this.sql`",
            "+      insert into jobs (queue, payload, run_at)",
            "+      values (${this.name}, ${this.sql.json(data)}, ${options.runAt ?? new Date()})`;",
            "+  }",
            "+",
            "+  /** Claim one due job; SKIP LOCKED lets many workers poll safely. */",
            "+  async claim(): Promise<{ id: string; data: T; attempt: number } | null> {",
            "+    const [job] = await this.sql`",
            "+      update jobs set locked_until = now() + interval '5 minutes', attempt = attempt + 1",
            "+      where id = (",
            "+        select id from jobs",
            "+        where queue = ${this.name} and run_at <= now() and locked_until < now()",
            "+        order by run_at for update skip locked limit 1)",
            "+      returning id, payload as data, attempt`;",
            "+    return job ?? null;",
            "+  }",
            "+}",
          ].join("\n"),
        },
        {
          type: "update_file",
          path: "services/billing/src/worker.ts",
          diff: [
            "@@ -1,13 +1,15 @@",
            '-import { Queue, Worker } from "bullmq";',
            '-import { redis } from "./redis";',
            '+import { sql } from "./db";',
            '+import { PgQueue } from "./queue/pg-queue";',
            '+import { runWorker } from "./queue/run-worker";',
            ' import { handleInvoice } from "./jobs/invoice";',
            ' import { handlePayout } from "./jobs/payout";',
            " ",
            " // Two queues, one worker each. Concurrency is tuned for the m6i.large pool.",
            '-const invoices = new Queue("invoices", { connection: redis });',
            '-const payouts = new Queue("payouts", { connection: redis });',
            '+const invoices = new PgQueue(sql, "invoices");',
            '+const payouts = new PgQueue(sql, "payouts");',
            " ",
            '-new Worker("invoices", handleInvoice, { connection: redis, concurrency: 8 });',
            '-new Worker("payouts", handlePayout, { connection: redis, concurrency: 2 });',
            "+runWorker(invoices, handleInvoice, { concurrency: 8 });",
            "+runWorker(payouts, handlePayout, { concurrency: 2 });",
            " ",
            " export { invoices, payouts };",
          ].join("\n"),
        },
      ])
      .exec(
        "bun test services/billing",
        [
          "bun test v1.4.0",
          "",
          "services/billing/test/pg-queue.test.ts:",
          "✓ PgQueue > claims each job exactly once across 16 workers [412.08ms]",
          "✓ PgQueue > respects run_at for delayed jobs [18.40ms]",
          "✓ PgQueue > re-delivers a job after locked_until expires [5006.12ms]",
          "",
          "services/billing/test/invoice.test.ts:",
          "✓ handleInvoice > issues an invoice once per order [22.91ms]",
          "✓ handleInvoice > is idempotent on retry [9.03ms]",
          "",
          " 47 pass",
          " 0 fail",
          " 132 expect() calls",
          "Ran 47 tests across 9 files. [6.84s]",
        ].join("\n"),
        { seconds: 6.9 },
      );
    publish(b, ctx, "pgQueueTs", "/workspace/services/billing/src/queue/pg-queue.ts");
    b.answer(
      [
        "The billing worker now runs on a Postgres job queue. Handlers are unchanged.",
        "",
        "- `PgQueue` exposes the same `add()` the call sites already used, so `api/retry.ts` only changed its import.",
        "- Workers claim with `FOR UPDATE SKIP LOCKED`, so we can run many replicas without double processing.",
        "- All **47 tests pass**, including a new test that runs 16 workers against 1,000 jobs.",
        "",
        "```ts",
        'const invoices = new PgQueue(sql, "invoices");',
        "runWorker(invoices, handleInvoice, { concurrency: 8 });",
        "```",
      ].join("\n"),
    );

    b.user("Show me the SQL for the jobs table and the claim query.", { after: 240 }).answer(
      [
        "The table is small on purpose; the partial index keeps the claim query fast even with a large history.",
        "",
        "```sql",
        "create table jobs (",
        "  id           uuid primary key default gen_random_uuid(),",
        "  queue        text not null,",
        "  payload      jsonb not null,",
        "  run_at       timestamptz not null default now(),",
        "  locked_until timestamptz not null default '-infinity',",
        "  attempt      int not null default 0,",
        "  created_at   timestamptz not null default now()",
        ");",
        "",
        "create index jobs_due_idx on jobs (queue, run_at)",
        "  where locked_until < 'infinity';",
        "```",
        "",
        "The claim runs in one statement, so a crash between select and update cannot leak a lock:",
        "",
        "```sql",
        "update jobs",
        "   set locked_until = now() + interval '5 minutes',",
        "       attempt = attempt + 1",
        " where id = (select id from jobs",
        "             where queue = $1 and run_at <= now() and locked_until < now()",
        "             order by run_at",
        "             for update skip locked",
        "             limit 1)",
        "returning id, payload, attempt;",
        "```",
      ].join("\n"),
      6,
    );

    b.user("What happens if a worker dies in the middle of a job?", { after: 180 })
      .think(
        "The lock is a lease, not a transaction, so a dead worker's job becomes visible again after locked_until. The handler must be idempotent; invoices already use an idempotency key, payouts need checking.",
      )
      .exec(
        'rg -n "idempotencyKey" services/billing/src/jobs',
        "services/billing/src/jobs/invoice.ts:21:  const idempotencyKey = `invoice:${job.data.orderId}`;\nservices/billing/src/jobs/payout.ts:34:  const idempotencyKey = `payout:${job.data.payoutId}:${job.attempt}`;",
        { seconds: 0.05 },
      )
      .answer(
        [
          "The job is re-delivered after its 5-minute lease runs out. That is safe only if the handler is idempotent, and **one handler is not**:",
          "",
          "| Failure | What happens | Safe? |",
          "| --- | --- | --- |",
          "| Worker crashes before the provider call | Job re-delivered after 5 min | Yes |",
          "| Crash after an invoice is issued | Re-delivered, provider dedupes on `invoice:<orderId>` | Yes |",
          "| Crash after a payout is sent | Re-delivered with a **new** key (`attempt` is part of it) | **No: double payout** |",
          "| Database unavailable | Claim fails, worker backs off | Yes |",
          "",
          "Fix: drop `job.attempt` from the payout key so retries reuse it:",
          "",
          "```ts",
          "const idempotencyKey = `payout:${job.data.payoutId}`;",
          "```",
          "",
          "This matches the runbook rule *Never replay a charge by hand*.",
        ].join("\n"),
      );

    b.user("Fix the payout key, add a queue depth metric, and run the load test.", { after: 300 })
      .patch([
        {
          type: "update_file",
          path: "services/billing/src/jobs/payout.ts",
          diff: [
            "@@ -32,5 +32,5 @@ export async function handlePayout(job: Job<PayoutJob>) {",
            "   const payout = await payouts.get(job.data.payoutId);",
            '   if (payout.status === "sent") return;',
            "-  const idempotencyKey = `payout:${job.data.payoutId}:${job.attempt}`;",
            "+  const idempotencyKey = `payout:${job.data.payoutId}`;",
            "   await provider.send(payout, { idempotencyKey });",
          ].join("\n"),
        },
        {
          type: "update_file",
          path: "services/billing/src/queue/run-worker.ts",
          diff: [
            "@@ -1,4 +1,11 @@",
            '+import { gauge } from "../metrics";',
            "+",
            '+const depth = gauge("billing_queue_depth", "Due jobs waiting to be claimed", ["queue"]);',
            "+",
            " export function runWorker<T>(queue: PgQueue<T>, handler: Handler<T>, options: Options) {",
            "+  setInterval(async () => {",
            "+    depth.set({ queue: queue.name }, await queue.dueCount());",
            "+  }, 15_000).unref();",
          ].join("\n"),
        },
      ])
      .exec(
        "k6 run --vus 64 --duration 5m load/billing-enqueue.js",
        [
          "     scenarios: (100.00%) 1 scenario, 64 max VUs, 5m30s max duration",
          "",
          "     ✓ enqueue accepted",
          "     ✓ job processed within 30s",
          "",
          "     checks.........................: 100.00% ✓ 191842      ✗ 0",
          "     http_req_duration..............: avg=11.2ms  p(95)=24.9ms  p(99)=41.3ms",
          "     jobs_processed.................: 95921   319.7/s",
          "     queue_depth_max................: 212",
          "     iterations.....................: 95921   319.7/s",
        ].join("\n"),
        { seconds: 312.4 },
      )
      .answer(
        [
          "Done. Load test at 64 virtual users for 5 minutes:",
          "",
          "| Metric | Redis queue (last week) | Postgres queue | Change |",
          "| --- | ---: | ---: | ---: |",
          "| Throughput | 301 jobs/s | **320 jobs/s** | +6% |",
          "| Enqueue p95 | 19.8 ms | 24.9 ms | +5.1 ms |",
          "| Max queue depth | 540 | **212** | −61% |",
          "| Failed checks | 0 | 0 | — |",
          "",
          "`billing_queue_depth` is exported every 15 s with a `queue` label.",
        ].join("\n"),
      );

    b.user("Open a PR for it.", { after: 120 })
      .exec(
        'git checkout -b billing/pg-queue && git commit -am "billing: move worker to Postgres job queue"',
        "Switched to a new branch 'billing/pg-queue'\n[billing/pg-queue 4f2c9e1] billing: move worker to Postgres job queue\n 6 files changed, 184 insertions(+), 23 deletions(-)\n create mode 100644 services/billing/src/queue/pg-queue.ts",
        { seconds: 0.4 },
      )
      .tool({
        name: "github__create_pull_request",
        display: GITHUB("create_pull_request", "Create pull request"),
        args: {
          owner: "acme-robotics",
          repo: "platform",
          head: "billing/pg-queue",
          base: "main",
          title: "billing: move worker to Postgres job queue",
          body: "Replaces the Redis queue with a SKIP LOCKED Postgres queue. Fixes the payout idempotency key.",
        },
        output: mcpJson({
          number: 1294,
          url: "https://github.com/acme-robotics/platform/pull/1294",
          state: "open",
          draft: false,
        }),
      })
      .answer(
        "Opened [acme-robotics/platform#1294](https://github.com/acme-robotics/platform/pull/1294). CODEOWNERS requested review from **@acme-robotics/billing**.",
      );

    b.user("Thanks. Write the rollout checklist.", { after: 90 }).answer(
      [
        "**Rollout checklist for #1294**",
        "",
        "- [ ] Apply the `jobs` table migration (additive, safe while Redis is live)",
        "- [ ] Deploy with `BILLING_QUEUE=redis` (no behavior change)",
        "- [ ] Drain Redis: stop enqueueing, wait for `bull_waiting == 0`",
        "- [ ] Flip `BILLING_QUEUE=postgres` on one canary pod for 15 minutes",
        "- [ ] Watch `billing_queue_depth` and payout errors on the dashboard",
        "- [ ] Roll out to all pods (not on a Friday after 14:00)",
        "- [ ] Remove the Redis queue code in a follow-up PR after 7 days",
      ].join("\n"),
    );
  },
};

const checkoutLatency: RichSessionSeed = {
  title: "Why is p95 latency up on /checkout?",
  hoursAgo: 26,
  unread: true,
  folder: "Investigations",
  script: (b, ctx) => {
    const chart = ctx.artifacts.latencyChart;
    b.user(
      "p95 on POST /checkout went from ~280 ms to ~520 ms since Thursday (screenshot of the dashboard attached). Find out why.",
      {
        startup: [
          ["sandbox", 1800],
          ["tools", 520],
          ["provider_first_byte", 1320],
        ],
        resources: chart?.kind === "file" ? [{ kind: "file", fileId: chart.id }] : [],
      },
    )
      .think(
        "Thursday is when api v2026.09.24 shipped and also when the Postgres minor upgrade ran. I'll split the latency by version first; if it is version-independent, it is the database.",
      )
      .tool({
        name: "datadog__query_metrics",
        display: DATADOG("query_metrics", "Query metrics"),
        args: {
          query:
            "p95:trace.http.request.duration{service:checkout-api,resource_name:post_/checkout} by {version}",
          from: "now-7d",
          to: "now",
        },
        output: mcpJson({
          series: [
            { version: "2026.09.19", p95_ms: { before: 276, after: 531 } },
            { version: "2026.09.24", p95_ms: { before: null, after: 518 } },
          ],
          note: "Regression starts 2026-09-25 03:10 UTC on both versions.",
        }),
      })
      .say(
        "Both app versions regressed at the same minute (03:10 UTC Thursday), which is the database maintenance window, so this is not the deploy.",
      )
      .exec(
        'psql "$DATABASE_URL" -c "select left(query, 60) as query, calls, round(mean_exec_time::numeric, 1) as mean_ms from pg_stat_statements order by mean_exec_time desc limit 5"',
        [
          "                            query                             | calls  | mean_ms",
          "--------------------------------------------------------------+--------+---------",
          " select * from cart_items where cart_id = $1 and deleted_at i | 418223 |   188.4",
          " update inventory set reserved = reserved + $1 where sku = $2 |  98331 |    21.7",
          " insert into orders (id, customer_id, total, currency) values |  97120 |     3.1",
          " select price, currency from prices where sku = any($1)       | 402918 |     2.4",
          " select id from carts where customer_id = $1 order by updated |  97002 |     1.9",
          "(5 rows)",
        ].join("\n"),
        { seconds: 0.31 },
      )
      .exec(
        'psql "$DATABASE_URL" -c "explain (analyze, buffers) select * from cart_items where cart_id = \'9c1e\' and deleted_at is null"',
        [
          "                                   QUERY PLAN",
          "--------------------------------------------------------------------------------",
          " Seq Scan on cart_items  (cost=0.00..48211.20 rows=3 width=112) (actual time=0.041..181.902 rows=4 loops=1)",
          "   Filter: ((deleted_at IS NULL) AND (cart_id = '9c1e'::uuid))",
          "   Rows Removed by Filter: 2104511",
          "   Buffers: shared hit=21880",
          " Planning Time: 0.118 ms",
          " Execution Time: 181.941 ms",
        ].join("\n"),
        { seconds: 0.2 },
      )
      .search(
        "postgres minor upgrade partial index not used after reindex concurrently invalid index",
        [
          {
            title: "REINDEX CONCURRENTLY can leave an invalid index behind",
            domain: "postgresql.org",
            snippet:
              "If the operation fails, the new index is left in an invalid state and is ignored by queries.",
            url: "https://www.postgresql.org/docs/current/sql-reindex.html",
          },
          {
            title: "Finding invalid indexes",
            domain: "wiki.postgresql.org",
            snippet: "select indexrelid::regclass from pg_index where not indisvalid;",
            url: "https://wiki.postgresql.org/wiki/Index_Maintenance",
          },
        ],
      )
      .exec(
        'psql "$DATABASE_URL" -c "select indexrelid::regclass as index, indisvalid from pg_index where not indisvalid"',
        "             index             | indisvalid\n-------------------------------+------------\n cart_items_cart_id_live_idx   | f\n(1 row)",
        { seconds: 0.05 },
      )
      .answer(
        [
          "**Root cause:** the partial index `cart_items_cart_id_live_idx` is **invalid** since the maintenance window on Thursday 03:10 UTC. A `REINDEX CONCURRENTLY` was interrupted, so Postgres ignores the index and scans 2.1 M rows for every cart lookup (181 ms per call, 4 calls per checkout).",
          "",
          "| | Before | Now |",
          "| --- | ---: | ---: |",
          "| `cart_items` lookup | 0.3 ms (index scan) | 181.9 ms (seq scan) |",
          "| POST /checkout p95 | 276 ms | 531 ms |",
          "",
          "Fix (safe to run during traffic):",
          "",
          "```sql",
          "drop index concurrently cart_items_cart_id_live_idx;",
          "create index concurrently cart_items_cart_id_live_idx",
          "  on cart_items (cart_id) where deleted_at is null;",
          "```",
          "",
          "```opengeni-html",
          '<div style="font:13px system-ui;padding:12px 16px">',
          '<div style="font-weight:600;margin-bottom:10px">POST /checkout p95 (ms), last 7 days</div>',
          '<div style="display:flex;align-items:flex-end;gap:10px;height:170px">',
          ...[
            ["Mon", 271],
            ["Tue", 279],
            ["Wed", 276],
            ["Thu", 498],
            ["Fri", 527],
            ["Sat", 512],
            ["Sun", 531],
          ].map(
            ([day, value]) =>
              `<div style="flex:1;text-align:center"><div style="height:${Math.round((Number(value) / 560) * 140)}px;background:${Number(value) > 400 ? "#e5484d" : "#12a594"};border-radius:4px 4px 0 0"></div><div style="margin-top:4px;opacity:.7">${day}</div><div style="font-size:11px">${value}</div></div>`,
          ),
          "</div></div>",
          "```",
          "",
          "I also suggest a check in the nightly job for `not indisvalid` so this alerts next time.",
        ].join("\n"),
      );
  },
};

const mergeStateSplit: RichSessionSeed = {
  title: "Merge the Terraform state split PR",
  hoursAgo: 0.15,
  unread: true,
  script: (b) => {
    b.user(
      "The Terraform state split PR (#1287) has two approvals and CI is green. Merge it and start the plan for the network stack.",
    )
      .tool({
        name: "github__get_pull_request",
        display: GITHUB("get_pull_request", "Get pull request"),
        args: { owner: "acme-robotics", repo: "infrastructure", pullNumber: 1287 },
        output: mcpJson({
          number: 1287,
          title: "terraform: split network and compute state",
          state: "open",
          mergeable: true,
          reviews: [
            { user: "maria-chen", state: "APPROVED" },
            { user: "jberg", state: "APPROVED" },
          ],
          checks: { total: 14, passed: 14, failed: 0 },
          changedFiles: 23,
        }),
      })
      .say(
        "All 14 checks passed and Maria and Jonas approved. Merging changes production infrastructure state, so it needs your approval.",
      )
      .approval({
        name: "github__merge_pull_request",
        display: GITHUB("merge_pull_request", "Merge pull request"),
        args: {
          owner: "acme-robotics",
          repo: "infrastructure",
          pullNumber: 1287,
          mergeMethod: "squash",
          commitTitle: "terraform: split network and compute state (#1287)",
        },
      });
  },
};

const edgeCacheRegion: RichSessionSeed = {
  title: "Pick a region for the telemetry edge cache",
  hoursAgo: 0.6,
  unread: true,
  script: (b) => {
    b.user(
      "Set up an edge cache in front of the robot telemetry dashboard. Pick whatever region makes sense.",
    )
      .think(
        "Most dashboard traffic comes from the two factories and the Oslo office. I'll measure latency from each site to the candidate regions before choosing, since cost and latency pull in different directions here.",
      )
      .exec(
        "for r in eu-north-1 eu-central-1 eu-west-1; do printf '%s ' $r; curl -so /dev/null -w '%{time_connect}\\n' https://ec2.$r.amazonaws.com; done",
        "eu-north-1 0.011\neu-central-1 0.024\neu-west-1 0.038",
        { seconds: 1.2 },
      )
      .tool({
        name: "aws__get_cost_estimate",
        display: {
          toolName: "get_cost_estimate",
          title: "Get cost estimate",
          accountLabel: "AWS · production",
        },
        args: {
          service: "CloudFront + ElastiCache",
          regions: ["eu-north-1", "eu-central-1"],
          monthlyGb: 4200,
        },
        output: mcpJson({
          "eu-north-1": { monthlyUsd: 612, egressUsdPerGb: 0.09 },
          "eu-central-1": { monthlyUsd: 548, egressUsdPerGb: 0.08 },
        }),
      })
      .say(
        "Stockholm is fastest from all three sites; Frankfurt is about 10% cheaper. That trade-off is yours to make, so I'm asking before creating anything.",
      )
      .ask(
        [
          {
            id: "region",
            kind: "single_select",
            label: "Region",
            prompt: "Which region should host the edge cache?",
            options: [
              {
                id: "eu-north-1",
                label: "eu-north-1 (Stockholm)",
                description: "11 ms from Oslo, $612/month",
              },
              {
                id: "eu-central-1",
                label: "eu-central-1 (Frankfurt)",
                description: "24 ms from Oslo, $548/month",
              },
              {
                id: "both",
                label: "Both, with latency routing",
                description: "Best latency and failover, about $1,160/month",
              },
            ],
          },
          {
            id: "ttl",
            kind: "single_select",
            label: "Tile TTL",
            prompt: "How fresh do telemetry tiles need to be?",
            options: [
              { id: "30s", label: "30 seconds" },
              { id: "2m", label: "2 minutes" },
              { id: "10m", label: "10 minutes" },
            ],
          },
          {
            id: "notes",
            kind: "text",
            label: "Notes",
            prompt: "Anything else I should know before I create it?",
            required: false,
          },
        ] satisfies HumanInputQuestion[],
        { allowSkip: true },
      );
  },
};

const previewDeployFailed: RichSessionSeed = {
  title: "Deploy preview for PR #1290",
  hoursAgo: 9,
  script: (b) => {
    b.user("Deploy a preview environment for PR #1290 so design can review the new dashboard.", {
      startup: [
        ["sandbox", 2600],
        ["tools", 610],
        ["provider_first_byte", 1040],
      ],
    })
      .exec(
        "helm upgrade --install preview-1290 ./charts/web --namespace previews --set image.tag=pr-1290 --wait --timeout 3m",
        [
          'Release "preview-1290" does not exist. Installing it now.',
          "Error: INSTALLATION FAILED: context deadline exceeded",
        ].join("\n"),
        { code: 1, seconds: 180.4 },
      )
      .exec(
        "kubectl -n previews describe pod -l app.kubernetes.io/instance=preview-1290 | tail -8",
        [
          "Events:",
          "  Type     Reason     Age                  From               Message",
          "  ----     ------     ----                 ----               -------",
          "  Normal   Scheduled  3m1s                 default-scheduler  Successfully assigned previews/preview-1290-web-7d9f to node-17",
          '  Normal   Pulling    94s (x4 over 3m)     kubelet            Pulling image "ghcr.io/acme-robotics/web:pr-1290"',
          "  Warning  Failed     93s (x4 over 3m)     kubelet            Failed to pull image: not found",
          "  Warning  Failed     93s (x4 over 3m)     kubelet            Error: ImagePullBackOff",
        ].join("\n"),
        { seconds: 0.9 },
      )
      .say(
        "The image `web:pr-1290` does not exist. The build workflow for the PR was skipped because the branch only touched `docs/`, so nothing was pushed.",
      )
      .fail(
        "Preview deploy failed: image ghcr.io/acme-robotics/web:pr-1290 was not found (ImagePullBackOff). The PR's build job did not push an image.",
      );
  },
};

const authRefactorRunning: RichSessionSeed = {
  title: "Refactor auth middleware to session handles",
  hoursAgo: 0.04,
  script: (b) => {
    b.user(
      "Refactor the API auth middleware to use the new session handles instead of raw JWT cookies. Keep the public behavior identical and run the auth tests.",
      {
        startup: [
          ["sandbox", 2200],
          ["tools", 580],
          ["provider_first_byte", 870],
        ],
      },
    )
      .think(
        "The middleware reads `og_token` and verifies it inline. The new `sessionApi.resolve()` returns a handle with the user and expiry. I'll swap the verification, keep the redirect and 401 behavior, and let the existing tests prove nothing changed.",
      )
      .exec(
        'rg -n "verifyToken|og_token" apps/api/src',
        'apps/api/src/auth/middleware.ts:14:  const raw = req.cookies.get("og_token");\napps/api/src/auth/middleware.ts:16:  const user = verifyToken(raw);\napps/api/src/auth/refresh.ts:22:  const user = verifyToken(token);',
        { seconds: 0.06 },
      )
      .patch([
        {
          type: "update_file",
          path: "apps/api/src/auth/middleware.ts",
          diff: [
            "@@ -12,8 +12,10 @@ export function withSession(req: Request, next: Next) {",
            '   const raw = req.cookies.get("og_token");',
            '   if (!raw) return redirect("/login");',
            "-  const user = verifyToken(raw);",
            "-  if (!user) return unauthorized();",
            "+  const handle = sessionApi.resolve(raw);",
            "+  if (!handle.valid) return unauthorized();",
            "+  if (handle.expiresSoon) handle.refresh();",
            "+  const user = handle.user;",
            "   return next({ ...req, user });",
            " }",
          ].join("\n"),
        },
      ])
      .say("Middleware updated. Running the auth test suite now.")
      .exec("bun test apps/api/test/auth", "", { running: true })
      .hold();
  },
};

const iamAudit: RichSessionSeed = {
  title: "Audit IAM roles across AWS accounts",
  hoursAgo: 30,
  goal: {
    text: "List unused and over-privileged IAM roles in prod, staging and sandbox.",
    status: "completed",
    evidence: "3 of 3 account audits returned; 17 unused roles and 4 admin roles flagged.",
  },
  children: [
    {
      key: "prod",
      title: "IAM audit: production",
      script: (b) =>
        b
          .user(
            "Audit IAM roles in the production account (000000000001). Flag roles unused for 90+ days and any with AdministratorAccess.",
          )
          .exec(
            "aws iam generate-credential-report >/dev/null && aws iam list-roles --query 'Roles[].RoleName' --output text | wc -w",
            "84",
            { seconds: 2.1 },
          )
          .exec(
            "aws iam list-roles --query \"Roles[?RoleLastUsed.LastUsedDate<'2026-07-01'].RoleName\" --output table",
            "--------------------------------\n|          ListRoles           |\n+------------------------------+\n|  legacy-deploy-2023          |\n|  datadog-integration-old     |\n|  temp-migration-role         |\n|  ci-runner-v1                |\n|  lambda-image-resize         |\n+------------------------------+",
            { seconds: 1.4 },
          )
          .answer(
            "Production: **84 roles**, 5 unused for 90+ days (`legacy-deploy-2023`, `datadog-integration-old`, `temp-migration-role`, `ci-runner-v1`, `lambda-image-resize`). 1 role has AdministratorAccess: `break-glass-admin` (expected, MFA enforced).",
          ),
    },
    {
      key: "staging",
      title: "IAM audit: staging",
      script: (b) =>
        b
          .user(
            "Audit IAM roles in the staging account (000000000002). Same criteria as production.",
          )
          .exec("aws iam list-roles --query 'Roles[].RoleName' --output text | wc -w", "61", {
            seconds: 1.8,
          })
          .answer(
            "Staging: **61 roles**, 7 unused for 90+ days. 2 roles have AdministratorAccess without an MFA condition: `staging-admin` and `terraform-staging`. Recommend scoping `terraform-staging` to the state bucket and the VPC module.",
          ),
    },
    {
      key: "sandbox",
      title: "IAM audit: sandbox",
      script: (b) =>
        b
          .user(
            "Audit IAM roles in the sandbox account (000000000003). Same criteria as production.",
          )
          .exec("aws iam list-roles --query 'Roles[].RoleName' --output text | wc -w", "39", {
            seconds: 1.3,
          })
          .answer(
            "Sandbox: **39 roles**, 5 unused for 90+ days. 1 role has AdministratorAccess: `hackathon-2025-admin`, created for last year's hackathon and never removed.",
          ),
    },
  ],
  script: (b, ctx) => {
    b.user(
      "Audit IAM roles across our three AWS accounts (prod, staging, sandbox). Flag roles unused for 90 days and anything with admin access.",
    )
      .goal("goal.set", "List unused and over-privileged IAM roles in prod, staging and sandbox.")
      .think(
        "The three accounts are independent and each audit takes a few minutes of API calls, so I'll run them as parallel sub-agents with the same criteria and merge the results.",
      )
      .say("Starting three audits in parallel, one per account.")
      .spawn(
        ctx.children.prod!,
        "Audit IAM roles in the production account (000000000001). Flag roles unused for 90+ days and any with AdministratorAccess.",
        "IAM audit: production",
      )
      .spawn(
        ctx.children.staging!,
        "Audit IAM roles in the staging account (000000000002). Same criteria as production.",
        "IAM audit: staging",
      )
      .spawn(
        ctx.children.sandbox!,
        "Audit IAM roles in the sandbox account (000000000003). Same criteria as production.",
        "IAM audit: sandbox",
      )
      .childResult(ctx.children.staging!, "Staging: 61 roles, 7 unused, 2 admin roles without MFA.")
      .childResult(
        ctx.children.sandbox!,
        "Sandbox: 39 roles, 5 unused, 1 leftover hackathon admin role.",
      )
      .childResult(
        ctx.children.prod!,
        "Production: 84 roles, 5 unused, 1 expected break-glass admin role.",
      )
      .answer(
        [
          "All three audits are back.",
          "",
          "| Account | Roles | Unused 90+ days | Admin access | Action |",
          "| --- | ---: | ---: | --- | --- |",
          "| production | 84 | 5 | `break-glass-admin` (MFA) | Remove the 5 unused roles |",
          "| staging | 61 | 7 | `staging-admin`, `terraform-staging` (no MFA) | Add MFA condition, scope Terraform role |",
          "| sandbox | 39 | 5 | `hackathon-2025-admin` | Delete the role |",
          "",
          "**17 unused roles** in total. Nothing was changed; say the word and I will open one Terraform PR per account.",
        ].join("\n"),
      );
  },
};

const vendorContract: RichSessionSeed = {
  title: "Summarize the vendor contract",
  hoursAgo: 50,
  folder: "Planning",
  script: (b, ctx) => {
    const resources = [ctx.artifacts.contract, ctx.artifacts.pricing]
      .filter((ref): ref is ArtifactRef => ref?.kind === "file")
      .map((ref) => ({ kind: "file", fileId: ref.id }));
    b.user(
      "Here is the renewal contract from our telemetry storage vendor and their price sheet. What changed from last year, and is there anything I should push back on?",
      { resources },
    )
      .exec(
        "pdftotext -layout contract.pdf - | grep -n -i -E 'term|renew|liabil|price|notice' | head -12",
        [
          "14:  2.1 Term. This Agreement renews automatically for successive 24-month terms",
          "15:      unless either party gives written notice at least 90 days before renewal.",
          "41:  5.3 Price changes. Vendor may adjust prices once per term by up to 9%.",
          "62:  8.2 Liability. Vendor's aggregate liability is limited to fees paid in the",
          "63:      preceding 3 months.",
          "77:  11.4 Data export. Export at termination is available for 30 days at list price.",
        ].join("\n"),
        { seconds: 0.4 },
      )
      .answer(
        [
          "Four changes from last year's contract, two of which I would push back on:",
          "",
          "| Clause | Last year | This year | Push back? |",
          "| --- | --- | --- | --- |",
          "| Renewal term | 12 months | **24 months**, auto-renew | Yes: keep 12 months |",
          "| Notice period | 60 days | 90 days | Minor |",
          "| Price increase | Capped at 5% | Up to **9%** per term | Yes: cap at 5% |",
          "| Liability cap | 12 months of fees | **3 months** of fees | Yes, if storage is critical |",
          "| Data export | Free for 60 days | 30 days at list price | Ask for free export |",
          "",
          "The price sheet itself is 4% lower per TB, so the headline looks better while the terms got worse.",
        ].join("\n"),
      );
  },
};

const postmortem: RichSessionSeed = {
  title: "Postmortem: INC-2291 checkout outage",
  hoursAgo: 72,
  folder: "Incidents",
  script: (b, ctx) => {
    b.user("Write the postmortem for INC-2291, the checkout outage on Tuesday.", {
      startup: [
        ["sandbox", 1900],
        ["tools", 690],
        ["provider_first_byte", 1110],
      ],
    })
      .tool({
        name: "pagerduty__get_incident",
        display: PAGERDUTY("get_incident", "Get incident"),
        args: { incidentId: "INC-2291" },
        output: mcpJson({
          id: "INC-2291",
          title: "Checkout error rate above 5%",
          triggeredAt: "2026-09-22T09:12:00Z",
          acknowledgedAt: "2026-09-22T09:15:00Z",
          resolvedAt: "2026-09-22T09:34:00Z",
          responders: ["Maria Chen", "Jonas Berg", "Bendik Hansen"],
        }),
      })
      .tool({
        name: "datadog__query_metrics",
        display: DATADOG("query_metrics", "Query metrics"),
        args: {
          query: "sum:checkout.requests.errors{env:prod}.as_rate()",
          from: "2026-09-22T08:45:00Z",
          to: "2026-09-22T10:00:00Z",
        },
        output: mcpJson({ peakErrorRate: 0.118, failedCheckouts: 1432, durationMinutes: 22 }),
      })
      .ask(
        [
          {
            id: "commander",
            kind: "single_select",
            label: "Incident commander",
            prompt: "Who should be listed as incident commander?",
            options: [
              { id: "maria", label: "Maria Chen" },
              { id: "jonas", label: "Jonas Berg" },
              { id: "bendik", label: "Bendik Hansen" },
            ],
          },
          {
            id: "impact",
            kind: "single_select",
            label: "Customer impact",
            prompt: "Include the number of failed checkouts in the public summary?",
            options: [
              { id: "yes", label: "Yes, include the number" },
              { id: "no", label: "No, keep it internal" },
            ],
          },
        ],
        {
          answer: [
            { questionId: "commander", values: ["maria"] },
            { questionId: "impact", values: ["no"] },
          ],
          after: 95,
        },
      )
      .say(
        "Maria is incident commander and the failed-checkout count stays internal. Writing the document now.",
      )
      .exec(
        "python3 charts/error_rate.py --incident INC-2291 --out charts/inc-2291-error-rate.png",
        "Wrote charts/inc-2291-error-rate.png (960x540, 12 points)",
        { seconds: 2.2 },
      );
    publish(b, ctx, "errorRateChart", "/workspace/charts/inc-2291-error-rate.png");
    b.answer(
      [
        `The postmortem is ready: ${link("INC-2291 postmortem", ctx.artifacts.postmortemDoc)}.`,
        "",
        image("INC-2291 checkout error rate", ctx.artifacts.errorRateChart),
        "",
        "**Summary:** a cache node restart during a routine patch caused a cold cache; checkout requests fell through to Postgres and 11.8% of them failed for 22 minutes.",
        "",
        "| Time (UTC) | Event |",
        "| --- | --- |",
        "| 09:12 | Error rate alert fires |",
        "| 09:15 | Maria acknowledges, starts incident |",
        "| 09:21 | Cache node restart identified as trigger |",
        "| 09:29 | Cache warmed from replica |",
        "| 09:34 | Error rate back under 0.1%, resolved |",
        "",
        "Action items are tracked in PLAT-340 and PLAT-366.",
      ].join("\n"),
    );
  },
};

const featureFlagCleanup: RichSessionSeed = {
  title: "Clean up stale feature flags",
  hoursAgo: 120,
  script: (b) => {
    b.user(
      "Find feature flags that have been 100% on for more than 60 days and remove them from the code.",
    )
      .exec(
        "flagctl list --state fully-enabled --older-than 60d --format table",
        [
          "FLAG                         ENABLED SINCE   REFERENCES",
          "new-checkout-summary         2026-05-02      7",
          "fast-image-resize            2026-06-11      3",
          "robot-firmware-ota-v2        2026-04-19      12",
          "billing-invoice-pdf-v3       2026-07-01      4",
        ].join("\n"),
        { seconds: 0.7 },
      )
      .say(
        "Four flags qualify. Removing `new-checkout-summary` first since it has the most straightforward references.",
      )
      .exec('rg -l "new-checkout-summary" apps packages', "", { running: true })
      .cancel();
    b.user("Stop, only list them for now. Don't remove anything yet.", { after: 20 }).answer(
      [
        "Understood, nothing was changed. Flags fully enabled for more than 60 days:",
        "",
        "| Flag | Enabled since | Code references | Owner |",
        "| --- | --- | ---: | --- |",
        "| `robot-firmware-ota-v2` | 2026-04-19 | 12 | Firmware |",
        "| `new-checkout-summary` | 2026-05-02 | 7 | Checkout |",
        "| `fast-image-resize` | 2026-06-11 | 3 | Platform |",
        "| `billing-invoice-pdf-v3` | 2026-07-01 | 4 | Billing |",
      ].join("\n"),
    );
  },
};

const weeklyNotes: RichSessionSeed = {
  title: "Draft my weekly update",
  hoursAgo: 170,
  folder: "Planning",
  script: (b) => {
    b.user("Draft my weekly update for the platform channel from what I worked on this week.")
      .tool({
        name: "github__search_pull_requests",
        display: GITHUB("search_pull_requests", "Search pull requests"),
        args: { query: "author:bendik-acme is:merged merged:>=2026-09-15" },
        output: mcpJson({
          total: 4,
          items: [
            { number: 1271, title: "ci: wait for payment mock readiness" },
            { number: 1268, title: "terraform: tag all EC2 instances with owner" },
            { number: 1262, title: "billing: fix payout retry key" },
            { number: 1259, title: "docs: on-call handbook v2" },
          ],
        }),
      })
      .answer(
        [
          "**Weekly update, week 38**",
          "",
          "*Shipped*",
          "- Checkout CI is stable again: the payment mock readiness wait (#1271) took flaky runs from 1 in 5 to 0 in 25.",
          "- Every EC2 instance now carries an `owner` tag (#1268), so cost reports can group by team.",
          "- Fixed a payout retry key that could double-pay on worker crashes (#1262).",
          "- On-call handbook v2 is live (#1259).",
          "",
          "*Next week*",
          "- Start the Q4 reliability sprint (webhook consumer alerting first).",
          "- Postgres 17 replica for the upgrade dry run.",
        ].join("\n"),
      );
  },
};

const fleetDashboard: RichSessionSeed = {
  title: "Build a fleet health dashboard",
  hoursAgo: 28,
  pinned: true,
  folder: "Investigations",
  script: (b, ctx) => {
    const site = ctx.artifacts.fleetSite;
    b.user(
      "Make me a small dashboard page for robot fleet health: uptime per site, firmware versions, and the robots that need attention. Fake numbers are fine for now.",
      {
        startup: [
          ["sandbox", 2400],
          ["tools", 800],
          ["provider_first_byte", 990],
        ],
      },
    )
      .think(
        "A self-contained Site is the right fit: static HTML with inline SVG charts, so it renders anywhere without a backend. Three sections: KPI tiles, uptime per factory, and an attention table.",
      )
      .exec("mkdir -p site && wc -c site/index.html", "18422 site/index.html", { seconds: 0.05 });
    if (site?.kind === "site") {
      b.publishSite({
        id: site.id,
        workspaceId: ctx.workspaceId,
        title: site.title,
        revision: site.revision,
        description: "Uptime, firmware spread and robots needing attention.",
      });
    }
    b.answer(
      [
        `Published ${link("Fleet health", site)}. It has KPI tiles, uptime per factory, the firmware spread and the robots that need attention.`,
        "",
        ...(site ? ["```opengeni-site", JSON.stringify({ siteId: site.id }), "```", ""] : []),
        "Next step would be wiring it to the telemetry API instead of the sample numbers.",
      ].join("\n"),
    );
  },
};

export const PERSONAL_RICH_SESSIONS: RichSessionSeed[] = [
  billingQueueMigration,
  checkoutLatency,
  mergeStateSplit,
  edgeCacheRegion,
  previewDeployFailed,
  authRefactorRunning,
  iamAudit,
  vendorContract,
  featureFlagCleanup,
  weeklyNotes,
  fleetDashboard,
];

// ---------------------------------------------------------------------------
// Shared workspaces
// ---------------------------------------------------------------------------

const k8sUpgrade: RichSessionSeed = {
  title: "Upgrade Kubernetes to 1.31 in staging",
  hoursAgo: 0.1,
  unread: true,
  script: (b) => {
    b.user(
      "Upgrade the staging EKS cluster from 1.30 to 1.31. Check for deprecated APIs first and tell me what breaks.",
      {
        startup: [
          ["sandbox", 2900],
          ["tools", 720],
          ["provider_first_byte", 1060],
        ],
      },
    )
      .search("Kubernetes 1.31 deprecated API removals", [
        {
          title: "Kubernetes v1.31 deprecation and removal notes",
          domain: "kubernetes.io",
          snippet:
            "flowcontrol.apiserver.k8s.io/v1beta3 is removed; migrate to v1. In-tree cloud providers are removed.",
          url: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/",
        },
        {
          title: "Amazon EKS Kubernetes 1.31 release notes",
          domain: "docs.aws.amazon.com",
          snippet:
            "AL2 AMIs reach end of standard support; the kubelet --keep-terminated-pod-volumes flag is removed.",
          url: "https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html",
        },
      ])
      .exec(
        "pluto detect-helm --target-versions k8s=v1.31.0 -o wide",
        [
          "NAME                     NAMESPACE     KIND                      VERSION                          REPLACEMENT              REMOVED   DEPRECATED",
          "ingress-nginx/controller ingress       FlowSchema                flowcontrol.apiserver.k8s.io/v1beta3  flowcontrol.apiserver.k8s.io/v1   true      true",
          "keda/keda-operator       keda          PriorityLevelConfiguration flowcontrol.apiserver.k8s.io/v1beta3  flowcontrol.apiserver.k8s.io/v1   true      true",
        ].join("\n"),
        { seconds: 3.2 },
      )
      .say(
        "Two Helm releases still ship `flowcontrol/v1beta3` objects. Both have fixed chart versions, so I'll bump them before touching the control plane.",
      )
      .patch([
        {
          type: "update_file",
          path: "deploy/staging/helmfile.yaml",
          diff: [
            "@@ -18,11 +18,11 @@ releases:",
            "   - name: ingress-nginx",
            "     namespace: ingress",
            "     chart: ingress-nginx/ingress-nginx",
            "-    version: 4.9.1",
            "+    version: 4.11.3",
            "   - name: keda",
            "     namespace: keda",
            "     chart: kedacore/keda",
            "-    version: 2.13.2",
            "+    version: 2.15.1",
          ].join("\n"),
        },
        {
          type: "update_file",
          path: "infra/eks/staging/main.tf",
          diff: [
            '@@ -3,7 +3,7 @@ module "eks" {',
            '   source          = "terraform-aws-modules/eks/aws"',
            '   version         = "20.24.0"',
            '   cluster_name    = "staging"',
            '-  cluster_version = "1.30"',
            '+  cluster_version = "1.31"',
          ].join("\n"),
        },
      ])
      .exec(
        "terraform -chdir=infra/eks/staging plan -no-color | tail -6",
        [
          "  # module.eks.aws_eks_cluster.this[0] will be updated in-place",
          '  ~ version = "1.30" -> "1.31"',
          "",
          '  # module.eks.module.eks_managed_node_group["default"].aws_eks_node_group.this[0] will be updated in-place',
          "",
          "Plan: 0 to add, 2 to change, 0 to destroy.",
        ].join("\n"),
        { seconds: 14.8 },
      )
      .answer(
        [
          "Ready to upgrade. Nothing is applied yet (workspace rule: plan only).",
          "",
          "| Check | Result |",
          "| --- | --- |",
          "| Removed APIs in use | 2, both fixed by chart bumps |",
          "| `ingress-nginx` | 4.9.1 → 4.11.3 |",
          "| `keda` | 2.13.2 → 2.15.1 |",
          "| Terraform plan | 0 add, 2 change, 0 destroy |",
          "| Node AMI | AL2023 already, no change needed |",
          "",
          "Suggested order: apply the Helm bumps, wait 30 minutes, then apply the Terraform plan during the Tuesday window.",
        ].join("\n"),
      );
  },
};

const diskPressure: RichSessionSeed = {
  title: "Triage disk pressure alert on db-2",
  hoursAgo: 1.2,
  goal: {
    text: "Bring db-2 disk usage under 70% without downtime.",
    status: "paused",
    pausedReason: "Waiting for the finance team to approve a larger volume (gp3, 2 TB).",
  },
  script: (b) => {
    b.user(
      "PagerDuty says db-2 is at 91% disk. Figure out what's eating the space and fix it without downtime.",
    )
      .tool({
        name: "pagerduty__acknowledge_incident",
        display: PAGERDUTY("acknowledge_incident", "Acknowledge incident"),
        args: { incidentId: "INC-2317" },
        output: mcpJson({
          id: "INC-2317",
          status: "acknowledged",
          acknowledgedBy: "OpenGeni on behalf of Bendik Hansen",
        }),
      })
      .exec(
        "ssh db-2 'df -h /var/lib/postgresql && sudo du -sh /var/lib/postgresql/16/main/{base,pg_wal}'",
        "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme1n1    1.0T  911G   89G  91% /var/lib/postgresql\n742G\t/var/lib/postgresql/16/main/base\n164G\t/var/lib/postgresql/16/main/pg_wal",
        { seconds: 2.6 },
      )
      .exec(
        'psql -h db-2 -c "select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained from pg_replication_slots"',
        "   slot_name    | active | retained\n----------------+--------+----------\n analytics_cdc  | f      | 158 GB\n replica_db3    | t      | 212 MB\n(2 rows)",
        { seconds: 0.2 },
      )
      .say(
        "An inactive replication slot (`analytics_cdc`) is holding 158 GB of WAL. The analytics CDC connector has been down since Sunday.",
      )
      .goal("goal.paused", "Bring db-2 disk usage under 70% without downtime.", {
        reason: "Waiting for the finance team to approve a larger volume (gp3, 2 TB).",
      })
      .answer(
        [
          "**Cause:** the `analytics_cdc` replication slot is inactive and retains **158 GB of WAL**. The CDC connector crashed on Sunday and never reconnected.",
          "",
          "Two options:",
          "",
          "1. Restart the connector so it consumes the WAL (disk drops to ~75% within an hour).",
          "2. Drop the slot and re-snapshot analytics (disk drops to ~75% immediately, analytics is stale for ~6 hours).",
          "",
          "Either way we are at 75%, not under 70%. I paused the goal until finance approves the 2 TB volume.",
        ].join("\n"),
      );
  },
};

const slackReconnect: RichSessionSeed = {
  title: "Post on-call handover to Slack",
  hoursAgo: 7,
  script: (b) => {
    b.user("Post this week's on-call handover to #platform-oncall.")
      .tool({
        name: "pagerduty__list_incidents",
        display: PAGERDUTY("list_incidents", "List incidents"),
        args: { since: "2026-09-22", until: "2026-09-29", team: "platform" },
        output: mcpJson({ total: 3, incidents: ["INC-2291", "INC-2304", "INC-2317"] }),
      })
      .tool({
        name: "slack__post_message",
        display: {
          toolName: "post_message",
          title: "Post message",
          accountLabel: "Slack · acme-robotics",
        },
        args: { channel: "#platform-oncall", text: "On-call handover, week 39: 3 incidents…" },
        output: mcpText(
          "The Slack connection needs to be reconnected: refresh token was revoked.",
          true,
        ),
        error: true,
      })
      .answer(
        [
          "I couldn't post: the Slack connection's refresh token was revoked, so it needs to be reconnected under **Capabilities → Slack**.",
          "",
          "Here is the handover so you can paste it:",
          "",
          "> **On-call handover, week 39**",
          "> - INC-2291 checkout outage (22 min), postmortem done",
          "> - INC-2304 webhook delays (1 h), consumer restarted, alerting in PLAT-366",
          "> - INC-2317 db-2 disk pressure, CDC slot retaining WAL, volume increase pending",
        ].join("\n"),
      );
  },
};

const escalationReview: RichSessionSeed = {
  title: "Weekly escalation review",
  hoursAgo: 4,
  unread: true,
  script: (b) => {
    b.user("Pull this week's escalated tickets and group them by root cause.")
      .tool({
        name: "zendesk__search_tickets",
        display: {
          toolName: "search_tickets",
          title: "Search tickets",
          accountLabel: "Zendesk · acme-robotics",
        },
        args: { query: "tags:escalated created>2026-09-22", sort: "priority" },
        output: mcpJson({
          count: 9,
          tickets: [
            {
              id: 88121,
              subject: "Robot arm stops mid-cycle after firmware 4.2",
              priority: "urgent",
            },
            { id: 88107, subject: "Cannot pair app on Pixel 8", priority: "high" },
            { id: 88093, subject: "Invoice shows wrong VAT", priority: "normal" },
          ],
        }),
      })
      .tool({
        name: "hubspot__get_companies",
        display: {
          toolName: "get_companies",
          title: "Get companies",
          accountLabel: "HubSpot · Acme",
        },
        args: { ticketIds: [88121, 88107, 88093] },
        output: mcpJson({
          companies: [
            { name: "Contoso Packaging AS", arr: 184000 },
            { name: "Fjord Foods", arr: 62000 },
          ],
        }),
      })
      .answer(
        [
          "9 escalations this week, 3 root causes:",
          "",
          "| Root cause | Tickets | Biggest account | Status |",
          "| --- | ---: | --- | --- |",
          "| Firmware 4.2 stops arm mid-cycle | 5 | Contoso Packaging AS ($184k ARR) | Hotfix 4.2.1 in QA |",
          "| Android pairing (Pixel 8) | 3 | Fjord Foods ($62k ARR) | Workaround sent |",
          "| Wrong VAT on invoices | 1 | — | Fixed, credit note issued |",
          "",
          "Firmware is the one to watch: all 5 tickets came in within 48 hours of the 4.2 rollout.",
        ].join("\n"),
      );
  },
};

const spendDashboard: RichSessionSeed = {
  title: "Build the Q3 spend overview",
  hoursAgo: 6,
  script: (b, ctx) => {
    b.user("Build a Q3 spend overview by category with the month-over-month change.")
      .tool({
        name: "ledger__export_transactions",
        display: {
          toolName: "export_transactions",
          title: "Export transactions",
          accountLabel: "Ledger · Acme Robotics AS",
        },
        args: { from: "2026-07-01", to: "2026-09-30", groupBy: ["category", "month"] },
        output: mcpJson({ rows: 36, currency: "NOK" }),
      })
      .exec(
        "python3 summarize.py q3.csv",
        "category      jul       aug       sep     q3_total\ncloud      412300    438900    455100    1306300\ntravel      88200    214700     96400     399300\nsoftware   143800    143800    151200     438800\nhardware   302100    118400    276500     697000",
        { seconds: 1.1 },
      )
      .answer(
        [
          `The overview is in ${link("Q3 spend by category", ctx.artifacts.spendSheet)}.`,
          "",
          "| Category | Jul | Aug | Sep | Q3 total |",
          "| --- | ---: | ---: | ---: | ---: |",
          "| Cloud | 412 300 | 438 900 | 455 100 | 1 306 300 |",
          "| Hardware | 302 100 | 118 400 | 276 500 | 697 000 |",
          "| Software | 143 800 | 143 800 | 151 200 | 438 800 |",
          "| Travel | 88 200 | 214 700 | 96 400 | 399 300 |",
          "",
          "Cloud grows steadily (+5% per month); the August travel spike is the Hamburg trade fair.",
        ].join("\n"),
      );
  },
};

function screenshotSvg(title: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f7f8fa"/><rect width="640" height="40" fill="#e9ecf1"/><circle cx="20" cy="20" r="5" fill="#e5484d"/><circle cx="38" cy="20" r="5" fill="#f5a524"/><circle cx="56" cy="20" r="5" fill="#30a46c"/><rect x="90" y="12" width="400" height="16" rx="8" fill="#fff"/><text x="104" y="24" font-family="monospace" font-size="11" fill="#687076">${title}</text><rect x="0" y="40" width="150" height="320" fill="#fff"/><rect x="16" y="64" width="110" height="10" rx="3" fill="#d7dbdf"/><rect x="16" y="88" width="90" height="10" rx="3" fill="#d7dbdf"/><rect x="16" y="112" width="100" height="10" rx="3" fill="${accent}"/><rect x="174" y="64" width="140" height="80" rx="8" fill="#fff" stroke="#e6e8eb"/><rect x="330" y="64" width="140" height="80" rx="8" fill="#fff" stroke="#e6e8eb"/><rect x="486" y="64" width="136" height="80" rx="8" fill="#fff" stroke="#e6e8eb"/><rect x="190" y="84" width="60" height="10" rx="3" fill="${accent}"/><rect x="190" y="104" width="90" height="20" rx="4" fill="#11181c"/><rect x="346" y="84" width="60" height="10" rx="3" fill="#8e4ec6"/><rect x="346" y="104" width="70" height="20" rx="4" fill="#11181c"/><rect x="502" y="84" width="60" height="10" rx="3" fill="#f5a524"/><rect x="502" y="104" width="80" height="20" rx="4" fill="#11181c"/><rect x="174" y="160" width="448" height="180" rx="8" fill="#fff" stroke="#e6e8eb"/><polyline points="190,320 250,290 310,300 370,250 430,262 490,215 550,230 606,190" fill="none" stroke="${accent}" stroke-width="3"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const browserReview: RichSessionSeed = {
  title: "Check the new dashboard in the browser",
  hoursAgo: 3,
  unread: true,
  script: (b) => {
    b.user(
      "Open the preview of the new fleet dashboard and check it at desktop and phone width. Report anything that looks off.",
    )
      .tool({
        name: "computer_screenshot",
        args: { url: "https://preview-1288.acme.dev/fleet" },
        output: screenshotSvg("preview-1288.acme.dev/fleet", "#12a594"),
        seconds: 2.4,
      })
      .tool({
        name: "computer_click",
        args: { x: 71, y: 117, button: "left" },
        output: screenshotSvg("preview-1288.acme.dev/fleet/alerts", "#e5484d"),
        seconds: 1.8,
      })
      .say("Desktop looks right. Resizing to 390 px for the phone check.")
      .tool({
        name: "computer_keypress",
        args: { keys: ["CTRL", "SHIFT", "M"] },
        output: screenshotSvg("preview-1288.acme.dev/fleet (390px)", "#0091ff"),
        seconds: 1.5,
      })
      .answer(
        [
          "Desktop is fine. At phone width I found three issues:",
          "",
          "1. The KPI cards don't wrap; the third card is cut off at 390 px.",
          "2. The alerts badge overlaps the nav label when the count has three digits.",
          "3. Chart tooltips open off-screen on the right edge.",
          "",
          "None of these affect the desktop layout.",
        ].join("\n"),
      );
  },
};

const awsSpendBreakdown: RichSessionSeed = {
  title: "Break down September AWS spend",
  hoursAgo: 20,
  script: (b, ctx) => {
    b.user("Break down September AWS spend by service and tell me where we can save 10%.")
      .tool({
        name: "aws__get_cost_and_usage",
        display: {
          toolName: "get_cost_and_usage",
          title: "Get cost and usage",
          accountLabel: "AWS · production",
        },
        args: {
          granularity: "MONTHLY",
          groupBy: "SERVICE",
          months: ["2026-07", "2026-08", "2026-09"],
        },
        output: mcpJson({ services: 7, septemberUsd: 44170, julyUsd: 38490 }),
      })
      .exec(
        "python3 charts/aws_by_service.py --month 2026-09",
        "Wrote charts/aws-spend-by-service.png",
        {
          seconds: 1.9,
        },
      );
    publish(b, ctx, "awsChart", "/workspace/charts/aws-spend-by-service.png");
    b.answer(
      [
        `September came in at **$44.2k** (+15% since July). Details are in ${link("AWS cost by service", ctx.artifacts.awsSheet)}.`,
        "",
        image("AWS spend by service, September", ctx.artifacts.awsChart),
        "",
        "Three changes get us to about 10%:",
        "",
        "| Change | Monthly saving | Effort |",
        "| --- | ---: | --- |",
        "| Compute Savings Plan for the baseline EC2 fleet | $2,600 | Low |",
        "| Drop the inactive `analytics_cdc` slot and shrink db-2's volume | $1,100 | Low |",
        "| S3 Intelligent-Tiering on the telemetry archive bucket | $900 | Medium |",
        "",
        "Total ≈ **$4,600/month (10.4%)**.",
      ].join("\n"),
    );
  },
};

export const SHARED_RICH_SESSIONS: Record<string, RichSessionSeed[]> = {
  "Platform engineering": [
    k8sUpgrade,
    planReliabilitySprint,
    postmortem,
    diskPressure,
    slackReconnect,
    awsSpendBreakdown,
  ],
  "Customer success": [escalationReview],
  "Finance ops": [spendDashboard],
  "Design preview": [browserReview],
};
