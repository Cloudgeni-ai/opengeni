import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
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
    const admitted = deferred();
    const releaseAdmission = deferred();
    try {
      const admission = admissionClient.db.transaction(async (rawTx) => {
        await submitPrompt(rawTx as unknown as Database, value);
        admitted.resolve();
        await releaseAdmission.promise;
      });
      await admitted.promise;

      let mutationSettled = false;
      const mutation = replaceSelection(mutationClient.db, value).then(
        (result) => {
          mutationSettled = true;
          return result;
        },
        (error) => {
          mutationSettled = true;
          throw error;
        },
      );
      try {
        await Bun.sleep(50);
        expect(mutationSettled).toBe(false);
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
      await admissionClient.close();
      await mutationClient.close();
    }
  });

  test("holds prompt admission until the audited replacement commits", async () => {
    if (!shared || !client) return;
    const value = await fixture("mutation-first");
    const mutationClient = createDb(shared.appUrl, { max: 1 });
    const admissionClient = createDb(shared.appUrl, { max: 1 });
    const mutated = deferred();
    const releaseMutation = deferred();
    try {
      const mutation = mutationClient.db.transaction(async (rawTx) => {
        const result = await replaceSelection(rawTx as unknown as Database, value);
        mutated.resolve();
        await releaseMutation.promise;
        return result;
      });
      await mutated.promise;

      let admissionSettled = false;
      const admission = submitPrompt(admissionClient.db, value).then(
        () => {
          admissionSettled = true;
        },
        (error) => {
          admissionSettled = true;
          throw error;
        },
      );
      try {
        await Bun.sleep(50);
        expect(admissionSettled).toBe(false);
      } finally {
        releaseMutation.resolve();
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
      releaseMutation.resolve();
      await mutationClient.close();
      await admissionClient.close();
    }
  });
});
