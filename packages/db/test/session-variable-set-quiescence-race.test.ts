import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createVariableSet,
  submitHumanPromptInTransaction,
  updateSessionVariableSets,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-variable-set-quiescence-race");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function waitForBlockedBackend(blockerPid: number, description: string): Promise<number> {
  if (!shared) throw new Error("database unavailable");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<Array<{ pid: number }>>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.usename = 'opengeni_app'
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
    await Bun.sleep(10);
  }
  throw new Error(`${description} did not block behind backend ${blockerPid}`);
}

async function fixture(label: string) {
  if (!client) throw new Error("database unavailable");
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${label}-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-variable-set-quiescence-race",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: `Variable Set race ${label}`,
    workspaceExternalSource: "session-variable-set-quiescence-race",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: `Variable Set race ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: `race ${label}`,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  const variableSet = await createVariableSet(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: `race-${label}-${suffix}`,
  });
  return { grant, session, subjectId, variableSet };
}

async function submitPrompt(
  db: Database,
  value: Awaited<ReturnType<typeof fixture>>,
  holdOpen?: { admitted: (backendPid: number) => void; release: Promise<void> },
): Promise<void> {
  await withWorkspaceSubjectSessionActivityRls(
    db,
    value.grant.workspaceId,
    value.subjectId,
    async (scoped) => {
      await submitHumanPromptInTransaction(scoped, {
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId,
        sessionId: value.session.id,
        subjectId: value.subjectId,
        actor: { type: "human", subjectId: value.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "credential-consuming accepted work",
        resources: [],
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        reasoningEffortFallback: "low",
        source: "user",
      });
      if (holdOpen) {
        const [backend] = await scoped.execute<{ backendPid: number }>(
          sql`select pg_backend_pid()::integer as "backendPid"`,
        );
        if (!backend) throw new Error("prompt admission backend is unavailable");
        holdOpen.admitted(backend.backendPid);
        await holdOpen.release;
      }
    },
  );
}

function replaceSelection(db: Database, value: Awaited<ReturnType<typeof fixture>>) {
  return updateSessionVariableSets(db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    subjectId: value.subjectId,
    variableSets: [
      {
        id: value.variableSet.id,
        name: value.variableSet.name,
        scope: value.variableSet.scope,
      },
    ],
  });
}

describe("post-start session Variable Set quiescence races", () => {
  test("waits for an accepted admission transaction and then rejects the stale mutation", async () => {
    if (!shared || !client) return;
    const value = await fixture("admission-first");
    const admissionClient = createDb(shared.appUrl, { max: 1 });
    const mutationClient = createDb(shared.appUrl, { max: 1 });
    const admitted = deferred<number>();
    const releaseAdmission = deferred();
    let admission: Promise<void> | null = null;
    let mutation: ReturnType<typeof replaceSelection> | null = null;
    try {
      admission = submitPrompt(admissionClient.db, value, {
        admitted: admitted.resolve,
        release: releaseAdmission.promise,
      });
      const admissionPid = await admitted.promise;

      mutation = replaceSelection(mutationClient.db, value);
      try {
        expect(await waitForBlockedBackend(admissionPid, "Variable Set mutation")).toBeGreaterThan(
          0,
        );
      } finally {
        releaseAdmission.resolve();
      }
      await admission;
      expect(await mutation).toEqual({ status: "blocked", reason: "turn_in_flight" });

      const [state] = await shared.admin<
        Array<{ variableSetIds: string[]; eventCount: number; auditCount: number }>
      >`
        select session_value.variable_set_ids as "variableSetIds",
          (select count(*)::int from session_events event_value
            where event_value.workspace_id = ${value.grant.workspaceId}
              and event_value.session_id = ${value.session.id}
              and event_value.type = 'session.variable_sets.updated') as "eventCount",
          (select count(*)::int from audit_events audit_value
            where audit_value.workspace_id = ${value.grant.workspaceId}
              and audit_value.target_id = ${value.session.id}
              and audit_value.action like 'session.variable_set%') as "auditCount"
        from sessions session_value
        where session_value.workspace_id = ${value.grant.workspaceId}
          and session_value.id = ${value.session.id}
      `;
      expect(state).toEqual({ variableSetIds: [], eventCount: 0, auditCount: 0 });
    } finally {
      releaseAdmission.resolve();
      await Promise.allSettled([
        ...(admission ? [admission] : []),
        ...(mutation ? [mutation] : []),
      ]);
      await admissionClient.close();
      await mutationClient.close();
    }
  });

  test("holds prompt admission until the audited replacement commits", async () => {
    if (!shared || !client) return;
    const value = await fixture("mutation-first");
    const mutationClient = createDb(shared.appUrl, { max: 1 });
    const admissionClient = createDb(shared.appUrl, { max: 1 });
    const blockerReady = deferred<number>();
    const releaseLeaseAdmission = deferred();
    let blocker: Promise<unknown> | null = null;
    let mutation: ReturnType<typeof replaceSelection> | null = null;
    let admission: Promise<void> | null = null;
    try {
      const leaseAdmissionKey = `sandbox-lease-admission:${value.grant.workspaceId}:${value.session.sandboxGroupId}`;
      blocker = shared.admin.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
        if (!backend) throw new Error("sandbox admission blocker backend is unavailable");
        await tx`select pg_advisory_xact_lock(hashtextextended(${leaseAdmissionKey}, 0))`;
        blockerReady.resolve(backend.pid);
        await releaseLeaseAdmission.promise;
      });
      const blockerPid = await blockerReady.promise;

      mutation = replaceSelection(mutationClient.db, value);
      const mutationPid = await waitForBlockedBackend(blockerPid, "Variable Set mutation");
      admission = submitPrompt(admissionClient.db, value);
      try {
        expect(await waitForBlockedBackend(mutationPid, "prompt admission")).toBeGreaterThan(0);
      } finally {
        releaseLeaseAdmission.resolve();
      }
      expect(await mutation).toMatchObject({ status: "updated" });
      await admission;

      const [state] = await shared.admin<
        Array<{
          variableSetIds: string[];
          queuedTurns: number;
          eventCount: number;
          auditCount: number;
        }>
      >`
        select session_value.variable_set_ids as "variableSetIds",
          (select count(*)::int from session_turns turn_value
            where turn_value.workspace_id = ${value.grant.workspaceId}
              and turn_value.session_id = ${value.session.id}
              and turn_value.status = 'queued') as "queuedTurns",
          (select count(*)::int from session_events event_value
            where event_value.workspace_id = ${value.grant.workspaceId}
              and event_value.session_id = ${value.session.id}
              and event_value.type = 'session.variable_sets.updated') as "eventCount",
          (select count(*)::int from audit_events audit_value
            where audit_value.workspace_id = ${value.grant.workspaceId}
              and audit_value.target_id = ${value.session.id}
              and audit_value.action = 'session.variable_set.attached') as "auditCount"
        from sessions session_value
        where session_value.workspace_id = ${value.grant.workspaceId}
          and session_value.id = ${value.session.id}
      `;
      expect(state).toEqual({
        variableSetIds: [value.variableSet.id],
        queuedTurns: 1,
        eventCount: 1,
        auditCount: 1,
      });
    } finally {
      releaseLeaseAdmission.resolve();
      await Promise.allSettled([
        ...(blocker ? [blocker] : []),
        ...(mutation ? [mutation] : []),
        ...(admission ? [admission] : []),
      ]);
      await mutationClient.close();
      await admissionClient.close();
    }
  });
});
