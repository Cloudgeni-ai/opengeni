#!/usr/bin/env bun
/**
 * OPE-798 AC22: measure per-task usage limit admission and settlement on a
 * real, disposable PostgreSQL (OPENGENI_TEST_PG_URL) with the non-bypass
 * application role and FORCE RLS.
 *
 * - Admission: p50/p95 of the hot read with 0, 10k and 100k receipts on the
 *   root, against a plain `select 1` round trip on the same pool. A flat
 *   latency across receipt counts plus the plans below show that admission
 *   reads one indexed counter row and never scans receipts or events.
 * - Settlement contention: 20 concurrent settlements on 20 siblings of ONE
 *   root versus 20 concurrent settlements on 20 SEPARATE roots. Same-root
 *   settlements serialize on that root's counter row only; separate roots
 *   share no lock.
 *
 * Writes a JSON receipt (`--output`, default $OPENGENI_EVIDENCE_DIR or /tmp).
 * Never run against a production database.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  bootstrapWorkspace,
  checkSessionUsageLimitAdmission,
  checkWorkspaceAllowance,
  createDb,
  createSession,
  settleSessionUsageReceipt,
} from "@opengeni/db";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

export type Distribution = { samples: number; p50: number; p95: number; max: number };

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    samples: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const samples = Number(argument("--samples") ?? 200);
const rounds = Number(argument("--rounds") ?? 10);
const fanout = Number(argument("--fanout") ?? 20);
const outputPath = resolve(
  argument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/session-usage-limits-benchmark.json`,
);

async function main(): Promise<void> {
  if (!process.env.OPENGENI_TEST_PG_URL) {
    throw new Error("Set OPENGENI_TEST_PG_URL to a disposable local PostgreSQL");
  }
  const shared = await acquireSharedTestDatabase("bench-session-usage-limits");
  if (!shared) throw new Error("PostgreSQL is required");
  const app = createDb(shared.appUrl, { max: Math.max(24, fanout + 4) });
  try {
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "usage-limit-bench",
      accountExternalId: crypto.randomUUID(),
      accountName: "Usage limit bench",
      workspaceExternalSource: "usage-limit-bench",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Usage limit bench",
      subjectId: "user:usage-limit-bench",
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const newSession = async (parentSessionId?: string) =>
      (
        await createSession(app.db, {
          ...scope,
          initialMessage: "bench",
          model: "test",
          reasoningEffort: "low",
          latencyMode: "standard",
          sandboxBackend: "none",
          resources: [],
          metadata: {},
          createdBy: { kind: "subject", subjectId: "user:usage-limit-bench" },
          ...(parentSessionId ? { parentSessionId } : {}),
        })
      ).id;
    const settle = (sessionId: string, sourceId: string) =>
      settleSessionUsageReceipt(app.db, {
        ...scope,
        sessionId,
        sourceId,
        amountMicros: 7,
        pricingSource: "configured_list_price",
        model: "bench-model",
      });

    // Initialize a root row (complete history) through the real command.
    const root = await newSession();
    await settle(root, "seed:0");

    const timeAdmission = async (sessionId: string) => {
      const values: number[] = [];
      for (let i = 0; i < samples; i += 1) {
        const started = performance.now();
        const admission = await checkSessionUsageLimitAdmission(app.db, { ...scope, sessionId });
        values.push(performance.now() - started);
        if (!admission.allowed) throw new Error("bench root must stay unlimited");
      }
      return distribution(values);
    };
    const timeRoundTrip = async () => {
      const values: number[] = [];
      for (let i = 0; i < samples; i += 1) {
        const started = performance.now();
        await app.db.execute(sql`select 1`);
        values.push(performance.now() - started);
      }
      return distribution(values);
    };

    // The existing per-call workspace allowance read (unchanged by OPE-798)
    // is the same-host baseline the new read is compared against.
    const timeExistingAllowanceRead = async () => {
      const values: number[] = [];
      for (let i = 0; i < samples; i += 1) {
        const started = performance.now();
        await checkWorkspaceAllowance(app.db, { ...scope, subjectId: "user:usage-limit-bench" });
        values.push(performance.now() - started);
      }
      return distribution(values);
    };

    const admission: Record<string, Distribution> = {};
    const plans: Record<string, string[]> = {};
    admission.select1_round_trip = await timeRoundTrip();
    admission.existing_workspace_allowance_read = await timeExistingAllowanceRead();
    let seeded = 1;
    for (const target of [0, 10_000, 100_000]) {
      if (target > seeded) {
        // Synthetic receipts seeded directly (superuser, disposable DB only).
        await shared.admin.unsafe(
          `insert into opengeni_private.session_usage_limit_receipts
             (account_id, workspace_id, root_session_id, source_id, source_session_id,
              status, amount_micros, pricing_source, model, origin)
           select $1, $2, $3, 'bulk:' || g, $3, 'priced', 7, 'configured_list_price', 'bench-model', 'live'
             from generate_series($4::int, $5::int) g`,
          [scope.accountId, scope.workspaceId, root, seeded, target - 1],
        );
        seeded = target;
        await shared.admin.unsafe("analyze opengeni_private.session_usage_limit_receipts");
      }
      admission[`receipts_${target}`] = await timeAdmission(root);
      plans[`receipts_${target}`] = (
        await shared.admin.unsafe(
          `explain (analyze, buffers, costs off, timing off, summary off)
             select * from opengeni_private.session_usage_limit_roots
             where workspace_id = $1 and root_session_id = $2`,
          [scope.workspaceId, root],
        )
      ).map((row) => String((row as Record<string, unknown>)["QUERY PLAN"]));
    }
    // Admission must never touch receipts or events: prove it from the
    // database's own statistics around a burst of admissions.
    const scansBefore = await receiptScans(shared.admin);
    await timeAdmission(root);
    const scansAfter = await receiptScans(shared.admin);

    const children: string[] = [];
    for (let i = 0; i < fanout; i += 1) children.push(await newSession(root));
    const separateRoots: string[] = [];
    for (let i = 0; i < fanout; i += 1) separateRoots.push(await newSession());

    const contention = async (sessions: readonly string[], label: string) => {
      const perCall: number[] = [];
      const wall: number[] = [];
      let failures = 0;
      for (let round = 0; round < rounds; round += 1) {
        const started = performance.now();
        await Promise.all(
          sessions.map(async (sessionId, index) => {
            const callStarted = performance.now();
            try {
              await settle(sessionId, `${label}:${round}:${index}`);
            } catch {
              failures += 1;
            }
            perCall.push(performance.now() - callStarted);
          }),
        );
        wall.push(performance.now() - started);
      }
      return { perCallMs: distribution(perCall), roundWallMs: distribution(wall), failures };
    };
    // Unrelated-root admission while one root absorbs a sibling settlement
    // storm: it must not wait on that root's counter row.
    const unrelatedRoot = separateRoots[0]!;
    await settle(unrelatedRoot, "unrelated:init");
    const unrelatedIdle = await timeAdmission(unrelatedRoot);
    let storming = true;
    const storm = (async () => {
      let round = 0;
      while (storming) {
        round += 1;
        await Promise.all(
          children.map((sessionId, index) => settle(sessionId, `storm:${round}:${index}`)),
        );
      }
      return round;
    })();
    const unrelatedDuringStorm = await timeAdmission(unrelatedRoot);
    storming = false;
    const stormRounds = await storm;
    const sameRoot = await contention(children, "same-root");
    const separate = await contention(separateRoots, "separate-roots");
    const [counter] = await shared.admin.unsafe(
      `select known_micros::bigint as known, priced_calls::bigint as calls
         from opengeni_private.session_usage_limit_roots
        where workspace_id = $1 and root_session_id = $2`,
      [scope.workspaceId, root],
    );
    const expectedCalls = 1 + fanout * rounds + fanout * stormRounds;
    const deadlocks = await shared.admin.unsafe(
      "select deadlocks::bigint as deadlocks from pg_stat_database where datname = current_database()",
    );

    const receipt = {
      benchmark: "session-usage-limits",
      generatedAt: new Date().toISOString(),
      postgres: String(
        (await shared.admin.unsafe("show server_version"))[0]?.server_version ?? "unknown",
      ),
      parameters: { samples, rounds, fanout },
      admissionMs: admission,
      admissionPlans: plans,
      admissionReceiptScans: {
        before: scansBefore,
        after: scansAfter,
        note: "seq/idx scans on the receipts table across a burst of admissions; equal means admission never read receipts",
      },
      unrelatedRootAdmissionMs: {
        idle: unrelatedIdle,
        duringSameRootSettlementStorm: unrelatedDuringStorm,
        stormRounds,
        p50RegressionPercent: Math.round(
          ((unrelatedDuringStorm.p50 - unrelatedIdle.p50) / unrelatedIdle.p50) * 100,
        ),
      },
      settlement: {
        sameRoot20Siblings: sameRoot,
        separateRoots20: separate,
        sameRootCounter: {
          // Bulk-seeded receipts bypass the counter; live settlements are counted exactly.
          livePricedCalls: Number(counter?.calls ?? 0),
          expectedLivePricedCalls: expectedCalls,
          knownMicros: Number(counter?.known ?? 0),
          expectedKnownMicros: expectedCalls * 7,
        },
        deadlocksInDatabase: Number(deadlocks[0]?.deadlocks ?? 0),
      },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt, null, 2));
    if (
      receipt.settlement.sameRootCounter.livePricedCalls !== expectedCalls ||
      receipt.settlement.sameRootCounter.knownMicros !== expectedCalls * 7 ||
      sameRoot.failures + separate.failures > 0 ||
      receipt.settlement.deadlocksInDatabase > 0 ||
      scansAfter.seq !== scansBefore.seq ||
      scansAfter.idx !== scansBefore.idx
    ) {
      throw new Error("session usage limit benchmark invariants failed");
    }
  } finally {
    await app.close();
    await shared.release();
  }
}

async function receiptScans(
  admin: NonNullable<Awaited<ReturnType<typeof acquireSharedTestDatabase>>>["admin"],
): Promise<{ seq: number; idx: number }> {
  // Application backends flush statistics when idle at most once a second.
  await Bun.sleep(2_000);
  const [row] = await admin.unsafe(
    `select coalesce(seq_scan, 0)::bigint as seq, coalesce(idx_scan, 0)::bigint as idx
       from pg_stat_all_tables
      where schemaname = 'opengeni_private' and relname = 'session_usage_limit_receipts'`,
  );
  return { seq: Number(row?.seq ?? 0), idx: Number(row?.idx ?? 0) };
}

if (import.meta.main) {
  await main();
}
