import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signDelegatedAccessToken, TurnExecutionPolicyV1 } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  databaseUrlPassword,
  initializeSessionStartAtomically,
  sessionListChangesFor,
  type DatabaseCredentialEvent,
  type DatabasePasswordFiles,
  type DbClient,
  type SessionListNotification,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { waitFor } from "@opengeni/testing/process";
import type { Pool } from "pg";
import { createAppComposition } from "../src/app";
import { createManagedAuthDatabasePool } from "../src/auth/managed-auth";

// Regression for the staging incident where rotating the runtime login's
// password while pods ran failed 25 turns: every pool opens new connections
// all the time, and the password was fixed in the URL at process start.
//
// Real PostgreSQL. Continuous traffic (API requests, session event
// persistence, turn admission, a managed-auth `pg` pool and the session-list
// LISTEN connection) keeps running through the documented rotation with
// mounted password files, without any restart:
//   1. the Secret update gives previous = old and current = new (the files are
//      swapped the way kubelet does it: one atomic symlink switch);
//   2. ALTER ROLE to the new password: each pool takes one 28P01, then sticks;
//   3. previous is cleared.
// No operation may fail and no request may return 500.
//
// This file runs ALTER ROLE on the cluster-wide opengeni_app role, so the unit
// shard runner schedules it alone; the original password is restored at the end.

const SECRET = "database-password-rotation-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(180_000);

let available = true;
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-database-password-rotation");
  if (!shared && requireRealDatabase) {
    throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
  }
  available = shared !== null;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

/** Per-pool credential events (content-free: indexes and counts only). */
class CredentialTally {
  readonly events: Array<{ pool: string; event: DatabaseCredentialEvent }> = [];

  listener(pool: string) {
    return (event: DatabaseCredentialEvent, connection?: "pool" | "notifications") =>
      this.events.push({ pool: connection === "notifications" ? `${pool}-listen` : pool, event });
  }

  count(type: DatabaseCredentialEvent["type"]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { pool, event } of this.events) {
      if (event.type === type) counts[pool] = (counts[pool] ?? 0) + 1;
    }
    return counts;
  }
}

function policy() {
  return TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: "codex/gpt-5.6-sol",
    requestedModelId: "codex/gpt-5.6-sol",
    modelSource: "explicit",
    reasoningEffort: "medium",
    reasoningSource: "explicit",
    providerId: "codex-subscription",
    upstreamModelId: "gpt-5.6-sol",
    wireApi: "responses",
    credentialSource: { kind: "connected_subscription", provider: "codex" },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
    definitionVersion: `sha256:${"c".repeat(64)}`,
  });
}

const randomPassword = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * A Secret volume as kubelet lays it out: each key is a symlink through
 * `..data`, which points at a timestamped directory and is switched
 * atomically when the Secret changes, so readers never see half a write.
 */
async function secretVolume(root: string) {
  let version = 0;
  const update = async (keys: Record<string, string>) => {
    version += 1;
    const directory = join(root, `..v${version}`);
    await mkdir(directory);
    for (const [key, value] of Object.entries(keys)) await writeFile(join(directory, key), value);
    await symlink(`..v${version}`, join(root, "..data_tmp"));
    await rename(join(root, "..data_tmp"), join(root, "..data"));
  };
  await update({});
  for (const key of ["password", "previous-password"]) {
    await symlink(join("..data", key), join(root, key));
  }
  const files: DatabasePasswordFiles = {
    currentPasswordFile: join(root, "password"),
    previousPasswordFile: join(root, "previous-password"),
  };
  return { files, update };
}

describe("runtime database password rotation", () => {
  test("traffic sees no failure through the password-file rotation", async () => {
    if (!available) return;
    const admin = shared!.admin;
    const originalPassword = databaseUrlPassword(shared!.appUrl);
    const rotated = randomPassword();
    const volumeRoot = await mkdtemp(join(tmpdir(), "opengeni-password-rotation-"));
    // Optional keys absent at first: the pools use the URL password.
    const volume = await secretVolume(volumeRoot);
    const tally = new CredentialTally();
    // Short timers so every pool keeps opening new connections, as in
    // production (30 s idle timeout, 600 s maximum lifetime) but faster.
    const churn = { idleTimeoutSeconds: 1, maxLifetimeSeconds: 2 } as const;

    const failures: Array<{ lane: string; error: unknown }> = [];
    const statuses = new Map<string, number>();
    const completed = new Map<string, number>();
    const done = (lane: string) => completed.set(lane, (completed.get(lane) ?? 0) + 1);
    const load = { running: true };
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onEscape);
    process.on("uncaughtException", onEscape);

    const noop = async () => undefined;
    const workflowClient = {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient;

    /** Every runtime pool of an api and a worker pod, on the mounted files. */
    type Generation = {
      name: string;
      api: DbClient;
      persistence: DbClient;
      admission: DbClient;
      managedAuth: Pool;
      app: ReturnType<typeof createAppComposition>["app"];
      listenEvents: SessionListNotification["type"][];
      unsubscribe: () => void;
      inflight: number;
    };
    const generations: Generation[] = [];
    const startGeneration = async (name: string, url: string): Promise<Generation> => {
      const next = { passwordFiles: volume.files };
      const api = createDb(url, {
        max: 4,
        ...churn,
        notificationDatabaseUrl: url,
        ...next,
        onCredentialEvent: tally.listener(`${name}:api`),
      });
      const persistence = createDb(url, {
        max: 2,
        ...churn,
        ...next,
        onCredentialEvent: tally.listener(`${name}:persistence`),
      });
      const admission = createDb(url, {
        max: 1,
        ...churn,
        ...next,
        onCredentialEvent: tally.listener(`${name}:admission`),
      });
      const managedAuth = createManagedAuthDatabasePool(
        url,
        { warn: () => undefined, incrementCounter: () => undefined } as never,
        volume.files,
        tally.listener(`${name}:managed-auth`),
      );
      const listenEvents: SessionListNotification["type"][] = [];
      // Connection state only; change hints from the traffic are not needed.
      const unsubscribe = sessionListChangesFor(api.db)!.subscribe((event) => {
        if (event.type !== "change") listenEvents.push(event.type);
      });
      const { app } = createAppComposition({
        settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
        db: api.db,
        bus: new MemoryEventBus(),
        workflowClient,
      });
      const generation: Generation = {
        name,
        api,
        persistence,
        admission,
        managedAuth,
        app,
        listenEvents,
        unsubscribe,
        inflight: 0,
      };
      generations.push(generation);
      await waitFor(async () => listenEvents.at(-1) === "connected", {
        timeoutMs: 15_000,
        intervalMs: 20,
      });
      return generation;
    };
    const closeGeneration = async (generation: Generation) => {
      generation.unsubscribe();
      await Promise.allSettled([
        generation.api.close(),
        generation.persistence.close(),
        generation.admission.close(),
        generation.managedAuth.end(),
      ]);
    };
    let current: Generation | undefined;

    try {
      current = await startGeneration("g1", shared!.appUrl);

      // Fixture: one workspace for API traffic and turn admission.
      const suffix = crypto.randomUUID();
      const subjectId = `user:${suffix}`;
      const access = await bootstrapWorkspace(current.api.db, {
        accountExternalSource: "password-rotation-test",
        accountExternalId: `account-${suffix}`,
        accountName: "Password rotation",
        workspaceExternalSource: "password-rotation-test",
        workspaceExternalId: `workspace-${suffix}`,
        workspaceName: "Password rotation",
        subjectId,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;
      const headers = {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          permissions: ["sessions:read", "sessions:create", "workspace:admin"],
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 3_600,
        })}`,
        "content-type": "application/json",
      };

      const newSession = async (db: DbClient["db"], label: string) => {
        const session = await createSession(db, {
          accountId: grant.accountId,
          workspaceId,
          initialMessage: `rotation ${label}`,
          resources: [],
          metadata: {},
          model: "codex/gpt-5.6-sol",
          reasoningEffort: "medium" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId },
        });
        const started = await initializeSessionStartAtomically(db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          reasoningEffortFallback: "medium",
          turnExecutionPolicy: policy(),
          surface: null,
          createdEventPayload: {},
          goal: null,
        });
        if (!started.turn) throw new Error("session did not create an initial turn");
        return session;
      };
      const historySession = await newSession(current.persistence.db, "history");

      const lane = (name: string, body: (generation: Generation) => Promise<void>) =>
        (async () => {
          while (load.running) {
            const generation = current!;
            generation.inflight += 1;
            try {
              await body(generation);
              done(name);
            } catch (error) {
              failures.push({ lane: name, error });
            } finally {
              generation.inflight -= 1;
            }
          }
        })();

      // One writer (it owns the draft revision) and three readers.
      let draftRevision = 0;
      const api = (index: number) =>
        lane(`api-${index}`, async ({ app }) => {
          const write = index === 0;
          const path = index % 2 === 0 ? "new-session-draft" : "sessions";
          const response = await app.request(`http://x/v1/workspaces/${workspaceId}/${path}`, {
            headers,
            ...(write
              ? {
                  method: "PUT",
                  body: JSON.stringify({
                    expectedRevision: draftRevision,
                    text: `draft ${crypto.randomUUID()}`,
                    resources: [],
                    tools: [],
                    model: "gpt-5.6-sol",
                    reasoningEffort: "high",
                    latencyMode: "priority",
                    selectedProjectChannelId: null,
                    options: {},
                  }),
                }
              : {}),
          });
          const key = `${write ? "PUT" : "GET"} ${path} ${response.status}`;
          statuses.set(key, (statuses.get(key) ?? 0) + 1);
          const body = await response.text();
          if (response.status >= 400) throw new Error(`${key}: ${body.slice(0, 300)}`);
          if (write) draftRevision = (JSON.parse(body) as { revision: number }).revision;
        });
      // Session history appends: runIdempotentPersistenceTransaction inside.
      const persistence = (index: number) =>
        lane(`persistence-${index}`, async ({ persistence: client }) => {
          await appendSessionEvents(client.db, workspaceId, historySession.id, [
            { type: "agent.model.usage", payload: {} },
          ]);
        });
      // Turn admission: start, claim, turn.started, settle.
      const admission = lane("admission", async ({ admission: client }) => {
        const session = await newSession(client.db, "admission");
        const attemptId = crypto.randomUUID();
        const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
          sessionId: session.id,
          workflowId: `session-${session.id}`,
          workflowRunId: crypto.randomUUID(),
          attemptId,
          dispatchId: `dispatch-${crypto.randomUUID()}`,
          trigger: { kind: "next" },
        });
        if (claimed.action !== "claimed") throw new Error(`claim: ${claimed.action}`);
        await appendSessionEvents(client.db, workspaceId, session.id, [
          { type: "turn.started", payload: {}, turnId: claimed.turn.id },
        ]);
        const settled = await applySessionTurnSettlement(client.db, workspaceId, {
          sessionId: session.id,
          turnId: claimed.turn.id,
          triggerEventId: claimed.turn.triggerEventId,
          attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [{ type: "turn.completed", payload: { reason: "rotation-test" } }],
        });
        if (settled.action !== "settled") throw new Error(`settle: ${settled.action}`);
      });
      // Managed auth (Better Auth's `pg` pool): a fresh connection every time.
      const managedAuth = lane("managed-auth", async ({ managedAuth: pool }) => {
        const connection = await pool.connect();
        try {
          await connection.query("select 1");
        } finally {
          connection.release(true);
        }
        await pool.query("select 1");
      });

      // Restart the LISTEN connection (it never recycles by itself) and wait
      // until it is listening again with whatever password is valid now.
      const restartListener = async (generation: Generation) => {
        const before = generation.listenEvents.length;
        await admin`
          select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and usename = 'opengeni_app'
            and query = 'select current_schema() as schema'`;
        await waitFor(async () => generation.listenEvents.slice(before).includes("disconnected"), {
          timeoutMs: 5_000,
          intervalMs: 20,
        });
        await waitFor(async () => generation.listenEvents.at(-1) === "connected", {
          timeoutMs: 10_000,
          intervalMs: 20,
        });
      };

      const lanes = [
        api(0),
        api(1),
        api(2),
        api(3),
        persistence(0),
        persistence(1),
        admission,
        managedAuth,
      ];
      const pools = ["api", "api-listen", "persistence", "admission", "managed-auth"];

      // Files absent: the URL password, exactly as without the feature.
      await Bun.sleep(1_500);
      expect(tally.events).toEqual([]);

      // 1. The Secret gets previous = old and current = new. Every pool re-reads
      //    the files on its next connection attempt; the old password is tried
      //    first and still works, so nothing is refused.
      await volume.update({
        "previous-password": `${originalPassword}\n`,
        password: `${rotated}\n`,
      });
      await Bun.sleep(2_500);
      await restartListener(current);
      expect(tally.count("candidate_refused")).toEqual({});
      expect(tally.count("candidate_switched")).toEqual({});
      expect(failures).toEqual([]);

      // 2. ALTER ROLE. Each pool is refused once, switches and sticks.
      await admin.unsafe(`alter role opengeni_app password '${rotated}'`);
      // Every pooled connection recycles several times on the new password.
      await Bun.sleep(5_000);
      await restartListener(current);
      const switches = tally.count("candidate_switched");
      const refusals = tally.count("candidate_refused");
      console.info("[rotation-test] 28P01 per pool", JSON.stringify({ switches, refusals }));
      for (const pool of pools) {
        expect(switches[`g1:${pool}`]).toBe(1);
        expect(refusals[`g1:${pool}`]).toBeGreaterThanOrEqual(1);
      }
      // A pool that opens one connection at a time meets the old password
      // once. A pool may see one refusal per connection that was already
      // authenticating with it when the first refusal arrived.
      expect(refusals["g1:admission"]).toBe(1);
      expect(refusals["g1:api-listen"]).toBe(1);
      expect(refusals["g1:managed-auth"]).toBe(1);
      expect(refusals["g1:persistence"]).toBeLessThanOrEqual(2);
      expect(refusals["g1:api"]).toBeLessThanOrEqual(4);
      expect(tally.count("candidates_exhausted")).toEqual({});
      expect(failures).toEqual([]);

      // 3. Previous is cleared: the only candidate is the new password, which
      //    every pool already uses, so nothing is refused or switched.
      const before = tally.events.length;
      await volume.update({ password: `${rotated}\n` });
      await Bun.sleep(2_500);
      await restartListener(current);
      const afterClear = tally.events.slice(before).map(({ event }) => event.type);
      expect(afterClear.filter((type) => type !== "candidates_reloaded")).toEqual([]);

      load.running = false;
      await Promise.all(lanes);
    } finally {
      load.running = false;
      // Restore the shared role's password for every later test.
      await admin.unsafe(`alter role opengeni_app password '${originalPassword}'`);
      await Promise.allSettled(generations.map(closeGeneration));
      await rm(volumeRoot, { recursive: true, force: true });
      process.off("unhandledRejection", onEscape);
      process.off("uncaughtException", onEscape);
    }

    console.info(
      "[rotation-test] completed operations",
      JSON.stringify({
        completed: Object.fromEntries(completed),
        statuses: Object.fromEntries(statuses),
      }),
    );
    expect(failures).toEqual([]);
    expect(escaped).toEqual([]);
    for (const [key] of statuses) expect(key).toMatch(/ 200$/);
    // Every lane kept making progress throughout.
    for (const name of [
      "api-0",
      "api-1",
      "api-2",
      "api-3",
      "persistence-0",
      "persistence-1",
      "admission",
      "managed-auth",
    ]) {
      expect(completed.get(name) ?? 0).toBeGreaterThan(5);
    }
    // Content-free: no event carries a password.
    const serialized = JSON.stringify(tally.events);
    expect(serialized).not.toContain(originalPassword);
    expect(serialized).not.toContain(rotated);
  });
});
