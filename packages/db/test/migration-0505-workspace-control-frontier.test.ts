import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

let blank: BlankTestDatabase;
beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("migration-0505-control-frontier");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
}, 180_000);
afterAll(async () => await blank?.release());

test("repairs the stream frontier without replaying controls and rejects later rollback", async () => {
  const db = postgres(blank.databaseUrl, { max: 1 });
  try {
    // Minimal PostgreSQL fixture for the exact columns this migration touches.
    // State/timer sentinels prove the repair is cursor-only, including a paused workspace.
    await db.unsafe(`
      create schema if not exists opengeni_private;
      create table workspace_inference_controls (
        workspace_id text primary key, revision bigint not null,
        workspace_state text, workspace_pause_revision bigint,
        timer_id text, timer_pause_revision bigint, changed_at text
      );
      create table workspace_control_events (
        workspace_id text, revision bigint, action text,
        unique(workspace_id, revision)
      );
      alter table workspace_inference_controls enable row level security;
      alter table workspace_inference_controls force row level security;
      alter table workspace_control_events enable row level security;
      alter table workspace_control_events force row level security;
      insert into workspace_inference_controls values
        ('regressed',464,'paused',400,'timer',400,'unchanged'),
        ('healthy',8000,'active',null,null,null,'unchanged'),
        ('empty',0,'active',null,null,null,'unchanged');
      insert into workspace_control_events values
        ('regressed',464,'pause'),('regressed',3478,'pause'),('regressed',6741,'resume'),
        ('healthy',7999,'resume');
    `);
    const before = [
      ...(await db`select * from workspace_inference_controls order by workspace_id`),
    ];
    const eventsBefore = [
      ...(await db`select * from workspace_control_events order by workspace_id, revision`),
    ];
    const migration = await readFile(
      new URL("../drizzle/0505_workspace_control_revision_frontier.sql", import.meta.url),
      "utf8",
    );
    await db.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    const after = [...(await db`select * from workspace_inference_controls order by workspace_id`)];
    expect(after).toEqual(
      before.map((row) => (row.workspace_id === "regressed" ? { ...row, revision: "6741" } : row)),
    );
    expect([
      ...(await db`select * from workspace_control_events order by workspace_id, revision`),
    ]).toEqual(eventsBefore);
    expect(
      await db`select e.* from workspace_control_events e join workspace_inference_controls c using(workspace_id) where e.revision > c.revision`,
    ).toHaveLength(0);
    // The next normal command retains CAS allocation and is immediately stream-visible.
    await db.begin(async (tx) => {
      expect(
        await tx`update workspace_inference_controls set revision=6742 where workspace_id='regressed' and revision=6741 returning revision`,
      ).toHaveLength(1);
      await tx`insert into workspace_control_events values ('regressed',6742,'resume')`;
    });
    expect([
      ...(await db`select revision from workspace_control_events where workspace_id='regressed' and revision > 6741`),
    ]).toEqual([{ revision: "6742" }]);
    await expect(
      Promise.resolve(
        db`update workspace_inference_controls set revision=464 where workspace_id='regressed'`,
      ),
    ).rejects.toThrow("cannot move backwards");
    expect(
      (
        await db`select relforcerowsecurity from pg_class where relname in ('workspace_control_events','workspace_inference_controls')`
      ).every((row) => row.relforcerowsecurity),
    ).toBe(true);
  } finally {
    await db.end();
  }
}, 180_000);
