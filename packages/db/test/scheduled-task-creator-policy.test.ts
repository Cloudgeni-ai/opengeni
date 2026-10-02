import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createScheduledTask,
  getScheduledTaskCreatorPolicy,
  updateScheduledTask,
  type CreateScheduledTaskInput,
  type Database,
  type ScheduledTaskCreatorPolicy,
  type UpdateScheduledTaskInput,
} from "../src";
import * as database from "../src/database";
import * as externalLinkTasks from "../src/external-link-work";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function taskInput(creatorPolicy?: ScheduledTaskCreatorPolicy): CreateScheduledTaskInput {
  return {
    id: taskId,
    accountId,
    workspaceId,
    name: "Policy fixture",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-task-${taskId}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "service:fixture" },
    metadata: {},
    ...(creatorPolicy ? { creatorPolicy } : {}),
  };
}

const restrictionOnly: ScheduledTaskCreatorPolicy = {
  firstPartyMcpTools: null,
  firstPartyMcpPermissions: null,
  sessionPolicy: null,
  credentialRestriction: "developer_setup",
};
const agentPolicy: ScheduledTaskCreatorPolicy = {
  firstPartyMcpTools: ["set_session_title"],
  firstPartyMcpPermissions: ["sessions:read"],
  sessionPolicy: { agentAccess: "session", scopeSubjectId: "user:fixture", memoryScope: "user" },
  credentialRestriction: "developer_setup",
};

/** Exercise real create/update/read mappers; replace only PostgreSQL/RLS I/O. */
function fixture() {
  let row: Record<string, unknown> | null = null;
  const writes: Array<Record<string, unknown>> = [];
  const statements: SQL[] = [];
  const dialect = new PgDialect();
  function apply(values: Record<string, unknown>) {
    writes.push(values);
    const decoded = { ...values };
    if (decoded.creatorSessionPolicy instanceof SQL) {
      const query = dialect.sqlToQuery(decoded.creatorSessionPolicy);
      expect(query.sql).toBe("$1::jsonb");
      decoded.creatorSessionPolicy = JSON.parse(query.params[0] as string);
    }
    if (decoded.authorityRevision instanceof SQL) {
      decoded.authorityRevision = Number(row?.authorityRevision ?? 0) + 1;
    }
    row = {
      id: taskId,
      accountId,
      workspaceId,
      authorityRevision: 1,
      executionDigest: "fixture-digest",
      createdAt: new Date("2026-10-01T12:00:00.000Z"),
      updatedAt: new Date("2026-10-01T12:00:00.000Z"),
      ...row,
      ...decoded,
    };
    return [row];
  }
  const handle = {
    execute: async (statement: SQL) => {
      statements.push(statement);
      return [];
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({ returning: async () => apply(values) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => apply(values) }),
      }),
    }),
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows = row
            ? [
                {
                  ...row,
                  ...(fields.firstPartyMcpTools
                    ? {
                        firstPartyMcpTools: row.creatorFirstPartyMcpTools,
                        firstPartyMcpPermissions: row.creatorFirstPartyMcpPermissions,
                        sessionPolicy: row.creatorSessionPolicy,
                      }
                    : {}),
                },
              ]
            : [];
          const query = Object.assign(Promise.resolve(rows), {
            for: () => query,
            limit: async () => rows,
          });
          return query;
        },
      }),
    }),
  } as unknown as Database;
  track(
    spyOn(database, "withRlsContext").mockImplementation(async (_db, _scope, run) => run(handle)),
  );
  track(
    spyOn(database, "withWorkspaceRls").mockImplementation(async (_db, _workspace, run) =>
      run(handle),
    ),
  );
  track(spyOn(externalLinkTasks, "cloneExternalLinkTaskAuthority").mockResolvedValue(undefined));
  return { db: handle, writes, statements, row: () => row! };
}

describe("scheduled task protected creator policy persistence", () => {
  test("a restriction-only snapshot uses existing JSON without selecting defaults", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput(restrictionOnly));
    expect(state.row().creatorSessionPolicy).toEqual({ credentialRestriction: "developer_setup" });
    expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual(
      restrictionOnly,
    );
  });

  test("legacy NULL snapshots and ordinary agent JSON retain their prior shape", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput());
    expect(state.row().creatorSessionPolicy).toBeNull();
    expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual({
      firstPartyMcpTools: null,
      firstPartyMcpPermissions: null,
      sessionPolicy: null,
    });
    const { credentialRestriction: _restriction, ...ordinary } = agentPolicy;
    await createScheduledTask(state.db, taskInput(ordinary));
    expect(state.row().creatorSessionPolicy).toEqual(ordinary.sessionPolicy);
    expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual(ordinary);
  });

  test("agent boundaries round-trip with the additive immutable restriction", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput(agentPolicy));
    expect(state.row().creatorSessionPolicy).toEqual({
      ...agentPolicy.sessionPolicy,
      credentialRestriction: "developer_setup",
    });
    expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual(agentPolicy);
  });

  test("forged task/agent metadata cannot create a protected restriction", async () => {
    const state = fixture();
    const input = taskInput();
    input.metadata = { credentialRestriction: "developer_setup", creatorPolicy: restrictionOnly };
    input.agentConfig.metadata = {
      turnExecutionPolicyV1: { credentialRestriction: "developer_setup" },
    };
    await createScheduledTask(state.db, input);
    expect(state.row().creatorSessionPolicy).toBeNull();
    expect(
      (await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId))?.credentialRestriction,
    ).toBeUndefined();
  });

  test("user JSON cannot strip or downgrade a marker through edits, revisions or clones", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput(agentPolicy));
    for (const revision of [
      {},
      { refreshPersonalResourceAuthority: true },
      { clonePersonalResourceAuthorityFromRevision: 1 },
    ]) {
      const attemptedEdit = {
        ...revision,
        metadata: { credentialRestriction: null, creatorPolicy: null },
        agentConfig: {
          prompt: "edited",
          resources: [],
          tools: [],
          metadata: { credentialRestriction: "none" },
        },
        creatorPolicy: null,
        creatorSessionPolicy: null,
        credentialRestriction: "none",
      };
      await updateScheduledTask(state.db, workspaceId, taskId, attemptedEdit);
      expect(state.writes.at(-1)).not.toHaveProperty("creatorSessionPolicy");
      expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual(
        agentPolicy,
      );
    }
    expect(state.row().authorityRevision).toBe(3);
    const executed = state.statements.map((statement) => dialectQuery(statement));
    expect(
      executed.some((query) => query.includes("clone_scheduled_task_revision_authority")),
    ).toBe(true);
  });

  test("owner tool refresh cannot delete the immutable restriction or session boundary", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput(agentPolicy));
    const firstParty: NonNullable<UpdateScheduledTaskInput["creatorFirstPartyPolicy"]> = {
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_create"],
      firstPartyMcpPermissions: ["scheduled_tasks:manage"],
    };
    await updateScheduledTask(state.db, workspaceId, taskId, {
      creatorFirstPartyPolicy: firstParty,
    });
    expect(state.writes.at(-1)).not.toHaveProperty("creatorSessionPolicy");
    expect(await getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).toEqual({
      ...agentPolicy,
      firstPartyMcpTools: [...firstParty.firstPartyMcpTools],
      firstPartyMcpPermissions: [...firstParty.firstPartyMcpPermissions],
    });
  });

  test("a present malformed protected restriction fails closed rather than downgrading", async () => {
    const state = fixture();
    await createScheduledTask(state.db, taskInput(restrictionOnly));
    for (const restriction of [null, "none", false]) {
      state.row().creatorSessionPolicy = { credentialRestriction: restriction };
      await expect(getScheduledTaskCreatorPolicy(state.db, workspaceId, taskId)).rejects.toThrow(
        "Malformed scheduled task credential restriction",
      );
    }
  });
});

function dialectQuery(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}
