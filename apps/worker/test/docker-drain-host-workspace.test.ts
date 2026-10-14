// Regression: every cold drain of a Docker sandbox leaked its whole
// `openai-agents-docker-sandbox-*` host workspace directory. The drain removed
// only the container; after the cold commit nothing referenced the directory
// and the next turn restored into a fresh one. A day of benchmarking leaked
// 51 such directories (72 GB).
//
// Drives the real reaper drain against PostgreSQL and a live Docker daemon:
// real SDK container, real host capture, real exact-container teardown and the
// real draining->cold commit. Opt in with OPENGENI_DOCKER_LIFECYCLE_LIVE=1.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { createDb, readLease, type Database, type DbClient } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  establishSandboxSessionFromEnvelope,
  serializeEstablishedSandboxEnvelope,
} from "@opengeni/runtime/sandbox";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const execFileAsync = promisify(execFile);
const enabled = process.env.OPENGENI_DOCKER_LIFECYCLE_LIVE === "1";
const image = process.env.OPENGENI_DOCKER_LIFECYCLE_IMAGE ?? "alpine:3";
const EPOCH = 7;

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const cleanupContainers = new Set<string>();
const cleanupRoots = new Set<string>();

beforeAll(async () => {
  if (!enabled) return;
  shared = await acquireSharedTestDatabase("worker-docker-drain-host-workspace");
  if (!shared) throw new Error("Real PostgreSQL required for the Docker drain regression");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

afterEach(async () => {
  for (const containerId of cleanupContainers) {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
  }
  cleanupContainers.clear();
  for (const root of cleanupRoots) {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  cleanupRoots.clear();
});

function services(settings: ReturnType<typeof testSettings>): () => Promise<ActivityServices> {
  return async () => ({
    settings,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(settings, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

describe("Docker drain host workspace (live daemon)", () => {
  test.skipIf(!enabled)(
    "a cold drain releases the drained host workspace, including read-only module caches",
    async () => {
      const workspaceBaseDir = await mkdtemp(join(tmpdir(), "opengeni-docker-drain-leak-"));
      cleanupRoots.add(workspaceBaseDir);
      const settings = testSettings({
        sandboxBackend: "docker",
        dockerImage: image,
        dockerWorkspaceBaseDir: workspaceBaseDir,
        sandboxOwnershipEnabled: true,
      });
      const created = await establishSandboxSessionFromEnvelope(settings, null, {
        sessionId: "docker-drain-host-workspace",
        recovery: "create-or-restore",
        backendOverride: "docker",
        environment: {},
      });
      cleanupContainers.add(created.instanceId);
      const session = created.session as {
        state: { workspaceRootPath: string };
        exec(args: { cmd: string }): Promise<{ exitCode: number; stderr: string }>;
      };
      const root = session.state.workspaceRootPath;
      expect(root.startsWith(join(workspaceBaseDir, "openai-agents-docker-sandbox-"))).toBe(true);
      // The Go toolchain writes its module cache read-only; a plain recursive
      // remove cannot unlink entries inside a mode-0555 directory.
      expect(
        await session.exec({
          cmd:
            "printf 'drained bytes' > /workspace/notes.txt && " +
            "mkdir -p /workspace/go/pkg/mod/example.com/mod@v1.0.0 && " +
            "printf 'module example.com/mod' > /workspace/go/pkg/mod/example.com/mod@v1.0.0/go.mod && " +
            "chmod -R a-w /workspace/go",
        }),
      ).toMatchObject({ exitCode: 0 });

      const envelope = await serializeEstablishedSandboxEnvelope(created);
      expect(envelope).not.toBeNull();

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('docker-drain') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'docker-drain') returning id`;
      await admin`insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const sandboxGroupId = crypto.randomUUID();
      await admin`
        insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness,
          refcount, turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          resume_backend_id, resume_state, expires_at)
        values (${account!.id}, ${workspace!.id}, ${sandboxGroupId}, 'draining', 0, 0, 0,
          ${created.instanceId}, 'docker', ${EPOCH}, 'docker',
          ${JSON.stringify(envelope)}::text::jsonb, now() - interval '1 second')`;

      const activities = createSandboxLeaseActivities(services(settings));
      const result = await activities.drainSandboxLease({
        target: {
          workspaceId: workspace!.id,
          sandboxGroupId,
          instanceId: created.instanceId,
          leaseEpoch: EPOCH,
        },
        timeoutClass: "fast",
        snapshotTimeoutMs: 60_000,
        captureTimeoutMs: 120_000,
        operationId: crypto.randomUUID(),
      });
      expect(result).toEqual({ status: "terminated" });

      const lease = await readLease(db, workspace!.id, sandboxGroupId);
      expect(lease).toMatchObject({
        liveness: "cold",
        instanceId: null,
        leaseEpoch: EPOCH + 1,
      });
      // The published archive, not the host directory, is the recovery source.
      expect(lease?.recovery.archive.status).toBe("available");
      const inspect = await execFileAsync("docker", [
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `id=${created.instanceId}`,
      ]);
      expect(inspect.stdout.trim()).toBe("");
      cleanupContainers.delete(created.instanceId);

      expect(existsSync(root)).toBe(false);
      expect(await readdir(workspaceBaseDir)).toEqual([]);
    },
    180_000,
  );
});
