import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

import {
  createDb,
  currentSessionRlsActorIdentityKey,
  rawRows,
  withRlsContext,
  withSessionRlsActorContext,
  withWorkspaceSubjectRls,
  type Database,
} from "../src/database";
import { bootstrapWorkspace } from "../src/index";

type Scope = {
  accountId: string;
  workspaceId: string | null;
  subjectId: string | null;
  privateFileOwner: string | null;
  initiatingHuman: string | null;
  resourceHuman: string | null;
  resourceActor: string | null;
};

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("nested-rls-context");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  await shared.admin`
    create table rls_context_scope_rows (
      label text not null,
      account_id text not null,
      workspace_id text,
      subject_id text,
      private_file_owner text,
      initiating_human text,
      resource_human text,
      resource_actor text
    )`;
  await shared.admin`alter table rls_context_scope_rows enable row level security`;
  await shared.admin`alter table rls_context_scope_rows force row level security`;
  await shared.admin`
    create policy exact_scope on rls_context_scope_rows for select using (
      account_id = nullif(current_setting('opengeni.account_id', true), '')
      and workspace_id is not distinct from nullif(current_setting('opengeni.workspace_id', true), '')
      and subject_id is not distinct from nullif(current_setting('opengeni.subject_id', true), '')
      and private_file_owner is not distinct from nullif(current_setting('opengeni.private_file_owner', true), '')
      and initiating_human is not distinct from nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
      and resource_human is not distinct from nullif(current_setting('opengeni.personal_resource_human_subject_id', true), '')
      and resource_actor is not distinct from nullif(current_setting('opengeni.personal_resource_actor_subject_id', true), '')
    )`;
  await shared.admin`grant select on rls_context_scope_rows to opengeni_app`;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function scope(): Scope {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: crypto.randomUUID(),
    privateFileOwner: crypto.randomUUID(),
    initiatingHuman: crypto.randomUUID(),
    resourceHuman: crypto.randomUUID(),
    resourceActor: crypto.randomUUID(),
  };
}

async function withActor<T>(settings: Scope, fn: () => Promise<T>): Promise<T> {
  if (settings.subjectId === null) return await fn();
  return await withSessionRlsActorContext(
    {
      subjectId: settings.subjectId,
      privateFileOwnerSubjectId: settings.privateFileOwner,
      initiatingHumanSubjectId: settings.initiatingHuman,
    },
    fn,
  );
}

async function setResourceProof(db: Database, settings: Scope): Promise<void> {
  // Exercise caller-established proof without introducing another actor API.
  await db.execute(sql`select
    set_config('opengeni.personal_resource_human_subject_id', ${settings.resourceHuman ?? ""}, true),
    set_config('opengeni.personal_resource_actor_subject_id', ${settings.resourceActor ?? ""}, true)`);
}

async function readScope(db: Database): Promise<Scope | undefined> {
  const [settings] = await rawRows<Scope>(
    db,
    sql`select
      nullif(current_setting('opengeni.account_id', true), '') as "accountId",
      nullif(current_setting('opengeni.workspace_id', true), '') as "workspaceId",
      nullif(current_setting('opengeni.subject_id', true), '') as "subjectId",
      nullif(current_setting('opengeni.private_file_owner', true), '') as "privateFileOwner",
      nullif(current_setting('opengeni.initiating_human_subject_id', true), '') as "initiatingHuman",
      nullif(current_setting('opengeni.personal_resource_human_subject_id', true), '') as "resourceHuman",
      nullif(current_setting('opengeni.personal_resource_actor_subject_id', true), '') as "resourceActor"`,
  );
  return settings;
}

async function seed(settings: Scope, label: string): Promise<void> {
  await shared.admin`
    insert into rls_context_scope_rows values (
      ${label}, ${settings.accountId}, ${settings.workspaceId}, ${settings.subjectId},
      ${settings.privateFileOwner}, ${settings.initiatingHuman},
      ${settings.resourceHuman}, ${settings.resourceActor}
    )`;
}

async function expectScope(db: Database, settings: Scope, label: string): Promise<void> {
  expect(await readScope(db)).toEqual(settings);
  const rows = await rawRows<{ label: string }>(
    db,
    sql`select label from rls_context_scope_rows order by label`,
  );
  expect(rows).toEqual([{ label }]);
}

describe("nested RLS actor restoration on PostgreSQL", () => {
  test("executes under a non-owner role with forced RLS and no bypass", async () => {
    const [posture] = await rawRows<{
      superuser: boolean;
      bypassRls: boolean;
      ownsTable: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(
      client.db,
      sql`select
        role.rolsuper as superuser,
        role.rolbypassrls as "bypassRls",
        relation.relowner = role.oid as "ownsTable",
        relation.relrowsecurity as "rlsEnabled",
        relation.relforcerowsecurity as "rlsForced"
      from pg_roles role, pg_class relation
      where role.rolname = current_user
        and relation.oid = 'rls_context_scope_rows'::regclass`,
    );
    expect(posture).toEqual({
      superuser: false,
      bypassRls: false,
      ownsTable: false,
      rlsEnabled: true,
      rlsForced: true,
    });
  });

  test.each(["same tenant", "different tenant"] as const)(
    "successful A to B to A restores proof and ALS identity in the %s",
    async (tenant) => {
      const outerScope = scope();
      const innerScope = {
        ...scope(),
        ...(tenant === "same tenant"
          ? { accountId: outerScope.accountId, workspaceId: outerScope.workspaceId }
          : {}),
      };
      await seed(outerScope, "outer");
      await seed(innerScope, "inner");
      await withActor(outerScope, async () => {
        const outerIdentity = currentSessionRlsActorIdentityKey();
        await withRlsContext(client.db, outerScope, async (outer) => {
          await setResourceProof(outer, outerScope);
          await expectScope(outer, outerScope, "outer");
          const result = await withActor(innerScope, async () => {
            expect(currentSessionRlsActorIdentityKey()).not.toBe(outerIdentity);
            return await withRlsContext(outer, innerScope, async (inner) => {
              await setResourceProof(inner, innerScope);
              await expectScope(inner, innerScope, "inner");
              return "nested result";
            });
          });
          expect(result).toBe("nested result");
          expect(currentSessionRlsActorIdentityKey()).toBe(outerIdentity);
          await expectScope(outer, outerScope, "outer");
        });
      });
      expect(currentSessionRlsActorIdentityKey()).toBeNull();
    },
  );

  test.each(["absent actor", "absent human proof"] as const)(
    "successful inner proof cannot survive an outer scope with %s",
    async (variant) => {
      const outerScope = {
        ...scope(),
        workspaceId: null,
        subjectId: variant === "absent actor" ? null : crypto.randomUUID(),
        privateFileOwner: null,
        initiatingHuman: null,
        resourceHuman: null,
        resourceActor: null,
      };
      const innerScope = scope();
      await seed(outerScope, "outer");
      await seed(innerScope, "inner");
      await withActor(outerScope, async () => {
        const outerIdentity = currentSessionRlsActorIdentityKey();
        await withRlsContext(client.db, outerScope, async (outer) => {
          // No outer personal-resource proof may be inherited from the inner scope.
          await expectScope(outer, outerScope, "outer");
          await withActor(innerScope, async () => {
            await withRlsContext(outer, innerScope, async (inner) => {
              await setResourceProof(inner, innerScope);
              await expectScope(inner, innerScope, "inner");
            });
          });
          expect(currentSessionRlsActorIdentityKey()).toBe(outerIdentity);
          await expectScope(outer, outerScope, "outer");
        });
      });
    },
  );

  test.each(["callback", "statement"] as const)(
    "%s failure rolls back inner proof and leaves the outer transaction usable",
    async (failure) => {
      const outerScope = scope();
      const innerScope = scope();
      await seed(outerScope, "outer");
      await seed(innerScope, "inner");
      await withActor(outerScope, async () => {
        const outerIdentity = currentSessionRlsActorIdentityKey();
        await withRlsContext(client.db, outerScope, async (outer) => {
          await setResourceProof(outer, outerScope);
          const operation = withActor(innerScope, async () => {
            await withRlsContext(outer, innerScope, async (inner) => {
              await setResourceProof(inner, innerScope);
              await expectScope(inner, innerScope, "inner");
              if (failure === "callback") throw new Error("nested callback failed");
              await inner.execute(sql`select 1 / 0`);
            });
          });
          if (failure === "callback") {
            await expect(operation).rejects.toThrow("nested callback failed");
          } else {
            await expect(operation).rejects.toMatchObject({ cause: { code: "22012" } });
          }
          expect(currentSessionRlsActorIdentityKey()).toBe(outerIdentity);
          await expectScope(outer, outerScope, "outer");
        });
      });
    },
  );

  test("writer and protocol capabilities remain transaction-wide after successful release", async () => {
    const innerScope = scope();
    await client.db.transaction(async (tx) => {
      const outer = tx as unknown as Database;
      await withActor(innerScope, async () => {
        await withRlsContext(outer, innerScope, async () => undefined);
      });
      const [capabilities] = await rawRows<Record<string, string>>(
        outer,
        sql`select
          current_setting('opengeni.lossless_content_writer', true) as writer,
          current_setting('opengeni.sandbox_recovery_protocol_v2', true) as recovery,
          current_setting('opengeni.pending_tool_event_output_v1', true) as output,
          current_setting('opengeni.session_variable_set_attachments_v1', true) as attachments`,
      );
      expect(capabilities).toEqual({ writer: "1", recovery: "1", output: "1", attachments: "1" });
    });
  });
});

describe("batched RLS setup on PostgreSQL", () => {
  function captureStatements(): { statements: string[]; stop: () => void } {
    const driver = (client.db as unknown as { $client: { options: { debug?: unknown } } }).$client;
    const statements: string[] = [];
    const previous = driver.options.debug;
    driver.options.debug = (_connection: number, query: string) => {
      statements.push(query.replace(/\s+/gu, " ").trim());
    };
    return { statements, stop: () => (driver.options.debug = previous) };
  }

  test("an actor-scoped workspace transaction sets up in two statements and holds the tenancy fence", async () => {
    const settings = scope();
    await seed({ ...settings, resourceHuman: null, resourceActor: null }, "batched");
    const capture = captureStatements();
    let callbackStart = 0;
    try {
      await withActor(settings, async () => {
        await withRlsContext(client.db, settings, async (scoped) => {
          callbackStart = capture.statements.length;
          // Every tenant and actor GUC is live and policy-effective.
          await expectScope(
            scoped,
            { ...settings, resourceHuman: null, resourceActor: null },
            "batched",
          );
          const [fence] = await rawRows<{ held: boolean }>(
            scoped,
            sql`with fence as (
              select hashtextextended(${`session-tenancy:${settings.workspaceId}`}, 0) as lock_key
            )
            select exists (
              select 1 from pg_locks held, fence
              where held.locktype = 'advisory'
                and held.pid = pg_backend_pid()
                and held.granted
                and held.mode = 'ShareLock'
                and held.classid = (((fence.lock_key >> 32) & 4294967295)::bigint)::oid
                and held.objid = ((fence.lock_key & 4294967295)::bigint)::oid
                and held.objsubid = 1
            ) as held`,
          );
          expect(fence?.held).toBe(true);
        });
      });
    } finally {
      capture.stop();
    }
    const setup = capture.statements.slice(0, callbackStart);
    // BEGIN, one write (GUCs + shared tenancy fence), one independent read-back.
    expect(setup).toHaveLength(3);
    expect(setup[0]?.toLowerCase()).toStartWith("begin");
    expect(setup[1]).toContain("set_config('opengeni.subject_id'");
    expect(setup[1]).toContain("pg_advisory_xact_lock_shared");
    expect(setup[2]).toContain("current_setting('opengeni.subject_id'");
    expect(setup[2]).not.toContain("set_config");
  });

  test("the shared tenancy fence still waits behind an exclusive holder before any scoped work", async () => {
    const settings = scope();
    const key = `session-tenancy:${settings.workspaceId}`;
    const holder = await shared.admin.reserve();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      let entered = false;
      const scoped = withRlsContext(client.db, settings, async () => {
        entered = true;
      });
      await Bun.sleep(200);
      expect(entered).toBe(false);
      await holder`commit`;
      await scoped;
      expect(entered).toBe(true);
    } finally {
      holder.release();
    }
  });

  test("an explicit scope subject overrides the ambient actor subject and is verified", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "batched-rls-test",
      accountExternalId: suffix,
      accountName: "Batched RLS",
      workspaceExternalSource: "batched-rls-test",
      workspaceExternalId: suffix,
      workspaceName: "Batched RLS",
      subjectId: `user:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const actor = scope();
    const explicitSubject = `user:explicit-${suffix}`;
    const capture = captureStatements();
    let seen: Scope | undefined;
    try {
      await withActor(actor, async () => {
        await withWorkspaceSubjectRls(
          client.db,
          grant.workspaceId,
          explicitSubject,
          async (scoped) => {
            seen = await readScope(scoped);
          },
        );
      });
    } finally {
      capture.stop();
    }
    expect(seen).toEqual({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: explicitSubject,
      privateFileOwner: actor.privateFileOwner,
      initiatingHuman: actor.initiatingHuman,
      resourceHuman: null,
      resourceActor: null,
    });
    // The explicit subject no longer needs its own set/read-back pair.
    expect(
      capture.statements.filter((statement) =>
        statement.includes("set_config('opengeni.subject_id'"),
      ),
    ).toHaveLength(1);
  });
});
