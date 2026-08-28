import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let app: postgres.Sql | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-variable-set-attachment-authority");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  app = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 60_000);

async function expectPrivilegeDenied(statement: string): Promise<void> {
  if (!app) throw new Error("database unavailable");
  let failure: unknown;
  try {
    await app.unsafe(statement);
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string } | undefined)?.code).toBe("42501");
}

describe("session Variable Set attachment authority", () => {
  test("keeps the attachment projection lifecycle-only for the runtime role", async () => {
    if (!shared || !app) return;
    const [privileges] = await app<
      Array<{
        tableSelect: boolean;
        tableInsert: boolean;
        tableUpdate: boolean;
        tableDelete: boolean;
        sessionSelectionRead: boolean;
        syncExecute: boolean;
      }>
    >`
      select
        has_table_privilege(
          current_user, 'session_variable_set_attachments', 'SELECT'
        ) as "tableSelect",
        has_table_privilege(
          current_user, 'session_variable_set_attachments', 'INSERT'
        ) as "tableInsert",
        has_table_privilege(
          current_user, 'session_variable_set_attachments', 'UPDATE'
        ) as "tableUpdate",
        has_table_privilege(
          current_user, 'session_variable_set_attachments', 'DELETE'
        ) as "tableDelete",
        has_column_privilege(current_user, 'sessions', 'variable_set_ids', 'SELECT')
          as "sessionSelectionRead",
        has_function_privilege(
          current_user, 'sync_session_variable_set_attachments()', 'EXECUTE'
        ) as "syncExecute"
    `;
    expect(privileges).toEqual({
      tableSelect: false,
      tableInsert: false,
      tableUpdate: false,
      tableDelete: false,
      sessionSelectionRead: true,
      syncExecute: false,
    });

    await expectPrivilegeDenied("select * from session_variable_set_attachments limit 0");
    await expectPrivilegeDenied(`
      insert into session_variable_set_attachments (
        account_id, workspace_id, session_id, variable_set_id, position, session_status
      ) select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), 0, 'idle' where false
    `);
    await expectPrivilegeDenied(
      "update session_variable_set_attachments set position = position where false",
    );
    await expectPrivilegeDenied("delete from session_variable_set_attachments where false");

    const [catalog] = await shared.admin<
      Array<{
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        refreshFunction: string | null;
        refreshTrigger: boolean;
      }>
    >`
      select
        relation.relrowsecurity as "rowSecurity",
        relation.relforcerowsecurity as "forceRowSecurity",
        to_regprocedure('refresh_session_variable_set_selection()')::text as "refreshFunction",
        exists (
          select 1
          from pg_trigger trigger_value
          where trigger_value.tgrelid = relation.oid
            and trigger_value.tgname = 'session_variable_set_attachments_refresh'
            and not trigger_value.tgisinternal
        ) as "refreshTrigger"
      from pg_class relation
      where relation.oid = 'session_variable_set_attachments'::regclass
    `;
    expect(catalog).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      refreshFunction: null,
      refreshTrigger: false,
    });
  });
});
