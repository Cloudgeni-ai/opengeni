// The checkpoint-staleness inventory (migrations 0672 and 0681) counts live
// Modal boxes with an uncaptured write on that exact box, aged from the first
// such write (never before the box was created). Runs as the restricted app role.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  readSandboxCheckpointStaleness,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let accountId: string;
let workspaceId: string;
let sessionId: string;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("db-sandbox-checkpoint-staleness");
  if (!shared) throw new Error("Real PostgreSQL required for the staleness inventory");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Checkpoint staleness",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Checkpoint staleness",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Checkpoint staleness",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Write = {
  generation: number;
  hoursAgo: number;
  settledHoursAgo?: number | null;
  otherBox?: boolean;
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function lease(input: {
  liveness?: "warm" | "draining" | "cold";
  backend?: "modal" | "local";
  workspaceGeneration: number;
  archiveGeneration: number | null;
  archiveAt?: string | null;
  boxHoursAgo: number;
  writes?: Write[];
  /** A viewer or interaction holder attached this many hours ago. */
  attached?: { kind: "viewer" | "interaction"; hoursAgo: number };
}) {
  const leaseId = crypto.randomUUID();
  const sandboxGroupId = crypto.randomUUID();
  const live = (input.liveness ?? "warm") !== "cold";
  const instanceId = `box-${crypto.randomUUID()}`;
  const backend = input.backend ?? "modal";
  const sessionState = input.archiveAt ? { workspaceArchiveAt: input.archiveAt } : {};
  await admin`
    insert into sandbox_leases (id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, workspace_generation, archive_generation, provider_created_at,
      provider_deadline_at)
    values (${leaseId}, ${accountId}, ${workspaceId}, ${sandboxGroupId},
      ${input.liveness ?? "warm"}, 0, 0, 0, ${live ? instanceId : null}, ${backend}, 1,
      ${backend},
      ${JSON.stringify({ backendId: backend, sessionState })}::text::jsonb,
      now() + interval '10 minutes', ${input.workspaceGeneration}, ${input.archiveGeneration},
      now() - (${input.boxHoursAgo} * interval '1 hour'),
      now() + (${24 - input.boxHoursAgo} * interval '1 hour'))`;
  if (input.attached) {
    await admin`insert into sandbox_lease_holders
      (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at,
        created_at)
      values (${accountId}, ${leaseId}, ${workspaceId}, ${input.attached.kind},
        ${`${input.attached.kind}:${crypto.randomUUID()}`}, ${sessionId}, now(),
        ${hoursAgo(input.attached.hoursAgo)})`;
  }
  for (const write of input.writes ?? []) {
    const actorId = crypto.randomUUID();
    const settledAt =
      write.settledHoursAgo === null
        ? null
        : hoursAgo(write.settledHoursAgo ?? Math.max(write.hoursAgo - 0.01, 0));
    await admin`insert into sandbox_workspace_mutation_admissions ${admin({
      account_id: accountId,
      workspace_id: workspaceId,
      lease_id: leaseId,
      sandbox_group_id: sandboxGroupId,
      session_id: sessionId,
      actor_kind: "direct",
      actor_id: actorId,
      holder_kind: "direct",
      holder_id: `direct:${actorId}`,
      lease_epoch: 1,
      provider_backend: backend,
      provider_instance_id: write.otherBox ? `box-${crypto.randomUUID()}` : instanceId,
      route_kind: "active",
      route_epoch: 0,
      workspace_generation: write.generation,
      operation: "terminalExec",
      provider_outcome: settledAt === null ? "retained" : "resolved",
      admitted_at: hoursAgo(write.hoursAgo),
      settled_at: settledAt,
    })}`;
  }
}

// The operator runbook query from docs/application-observability.md, run as
// the superuser it documents (forced row-level security hides rows otherwise).
async function runbookRows() {
  const docs = await Bun.file(
    new URL("../../../docs/application-observability.md", import.meta.url),
  ).text();
  const section = docs.slice(docs.indexOf("To find the leases behind the alert"));
  const query = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
  if (!query) throw new Error("runbook query missing from the docs");
  const rows = await admin.unsafe<{ id: string; unsaved_since: Date }[]>(
    query.replace(/limit 20;\s*$/, ";"),
  );
  return rows;
}

describe("sandbox checkpoint staleness inventory", () => {
  test("counts only uncaptured writes on the live box, aged from the first one", async () => {
    const before = await readSandboxCheckpointStaleness(client.db);
    const beforeRunbook = await runbookRows();
    const iso = (hours: number) => hoursAgo(hours).toISOString();

    // Counted, 13h: a write admitted 13h ago after the last checkpoint.
    await lease({
      workspaceGeneration: 9,
      archiveGeneration: 4,
      archiveAt: iso(14),
      boxHoursAgo: 20,
      writes: [
        { generation: 4, hoursAgo: 15 },
        { generation: 5, hoursAgo: 13 },
        { generation: 9, hoursAgo: 1 },
      ],
    });
    // Counted, 5h: never checkpointed, first write 5h ago.
    await lease({
      workspaceGeneration: 3,
      archiveGeneration: null,
      boxHoursAgo: 6,
      writes: [{ generation: 1, hoursAgo: 5 }],
    });
    // Counted, 2h: a background command admitted before the last checkpoint is
    // still running, so the box is unsaved since that checkpoint (draining too).
    await lease({
      liveness: "draining",
      workspaceGeneration: 7,
      archiveGeneration: 6,
      archiveAt: iso(2),
      boxHoursAgo: 10,
      writes: [{ generation: 5, hoursAgo: 8, settledHoursAgo: null }],
    });
    // Counted, 3h: the latest captured command settled after the checkpoint.
    await lease({
      workspaceGeneration: 7,
      archiveGeneration: 6,
      archiveAt: iso(3),
      boxHoursAgo: 10,
      writes: [{ generation: 6, hoursAgo: 9, settledHoursAgo: 1 }],
    });
    // Counted, 1h: a write older than the box (impossible clock skew) is
    // clamped to the box's creation.
    await lease({
      workspaceGeneration: 2,
      archiveGeneration: 1,
      archiveAt: iso(30),
      boxHoursAgo: 1,
      writes: [{ generation: 2, hoursAgo: 30 }],
    });

    // Not counted: a 13h-old box with no write and nothing attached.
    await lease({
      workspaceGeneration: 0,
      archiveGeneration: null,
      boxHoursAgo: 13,
    });
    // Not counted: a restored box whose generation is ahead of its archive but
    // which has no write behind it.
    await lease({
      workspaceGeneration: 8,
      archiveGeneration: 7,
      archiveAt: iso(72),
      boxHoursAgo: 15,
    });
    // Not counted: the uncaptured write belongs to an earlier box.
    await lease({
      workspaceGeneration: 5,
      archiveGeneration: 4,
      boxHoursAgo: 15,
      writes: [{ generation: 5, hoursAgo: 16, otherBox: true }],
    });
    // Not counted: every write captured and settled before the checkpoint.
    await lease({
      workspaceGeneration: 6,
      archiveGeneration: 6,
      archiveAt: iso(20),
      boxHoursAgo: 22,
      writes: [{ generation: 6, hoursAgo: 21 }],
    });
    // Not counted: cold and non-Modal boxes.
    await lease({
      liveness: "cold",
      workspaceGeneration: 6,
      archiveGeneration: 2,
      boxHoursAgo: 23,
      writes: [{ generation: 3, hoursAgo: 20 }],
    });
    await lease({
      backend: "local",
      workspaceGeneration: 6,
      archiveGeneration: 2,
      boxHoursAgo: 23,
      writes: [{ generation: 3, hoursAgo: 20 }],
    });

    const after = await readSandboxCheckpointStaleness(client.db);
    // The documented operator runbook query finds the same boxes, oldest first.
    const runbook = await runbookRows();
    expect(runbook.length - beforeRunbook.length).toBe(5);
    const oldestHours = (Date.now() - new Date(runbook[0]!.unsaved_since).getTime()) / 3_600_000;
    expect(oldestHours).toBeGreaterThan(12.9);
    expect(oldestHours).toBeLessThan(13.1);
    expect(after.dirty - before.dirty).toBe(5);
    expect(after.stale4h - before.stale4h).toBe(2);
    expect(after.stale12h - before.stale12h).toBe(1);
    expect(after.maxAgeSeconds).toBeGreaterThanOrEqual(13 * 3600 - 60);
    expect(after.maxAgeSeconds).toBeLessThan(14 * 3600);
  }, 60_000);

  test("an older captured write that settled after the checkpoint counts", async () => {
    const before = await readSandboxCheckpointStaleness(client.db);
    const beforeRunbook = await runbookRows();
    // A checkpoint 5h ago ran around a background command (generation 5) and
    // was published one generation behind the workspace, whose newest
    // generation has no write behind it. A newer captured write (generation
    // 6) settled before that checkpoint; the command kept writing until it
    // settled 1h ago, so the box is unsaved since the checkpoint even though
    // the newest captured write is clean.
    await lease({
      workspaceGeneration: 7,
      archiveGeneration: 6,
      archiveAt: hoursAgo(5).toISOString(),
      boxHoursAgo: 10,
      writes: [
        { generation: 5, hoursAgo: 9, settledHoursAgo: 1 },
        { generation: 6, hoursAgo: 8, settledHoursAgo: 7 },
      ],
    });
    const after = await readSandboxCheckpointStaleness(client.db);
    expect(after.dirty - before.dirty).toBe(1);
    expect(after.stale4h - before.stale4h).toBe(1);
    expect(after.maxAgeSeconds).toBeGreaterThanOrEqual(5 * 3600 - 60);
    const runbook = await runbookRows();
    expect(runbook.length - beforeRunbook.length).toBe(1);
  }, 60_000);

  test("an attached viewer or controller counts from the later of checkpoint and attach", async () => {
    const before = await readSandboxCheckpointStaleness(client.db);
    const beforeRunbook = await runbookRows();
    // Counted, 6h: a terminal tab open for 9h, checkpointed 6h ago with the
    // tab attached. It may have written since that checkpoint without moving
    // the generation.
    await lease({
      workspaceGeneration: 4,
      archiveGeneration: 3,
      archiveAt: hoursAgo(6).toISOString(),
      boxHoursAgo: 10,
      attached: { kind: "viewer", hoursAgo: 9 },
    });
    // Counted, 2h: a computer controller attached 2h ago, after a complete
    // checkpoint 5h ago.
    await lease({
      workspaceGeneration: 3,
      archiveGeneration: 3,
      archiveAt: hoursAgo(5).toISOString(),
      boxHoursAgo: 8,
      attached: { kind: "interaction", hoursAgo: 2 },
    });
    const after = await readSandboxCheckpointStaleness(client.db);
    expect(after.dirty - before.dirty).toBe(2);
    expect(after.stale4h - before.stale4h).toBe(1);
    const runbook = await runbookRows();
    expect(runbook.length - beforeRunbook.length).toBe(2);
    const ages = runbook
      .map((row) => (Date.now() - new Date(row.unsaved_since).getTime()) / 3_600_000)
      .filter((age) => (age > 5.9 && age < 6.1) || (age > 1.9 && age < 2.1));
    expect(ages.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("a malformed checkpoint time does not break the inventory", async () => {
    const before = await readSandboxCheckpointStaleness(client.db);
    await lease({
      workspaceGeneration: 3,
      archiveGeneration: 2,
      archiveAt: "2026-13-45T99:99:99Z",
      boxHoursAgo: 6,
      writes: [{ generation: 2, hoursAgo: 5, settledHoursAgo: null }],
    });
    const after = await readSandboxCheckpointStaleness(client.db);
    // The open command still counts the box dirty, aged from box creation.
    expect(after.dirty - before.dirty).toBe(1);
    expect(after.stale4h - before.stale4h).toBe(1);
  }, 60_000);
});
