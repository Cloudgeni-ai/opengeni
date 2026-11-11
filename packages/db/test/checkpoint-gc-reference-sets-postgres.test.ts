import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import type postgres from "postgres";

let shared: RestrictedRuntimeTestDatabase;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("checkpoint-gc-sets");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);

const id = () => crypto.randomUUID();
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
type Tx = postgres.TransactionSql;
type PlanNode = {
  "Rows Removed by Join Filter"?: number;
  "Rows Removed by Filter"?: number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
};
const rollback = new Error("rollback checkpoint fixture");
async function fixture(body: (tx: Tx) => Promise<void>) {
  await shared.admin
    .begin(async (tx) => {
      await tx`SELECT set_config('opengeni.sandbox_recovery_protocol_v2','1',true)`;
      await body(tx);
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
}
async function scope(tx: Tx) {
  const [account] =
    await tx`INSERT INTO managed_accounts(name) VALUES ('checkpoint test') RETURNING id`;
  const [workspace] =
    await tx`INSERT INTO workspaces(account_id,name) VALUES (${account!.id},'checkpoint test') RETURNING id`;
  return {
    account: account!.id as string,
    workspace: workspace!.id as string,
    group: id(),
    lease: id(),
  };
}
type Scope = Awaited<ReturnType<typeof scope>>;
function receipt(objectId: string) {
  const bytes = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({ snapshot_id: objectId, workspace_persistence: "snapshot_filesystem" })}`,
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    archive: bytes.toString("base64"),
    hash,
    length: bytes.length,
    descriptor: {
      version: 2,
      kind: "provider_snapshot",
      revision: `wa2:1:${hash}`,
      archiveSha256: hash,
      archiveBytes: bytes.length,
      snapshotId: objectId,
      provider: "modal_snapshot_filesystem",
      workspacePersistence: "snapshot_filesystem",
    },
  };
}
async function artifact(
  tx: Tx,
  s: Scope,
  options: {
    state?: string;
    native?: boolean;
    generation?: number;
    epoch?: number;
    instance?: string;
    created?: Date;
    after?: Date;
    claimed?: Date;
  } = {},
) {
  const artifactId = id(),
    objectId = `im-${artifactId}`,
    data = receipt(objectId);
  const binding =
    '{"version":1,"serverUrl":"https://api.modal.com","workspaceName":"fixture","environment":"test"}';
  const state = options.state ?? "candidate";
  await tx`INSERT INTO sandbox_checkpoint_artifacts
    (id,account_id,workspace_id,sandbox_group_id,source_lease_id,source_lease_epoch,source_instance_id,
     source_workspace_generation,provenance,provider_backend,provider_binding_key,provider_binding,
     object_kind,object_id,archive_base64,archive_sha256,archive_bytes,descriptor,descriptor_revision,
     state,created_at,delete_after,delete_claim_id,delete_claimed_at)
    VALUES (${artifactId},${s.account},${s.workspace},${s.group},${s.lease},${options.epoch ?? 1},${options.native ? (options.instance ?? "box") : null},
      ${options.native ? (options.generation ?? 2) : null},${options.native ? "native_capture" : "legacy_provider_adopted"},'modal',${binding},${binding}::text::jsonb,
      'modal_filesystem_snapshot',${objectId},${data.archive},${data.hash},${data.length},${JSON.stringify(data.descriptor)}::text::jsonb,
      ${data.descriptor.revision},${state},${options.created ?? past},${options.after ?? null},${state === "deleting" ? id() : null},
      ${state === "deleting" ? (options.claimed ?? past) : null})`;
  return { id: artifactId, ...data };
}
async function lease(
  tx: Tx,
  s: Scope,
  current?: Awaited<ReturnType<typeof artifact>>,
  previous?: Awaited<ReturnType<typeof artifact>>,
  capture = false,
) {
  const resume = {
    backendId: "modal",
    sessionState: {
      providerState: { sandboxId: "box" },
      ...(current
        ? { workspaceArchive: current.archive, workspaceArchiveMeta: current.descriptor }
        : {}),
      ...(previous
        ? { workspaceArchivePrev: previous.archive, workspaceArchivePrevMeta: previous.descriptor }
        : {}),
    },
  };
  await tx`INSERT INTO sandbox_leases(id,account_id,workspace_id,sandbox_group_id,liveness,refcount,turn_holders,viewer_holders,
    instance_id,backend,lease_epoch,workspace_generation,archive_generation,resume_backend_id,resume_state,expires_at,
    current_checkpoint_artifact_id,previous_checkpoint_artifact_id,
    archive_capture_id,archive_capture_operation_id,archive_capture_provider_request_id,archive_capture_attempt,
    archive_capture_generation,archive_capture_started_at,archive_capture_deadline_at)
    VALUES (${s.lease},${s.account},${s.workspace},${s.group},'warm',0,0,0,'box','modal',1,2,${current ? 2 : null},'modal',
      ${JSON.stringify(resume)}::text::jsonb,${future},${current?.id ?? null},${previous?.id ?? null},
      ${capture ? id() : null},${capture ? id() : null},${capture ? id() : null},${capture ? 1 : null},
      ${capture ? 2 : null},${capture ? past : null},${capture ? future : null})`;
}
async function due(tx: Tx) {
  await tx.unsafe("SET LOCAL ROLE opengeni_app");
  try {
    return (
      await tx`SELECT opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(60000) AS due`
    )[0]!.due;
  } finally {
    await tx.unsafe("RESET ROLE");
  }
}
async function claim(tx: Tx, limit = 500) {
  await tx.unsafe("SET LOCAL ROLE opengeni_app");
  try {
    return await tx`SELECT * FROM opengeni_private.claim_sandbox_checkpoint_artifacts(${id()}::uuid,${limit},60000)`;
  } finally {
    await tx.unsafe("RESET ROLE");
  }
}

test("GC protects current, previous, native capture and ready Rig references through the real app role", async () => {
  await fixture(async (tx) => {
    const s = await scope(tx);
    const current = await artifact(tx, s, { state: "current" });
    const previous = await artifact(tx, s, { state: "previous" });
    await lease(tx, s, current, previous);
    const capturing = { ...s, group: id(), lease: id() };
    await artifact(tx, capturing, { native: true });
    await lease(tx, capturing, undefined, undefined, true);
    const rigImage = await artifact(tx, s);
    const changeImage = await artifact(tx, s);
    const [rig] =
      await tx`INSERT INTO rigs(account_id,workspace_id,name) VALUES (${s.account},${s.workspace},'gc') RETURNING id`;
    const [version] =
      await tx`INSERT INTO rig_versions(account_id,workspace_id,rig_id,version,active,provider_images)
      VALUES (${s.account},${s.workspace},${rig!.id},1,true,${JSON.stringify({ modal: { status: "ready", artifactId: rigImage.id } })}::text::jsonb) RETURNING id`;
    await tx`INSERT INTO rig_changes(account_id,workspace_id,rig_id,base_version_id,kind,payload,status,verification)
      VALUES (${s.account},${s.workspace},${rig!.id},${version!.id},'setup_append','{}','verifying',
      ${JSON.stringify({ providerImage: { status: "ready", artifactId: changeImage.id } })}::text::jsonb)`;
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await due(tx)).toBe(false);
    expect(await claim(tx)).toHaveLength(0);
    // A failed Rig image and a mismatched native capture generation are collectable.
    const failedImage = await artifact(tx, s);
    await tx`UPDATE rig_versions SET provider_images = provider_images || ${JSON.stringify({ failed: { status: "failed", artifactId: failedImage.id } })}::text::jsonb WHERE id=${version!.id}`;
    const mismatches = await Promise.all([
      artifact(tx, capturing, { native: true, generation: 1 }),
      artifact(tx, capturing, { native: true, epoch: 2 }),
      artifact(tx, capturing, { native: true, instance: "other-box" }),
      artifact(tx, { ...capturing, lease: id() }, { native: true }),
    ]);
    expect(await due(tx)).toBe(true);
    expect((await claim(tx)).map((row) => row.id).sort()).toEqual(
      [failedImage.id, ...mismatches.map((row) => row.id)].sort(),
    );
    expect(await due(tx)).toBe(false);
    expect(await tx`SELECT * FROM opengeni_private.maintenance_claim_capabilities`).toHaveLength(0);
    await tx.unsafe("SET LOCAL ROLE opengeni_app");
    await expect(
      tx.savepoint(
        (sp) =>
          sp`SELECT * FROM opengeni_private.maintenance_claim_checkpoint_gc_inner(${id()}::uuid,1,60000)`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await tx.unsafe("RESET ROLE");
  });
}, 30_000);

test("GC preserves grace periods, retry deadlines, bounded stale claims and deletion receipts", async () => {
  await fixture(async (tx) => {
    const s = await scope(tx);
    await artifact(tx, s, { created: new Date() });
    await artifact(tx, s, { state: "delete_pending", after: future });
    await artifact(tx, s, { state: "delete_failed", after: future });
    await artifact(tx, s, { state: "deleting", claimed: future });
    await artifact(tx, s, { state: "deleted" });
    expect(await due(tx)).toBe(false);
    const eligible = await artifact(tx, s, { state: "delete_failed", after: past });
    expect(await due(tx)).toBe(true);
    const claimed = await claim(tx, 1);
    expect(claimed.map((row) => row.id)).toEqual([eligible.id]);
    expect(claimed[0]!.delete_attempts).toBe(1);
    expect(claimed[0]!.object_id).toBe(`im-${eligible.id}`);
    const stale = [
      await artifact(tx, s, { state: "deleting" }),
      await artifact(tx, s, { state: "deleting" }),
    ];
    const reclaimed = await claim(tx, 1);
    expect(reclaimed).toHaveLength(1);
    expect(stale.map((row) => row.id)).toContain(reclaimed[0]!.id);
    const [remaining] = await tx`SELECT count(*)::int AS count FROM sandbox_checkpoint_artifacts
      WHERE id IN (${stale[0]!.id},${stale[1]!.id}) AND delete_claimed_at=${past}`;
    expect(remaining!.count).toBe(1);
  });
});

test("concurrent GC workers skip locked candidates and never claim the same artifact", async () => {
  let ids: string[] = [];
  await shared.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.sandbox_recovery_protocol_v2','1',true)`;
    const s = await scope(tx);
    ids = [(await artifact(tx, s)).id, (await artifact(tx, s)).id];
  });
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const first = shared.admin.begin(async (tx) => {
    const rows = await claim(tx, 1);
    locked();
    await held;
    return rows;
  });
  try {
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("claim returned before barrier");
      }),
    ]);
    const second = await shared.admin.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout','3s',true)`;
      return claim(tx, 1);
    });
    release();
    const one = await first;
    expect(one).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect([one[0]!.id, second[0]!.id].sort()).toEqual(ids.sort());
  } finally {
    release();
    await first;
  }
});

// The claim still scans the source lease table, unlike the indexed scheduling
// projection introduced by 0848. Exercise its real candidate SQL with the same
// owner capability as the runtime wrapper and production-shaped idle inventory.
test("idle checkpoint claims do not multiply artifacts by leases", async () => {
  await fixture(async (tx) => {
    const s = await scope(tx);
    for (let n = 0; n < 1000; n++) {
      const linked = { ...s, lease: id(), group: id() };
      const current = await artifact(tx, linked, { state: "current" });
      await lease(tx, linked, current);
    }
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.unsafe("ANALYZE sandbox_checkpoint_artifacts");
    await tx.unsafe("ANALYZE sandbox_leases");
    expect(await due(tx)).toBe(false);
    expect(await claim(tx)).toHaveLength(0);
    const [fn] =
      await tx`SELECT prosrc FROM pg_proc WHERE oid='opengeni_private.maintenance_claim_checkpoint_gc_inner(uuid,integer,bigint)'::regprocedure`;
    const candidate = String(fn!.prosrc)
      .split("WITH candidates AS (\n")[1]!
      .split("\n      )\n      UPDATE")[0]!
      .replace("LIMIT p_limit", "LIMIT 50");
    const referenceStart = candidate.indexOf("          AND NOT EXISTS (");
    const nativeStart = candidate.indexOf("artifact.provenance = 'native_capture'");
    expect(referenceStart).toBeGreaterThan(0);
    expect(nativeStart).toBeGreaterThan(referenceStart);
    const original =
      candidate.slice(0, referenceStart) +
      `          AND NOT EXISTS (
            SELECT 1 FROM ${shared.schema}.sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
               OR lease.previous_checkpoint_artifact_id = artifact.id
               OR (\n                 ` +
      candidate.slice(nativeStart);
    await tx.unsafe(`SET LOCAL ROLE "${shared.ownerRole}"`);
    await tx`INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
      (${id()},pg_backend_pid(),pg_current_xact_id(),'checkpoint_gc')`;
    const explain = async (query: string) =>
      (await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${query}`))[0]![
        "QUERY PLAN"
      ][0];
    const before = await explain(original);
    const after = await explain(candidate);
    const comparisons = (node: PlanNode): number =>
      (Number(node["Rows Removed by Join Filter"] ?? 0) +
        Number(node["Rows Removed by Filter"] ?? 0)) *
        Number(node["Actual Loops"] ?? 1) +
      (node.Plans ?? []).reduce((sum: number, child: PlanNode) => sum + comparisons(child), 0);
    expect(before.Plan["Actual Rows"]).toBe(0);
    expect(after.Plan["Actual Rows"]).toBe(0);
    // Assert work rather than elapsed time. The old OR join fails this bound;
    // both queries still use the owner's real FORCE-RLS capability predicates.
    expect(comparisons(before.Plan)).toBeGreaterThan(100_000);
    expect(comparisons(after.Plan)).toBeLessThan(10_000);
    console.info(
      "checkpoint-gc-idle-plan",
      JSON.stringify({
        artifacts: 1000,
        leases: 1000,
        beforeMs: before["Execution Time"],
        afterMs: after["Execution Time"],
        beforeJoinComparisons: comparisons(before.Plan),
        afterJoinComparisons: comparisons(after.Plan),
      }),
    );
    await tx.unsafe("RESET ROLE");
  });
}, 60_000);
