// M1 B-suite integration (dossier §12 B1–B7, §14). Drives REAL agent bash turns
// on the docker sandbox backend through the running dev stack (API :8001 +
// worker + docker box) via the public SDK seed harness, then inspects the
// persisted capture: the DB rows (postgres, superuser bypasses RLS) and the
// manifest/after-image blobs (minio). This proves the DISK-PROBE thesis — that
// files an agent mutates via bash (which emit no fs events) appear in the
// capture because it re-probes the live box at turn end.
//
// REQUIRES the live dev stack (NOT startTestServices — the capture runs inside
// the real worker's agent-turn activity):
//   • API on OPENGENI_SEED_BASE_URL (default :8001), worker polling, docker
//     backend, `opengeni-sandbox-pin` alive, migration 0045 applied.
//   • OPENGENI_DATABASE_URL + OPENGENI_OBJECT_STORAGE_* pointing at the SAME
//     postgres/minio the worker writes to (host: DB :15542, minio :19110).
// Run: bun test test/integration/workspace-capture.integration.ts
import { afterAll, describe, expect, test } from "bun:test";
import { createObjectStorage } from "../../packages/storage/src/index";
import { testSettings } from "@opengeni/testing";
import { WorkspaceCaptureManifest } from "@opengeni/contracts";
import {
  computeWorkspaceCaptureGcPlan,
  createDb,
  dbSql,
  deleteWorkspaceCaptureRows,
  insertWorkspaceCapture,
  planWorkspaceCaptureGc,
} from "@opengeni/db";
import {
  createClient,
  driveBashTurn,
  resolveWorkspaceId,
  seedSessionWithBash,
} from "../e2e/seed/harness";

const DB_URL =
  process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:15542/opengeni";
const MINIO_ENDPOINT = process.env.OPENGENI_OBJECT_STORAGE_ENDPOINT ?? "http://127.0.0.1:19110";
const TURN_TIMEOUT = 220_000;

const dbClient = createDb(DB_URL);
const db = dbClient.db;
const storage = createObjectStorage(
  testSettings({
    objectStorageBackend: "s3-compatible",
    objectStorageEndpoint: MINIO_ENDPOINT,
    objectStorageBucket: "opengeni-files",
    objectStorageAccessKeyId: "minioadmin",
    objectStorageSecretAccessKey: "minioadmin",
    objectStorageForcePathStyle: true,
  }),
)!;

afterAll(async () => {
  await dbClient.close();
});

type CaptureRow = {
  id: string;
  revision: number;
  manifest_key: string | null;
  tree_index_key: string | null;
  blob_keys: string[];
  size_bytes: number | null;
  stats: Record<string, unknown>;
  account_id: string;
  workspace_id: string;
  session_id: string;
};

async function captureRows(sessionId: string): Promise<CaptureRow[]> {
  const rows = await db.execute<CaptureRow>(dbSql`
    select id, revision::int as revision, manifest_key, tree_index_key, blob_keys,
           size_bytes::int as size_bytes, stats, account_id, workspace_id, session_id
    from workspace_captures where session_id = ${sessionId} order by revision`);
  return rows as unknown as CaptureRow[];
}

async function fetchManifest(key: string) {
  const obj = await storage.getObjectBytes(key);
  expect(obj).not.toBeNull();
  return WorkspaceCaptureManifest.parse(JSON.parse(Buffer.from(obj!.bytes).toString("utf8")));
}

/** A bash script that inits a git repo at `dir`, commits a baseline, then mutates. */
function gitRepoScript(dir: string): string {
  const prefix = dir === "." ? "" : `mkdir -p ${dir}; cd ${dir}; `;
  return [
    "set -e",
    `${prefix}git init -q . 2>/dev/null || true`,
    "git config user.email t@t.co; git config user.name tester",
    "printf 'line-one\\n' > app.py",
    "git add app.py && git commit -qm baseline",
    "printf 'line-one\\nline-two\\n' > app.py", // modify tracked
    "printf 'fresh file\\n' > utils.py", // untracked
  ].join("\n");
}

describe("workspace capture — B-suite (real docker turns)", () => {
  const client = createClient();

  test(
    "B1: bash-mutated files appear in the capture diff + after-images (disk-probe)",
    async () => {
      const workspaceId = await resolveWorkspaceId();
      const session = await seedSessionWithBash(client, workspaceId, {
        title: "capture-B1",
        bashScript: gitRepoScript("."),
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(2000); // let the turn-end capture land

      const rows = await captureRows(session.id);
      expect(rows.length).toBe(1);
      const rev0 = rows[0]!;
      expect(rev0.revision).toBe(0);
      expect(rev0.blob_keys.length).toBeGreaterThanOrEqual(2);
      expect(rev0.stats.fingerprint).toBeTruthy();

      const manifest = await fetchManifest(rev0.manifest_key!);
      // The modified tracked file shows up as a real diff hunk (git diff HEAD).
      const rootRepo = manifest.repos.find((r) => r.root === "" || r.root === ".");
      expect(rootRepo).toBeTruthy();
      const appDiff = rootRepo!.diff.find((d) => d.path === "app.py");
      expect(appDiff).toBeTruthy();
      expect(appDiff!.additions).toBeGreaterThanOrEqual(1);
      // Both the modified and the untracked file are captured as after-images.
      const appFile = manifest.files.find((f) => f.path === "app.py");
      const utilsFile = manifest.files.find((f) => f.path === "utils.py");
      expect(appFile?.contentRef).toBeTruthy();
      expect(utilsFile?.contentRef).toBeTruthy();
      expect(utilsFile?.status).toBe("untracked");

      // The after-image blob is the ACTUAL on-disk content (proves disk-probe, not
      // tool-call reconstruction).
      const appBytes = await storage.getObjectBytes(appFile!.contentRef!);
      expect(Buffer.from(appBytes!.bytes).toString("utf8")).toBe("line-one\nline-two\n");
      const utilsBytes = await storage.getObjectBytes(utilsFile!.contentRef!);
      expect(Buffer.from(utilsBytes!.bytes).toString("utf8")).toBe("fresh file\n");

      // ── B3: an empty follow-up turn (no tree change) writes NO new revision ──
      await driveBashTurn(client, workspaceId, session.id, "echo 'no file changes here'", {
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(2000);
      const afterEmpty = await captureRows(session.id);
      expect(afterEmpty.map((r) => r.revision)).toEqual([0]); // still just rev0

      // ── A real follow-up mutation DOES write rev1 ──
      await driveBashTurn(
        client,
        workspaceId,
        session.id,
        "printf 'line-one\\nline-two\\nline-three\\n' > app.py",
        { timeoutMs: TURN_TIMEOUT },
      );
      await Bun.sleep(2000);
      const afterChange = await captureRows(session.id);
      expect(afterChange.map((r) => r.revision)).toEqual([0, 1]);
      const rev1Manifest = await fetchManifest(afterChange[1]!.manifest_key!);
      const rev1App = rev1Manifest.files.find((f) => f.path === "app.py");
      const rev1Bytes = await storage.getObjectBytes(rev1App!.contentRef!);
      expect(Buffer.from(rev1Bytes!.bytes).toString("utf8")).toBe(
        "line-one\nline-two\nline-three\n",
      );
      // Content changed → a different fingerprint than rev0.
      expect(afterChange[1]!.stats.fingerprint).not.toBe(afterChange[0]!.stats.fingerprint);
    },
    TURN_TIMEOUT * 4,
  );

  test(
    "B2: multi-repo workspace — per-repo diffs discovered and grouped",
    async () => {
      const workspaceId = await resolveWorkspaceId();
      const script = ["set -e", gitRepoScript("api"), "cd ..", gitRepoScript("web")].join("\n");
      const session = await seedSessionWithBash(client, workspaceId, {
        title: "capture-B2",
        bashScript: script,
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(2000);

      const rows = await captureRows(session.id);
      expect(rows.length).toBe(1);
      const manifest = await fetchManifest(rows[0]!.manifest_key!);
      const roots = manifest.repos.map((r) => r.root).sort();
      expect(roots).toContain("api");
      expect(roots).toContain("web");
      // Each repo carries its own app.py diff + its files are path-prefixed by root.
      for (const root of ["api", "web"]) {
        const repo = manifest.repos.find((r) => r.root === root)!;
        expect(repo.diff.some((d) => d.path === "app.py")).toBe(true);
        expect(manifest.files.some((f) => f.path === `${root}/app.py`)).toBe(true);
        expect(manifest.files.some((f) => f.path === `${root}/utils.py`)).toBe(true);
      }
    },
    TURN_TIMEOUT * 2,
  );

  test(
    "B4: a >5MB file trips the per-file content guard (tooLarge marker, no blob)",
    async () => {
      const workspaceId = await resolveWorkspaceId();
      const script = [
        "set -e",
        "git init -q . 2>/dev/null || true",
        "git config user.email t@t.co; git config user.name tester",
        "printf 'seed\\n' > seed.txt && git add seed.txt && git commit -qm base",
        "head -c 6291456 /dev/zero | tr '\\0' 'a' > big.txt", // 6 MB untracked file (> 5MB guard)
        "printf 'small\\n' > small.txt", // a normal untracked file
      ].join("\n");
      const session = await seedSessionWithBash(client, workspaceId, {
        title: "capture-B4",
        bashScript: script,
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(2000);

      const rows = await captureRows(session.id);
      expect(rows.length).toBe(1);
      const manifest = await fetchManifest(rows[0]!.manifest_key!);
      const big = manifest.files.find((f) => f.path === "big.txt");
      expect(big?.tooLarge).toBe(true);
      expect(big?.contentRef).toBeNull(); // over-guard → no content blob, "open live"
      expect(big?.sizeBytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      // The normal file is still captured intact (rest of capture unaffected).
      const small = manifest.files.find((f) => f.path === "small.txt");
      expect(small?.contentRef).toBeTruthy();
      const smallBytes = await storage.getObjectBytes(small!.contentRef!);
      expect(Buffer.from(smallBytes!.bytes).toString("utf8")).toBe("small\n");
      // The oversized file's content is NOT in storage (no blob key references it).
      expect(rows[0]!.blob_keys.some((k) => big?.contentRef && k === big.contentRef)).toBe(false);
      expect(manifest.stats.tooLargeCount).toBeGreaterThanOrEqual(1);
    },
    TURN_TIMEOUT * 2,
  );

  test(
    "B5: keep-latest-N GC retains N and deletes ONLY orphaned blobs (real DB + minio)",
    async () => {
      // Exercises the REAL GC helpers (planWorkspaceCaptureGc → storage delete →
      // deleteWorkspaceCaptureRows — the exact sequence runCapture runs) against
      // real postgres + real minio, seeded with synthetic rows so we don't pay for
      // 12 slow agent turns. FK-valid ids come from a just-created session.
      const workspaceId = await resolveWorkspaceId();
      const session = await seedSessionWithBash(client, workspaceId, {
        title: "capture-B5-seed",
        bashScript: gitRepoScript("."),
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(1500);
      const [seed] = await captureRows(session.id);
      const { account_id, workspace_id, session_id } = seed!;

      // A blob shared by the oldest (to-be-evicted) revision AND a surviving one —
      // it must NOT be deleted. Plus one unique orphan blob per synthetic revision.
      const sharedKey = `workspace-captures/${workspace_id}/${session_id}/blobs/shared-${Date.now()}`;
      await storage.putObject({
        key: sharedKey,
        contentType: "application/octet-stream",
        body: new TextEncoder().encode("shared"),
      });

      const keepN = 10;
      const total = 14; // seed row is revision 0; add 1..13 → 14 total → 4 evicted
      const synthetic: Array<{ manifestKey: string; orphanKey: string; revision: number }> = [];
      for (let rev = 1; rev < total; rev++) {
        const manifestKey = `workspace-captures/${workspace_id}/${session_id}/manifests/synthetic-${rev}.json`;
        const orphanKey = `workspace-captures/${workspace_id}/${session_id}/blobs/orphan-${rev}`;
        await storage.putObject({
          key: manifestKey,
          contentType: "application/json",
          body: new TextEncoder().encode(`{"rev":${rev}}`),
        });
        await storage.putObject({
          key: orphanKey,
          contentType: "application/octet-stream",
          body: new TextEncoder().encode(`o${rev}`),
        });
        // The oldest synthetic (rev 1, evicted) shares `sharedKey` with the NEWEST
        // synthetic (rev 13, surviving), so the set-difference must spare it.
        const blobKeys = rev === 1 || rev === total - 1 ? [orphanKey, sharedKey] : [orphanKey];
        await db.execute(dbSql`
        insert into workspace_captures
          (account_id, workspace_id, session_id, revision, lease_epoch, state, manifest_key, tree_index_key, blob_keys, size_bytes, stats)
        values (${account_id}, ${workspace_id}, ${session_id}, ${rev}, 1, 'available',
                ${manifestKey}, ${manifestKey}, ${JSON.stringify(blobKeys)}::jsonb, 10, '{}'::jsonb)`);
        synthetic.push({ manifestKey, orphanKey, revision: rev });
      }

      // Sanity: 14 rows present pre-GC.
      expect((await captureRows(session_id)).length).toBe(total);

      // Run the real GC sequence (mirrors runCapture step 9).
      const plan = await planWorkspaceCaptureGc(db, {
        workspaceId: workspace_id,
        sessionId: session_id,
        keepN,
      });
      expect(plan.evictedRowIds.length).toBe(total - keepN); // 4 evicted (revisions 0..3)
      // The shared blob must NOT be in the delete set (rev 13 still references it).
      expect(plan.deleteBlobKeys).not.toContain(sharedKey);
      for (const key of plan.deleteBlobKeys) await storage.deleteObject(key);
      for (const key of plan.deletePerRevisionKeys) await storage.deleteObject(key);
      const deleted = await deleteWorkspaceCaptureRows(db, {
        workspaceId: workspace_id,
        rowIds: plan.evictedRowIds,
      });
      expect(deleted).toBe(total - keepN);

      // Exactly keepN rows retained, and they are the newest revisions.
      const retained = await captureRows(session_id);
      expect(retained.length).toBe(keepN);
      expect(retained[0]!.revision).toBe(total - keepN); // oldest retained = revision 4

      // Storage-listing proof: the shared blob survives; an evicted orphan is gone.
      expect(await storage.getObjectBytes(sharedKey)).not.toBeNull();
      const evictedOrphan = synthetic.find((s) => s.revision === 1)!.orphanKey;
      expect(await storage.getObjectBytes(evictedOrphan)).toBeNull();
      // A surviving revision's orphan blob is untouched.
      const survivingOrphan = synthetic.find((s) => s.revision === total - 1)!.orphanKey;
      expect(await storage.getObjectBytes(survivingOrphan)).not.toBeNull();

      // cleanup the shared key we created (best-effort).
      await storage.deleteObject(sharedKey).catch(() => undefined);
    },
    TURN_TIMEOUT * 2,
  );

  test(
    "B7: fenced insert writes only under the live lease epoch (supersession → zero rows)",
    async () => {
      const workspaceId = await resolveWorkspaceId();
      const session = await seedSessionWithBash(client, workspaceId, {
        title: "capture-B7",
        bashScript: gitRepoScript("."),
        timeoutMs: TURN_TIMEOUT,
      });
      await Bun.sleep(1500);
      const [seed] = await captureRows(session.id);
      const { account_id, workspace_id, session_id } = seed!;

      // The live lease epoch for this session's sandbox group.
      const grpRows = await db.execute<{ sandbox_group_id: string }>(dbSql`
      select sandbox_group_id from sessions where id = ${session_id}`);
      const sandboxGroupId = (grpRows as unknown as Array<{ sandbox_group_id: string }>)[0]!
        .sandbox_group_id;
      const leaseRows = await db.execute<{ lease_epoch: number }>(dbSql`
      select lease_epoch::int as lease_epoch from sandbox_leases where sandbox_group_id = ${sandboxGroupId} limit 1`);
      const leaseEpoch = (leaseRows as unknown as Array<{ lease_epoch: number }>)[0]!.lease_epoch;

      const nextRevision = seed!.revision + 1;
      const args = {
        accountId: account_id,
        workspaceId: workspace_id,
        sessionId: session_id,
        turnId: null,
        sandboxGroupId,
        revision: nextRevision,
        manifestKey: "m",
        treeIndexKey: "t",
        blobKeys: [] as string[],
        sizeBytes: 1,
        stats: {} as Record<string, unknown>,
      };

      // A superseded epoch (or a bogus group) writes ZERO rows → null.
      expect(
        await insertWorkspaceCapture(db, { ...args, expectedEpoch: leaseEpoch + 9999 }),
      ).toBeNull();
      expect(
        await insertWorkspaceCapture(db, {
          ...args,
          expectedEpoch: leaseEpoch,
          sandboxGroupId: "00000000-0000-0000-0000-000000000000",
        }),
      ).toBeNull();
      // The correct epoch commits and assigns the revision.
      const ok = await insertWorkspaceCapture(db, { ...args, expectedEpoch: leaseEpoch });
      expect(ok).not.toBeNull();
      expect(ok!.revision).toBe(nextRevision);
    },
    TURN_TIMEOUT * 2,
  );

  test("B5b: GC math is stable under the exact retained/evicted boundary", () => {
    // A focused check of the pure boundary the DB path relies on.
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `r${10 - i}`,
      manifestKey: `m${10 - i}`,
      treeIndexKey: `t${10 - i}`,
      blobKeys: [`b${10 - i}`],
    }));
    const plan = computeWorkspaceCaptureGcPlan(rows, 10);
    expect(plan.evictedRowIds).toEqual(["r0"]);
    expect(plan.deleteBlobKeys).toEqual(["b0"]);
  });
});
