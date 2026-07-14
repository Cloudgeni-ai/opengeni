import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

// Replace only the provider extension before loading @opengeni/core. The fake
// preserves create/resume/delete identity semantics but has no network access.
const live = new Map<string, { state: Record<string, unknown> }>();
const resumedIds: string[] = [];
let creates = 0;

class FakeModalSandboxClient {
  // Keep this non-"modal" so production's best-effort low-level tagger is not
  // invoked. Provider-gone is still structural via status:404.
  readonly backendId = "modal-test";

  async deserializeSessionState(state: Record<string, unknown>) {
    return { ...state };
  }

  async serializeSessionState(state: Record<string, unknown>) {
    return { ...state };
  }

  async create() {
    creates += 1;
    const sandboxId = `sb-ope13-fake-${creates}`;
    const session = {
      state: { sandboxId, manifest: { root: "/workspace", environment: {} } },
    };
    live.set(sandboxId, session);
    return session;
  }

  async resume(state: Record<string, unknown>) {
    const sandboxId = String(state.sandboxId ?? "");
    resumedIds.push(sandboxId);
    const session = live.get(sandboxId);
    if (!session) throw { status: 404, code: "SANDBOX_NOT_FOUND" };
    return session;
  }

  async delete(state: Record<string, unknown>) {
    live.delete(String(state.sandboxId ?? ""));
  }
}

const realModal = await import("@openai/agents-extensions/sandbox/modal");
mock.module("@openai/agents-extensions/sandbox/modal", () => ({
  ...realModal,
  ModalSandboxClient: FakeModalSandboxClient,
}));

const { establishNamedModalTarget } = await import("@opengeni/core");
const { createDb, createSandbox, createSession, readLease, upsertSandboxSessionEnvelope } =
  await import("@opengeni/db");
type DbClient = ReturnType<typeof createDb>;

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle heartbeat");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-modal-lifecycle");
  if (!shared) {
    available = false;
    console.warn("[core-modal-lifecycle] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
  mock.restore();
});

describe("OPE-13 target-owned Modal lifecycle (real Postgres, fake provider)", () => {
  test("N concurrent warm-NotFound callers create one replacement; restart reattaches; home envelope is never read", async () => {
    if (!available) return;
    creates = 0;
    live.clear();
    resumedIds.length = 0;

    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('ope13-core') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'ope13-core') returning id`;
    const db = client.db;
    const session = await createSession(db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "target owner",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const named = await createSandbox(db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      kind: "modal",
      name: "ope13-named",
    });
    // Poison the CALLER HOME envelope with a distinct id. A named target has no
    // right to inspect it; any fallback would show up in resumedIds.
    await upsertSandboxSessionEnvelope(db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sessionId: session.id,
      envelope: {
        backendId: "modal-test",
        sessionState: {
          providerState: { sandboxId: "sb-home-must-not-be-used" },
          workspaceReady: true,
        },
      },
    });

    const settings = testSettings({
      sandboxBackend: "modal",
      modalAppName: "ope13-fake",
      sandboxWarmingTimeoutMs: 5_000,
      sandboxLeaseTtlMs: 60_000,
      sandboxIdleGraceMs: 5_000,
    });
    const base = {
      db,
      settings,
      accountId: account!.id,
      workspaceId: workspace!.id,
      sandboxId: named.id,
      holderKind: "turn" as const,
      subjectId: session.id,
      pollIntervalMs: 5,
    };

    const first = await establishNamedModalTarget({
      ...base,
      holderId: "initial",
      heartbeatIntervalMs: 10,
    });
    const oldId = first.established.instanceId;
    expect(creates).toBe(1);
    expect(oldId).toBe("sb-ope13-fake-1");
    expect(resumedIds).not.toContain("sb-home-must-not-be-used");

    // Establishment must not stop liveness renewal. Backdate the exact lease
    // after the handle has been returned, then observe the epoch-fenced target
    // heartbeat refresh it while the holder remains owned.
    await admin`
      update sandbox_leases set expires_at = now() - interval '1 second'
      where workspace_id = ${workspace!.id} and sandbox_group_id = ${named.id}`;
    await waitUntil(async () => {
      const renewed = await readLease(db, workspace!.id, named.id);
      return Boolean(renewed && renewed.expiresAt.getTime() > Date.now() + 30_000);
    });
    // A persistent viewer attach transfers heartbeat responsibility to the
    // client. Stopping the operation-owned timer must leave the holder intact
    // while allowing a missing client heartbeat to become stale.
    first.stopAutomaticHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await admin`
      update sandbox_leases set expires_at = now() - interval '1 second'
      where workspace_id = ${workspace!.id} and sandbox_group_id = ${named.id}`;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect((await readLease(db, workspace!.id, named.id))?.expiresAt.getTime()).toBeLessThan(
      Date.now(),
    );
    await first.release();

    // Provider kills the exact old box while its target-owned lease stays warm.
    live.delete(oldId);
    const concurrent = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        establishNamedModalTarget({ ...base, holderId: `restore-${index}` }),
      ),
    );
    const replacementIds = new Set(concurrent.map((result) => result.established.instanceId));
    expect(replacementIds.size).toBe(1);
    expect(replacementIds.has(oldId)).toBe(false);
    expect(creates).toBe(2); // initial + exactly ONE replacement
    const lease = await readLease(db, workspace!.id, named.id);
    expect(lease?.instanceId).toBe([...replacementIds][0]);
    expect(lease?.leaseEpoch).toBe(2);
    expect(resumedIds).not.toContain("sb-home-must-not-be-used");
    await Promise.all(concurrent.map((result) => result.release()));

    // A fresh construction context (worker/API restart: no in-memory lifecycle
    // cache) reattaches to the same target lease and does not create again.
    const restartedClient = createDb(shared!.appUrl);
    try {
      const restarted = await establishNamedModalTarget({
        ...base,
        db: restartedClient.db,
        holderId: "after-restart",
      });
      expect(restarted.established.instanceId).toBe([...replacementIds][0]);
      expect(creates).toBe(2);
      await restarted.release();
    } finally {
      await restartedClient.close();
    }

    // Exact fake-provider cleanup; no ambient/global resource sweep.
    for (const id of replacementIds) live.delete(id);
    expect(live.size).toBe(0);
  }, 60_000);
});
