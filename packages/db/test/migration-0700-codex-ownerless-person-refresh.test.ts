import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { createDb, refreshSubscriptionCoreCodexCredential, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { runtimeDatabaseReadyCheck } from "../src/runtime-posture";
import { withSubscriptionCoreCodexRefreshLock } from "../src/subscription-core-placement-world";
import {
  ownerlessRefreshFixture,
  ownerlessRefreshSettings,
} from "./fixtures/ownerless-codex-refresh";

const migration = "0700_codex_ownerless_person_refresh.sql";
const signature =
  "opengeni_private.begin_subscription_codex_refresh(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint)";
const oldGuard =
  "authorized := turn_human IS NULL\n          AND opengeni_private.authorize_subscription_ownerless_session_access(";
const newGuard = "authorized := opengeni_private.authorize_subscription_ownerless_session_access(";

test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "0700 rolls forward under the non-bypass owner, keeps live app readiness/posture and repairs only the ownerless refresh guard",
  async () => {
    const database = await acquireOwnerMigratedTestDatabase("ownerless-refresh-0699-upgrade");
    if (!database) throw new Error("Real PostgreSQL required");
    const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
    let client: DbClient | undefined;
    try {
      const [role] =
        await owner`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
      await owner`insert into schema_migrations(name) values (${migration})`;
      await migrate(database.ownerUrl);
      await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
      const appUrl = new URL(database.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = database.appPassword;
      client = createDb(appUrl.toString(), { max: 1 });
      const ready = runtimeDatabaseReadyCheck(client.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
      });
      await ready();

      const routine = async () => {
        const [row] =
          await owner`select proc.oid::text as oid, pg_get_userbyid(proc.proowner) as owner,
          proc.prosecdef as security_definer, proc.proconfig as config, proc.proacl::text as acl,
          has_function_privilege('opengeni_app', proc.oid, 'EXECUTE') as app_execute,
          coalesce((select bool_or(privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE')
            from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege), false) as public_execute,
          pg_get_functiondef(proc.oid) as definition
          from pg_proc proc where proc.oid = ${signature}::regprocedure`;
        if (!row) throw new Error("Refresh routine missing");
        return row;
      };
      const before = await routine();
      expect(before).toMatchObject({
        security_definer: true,
        app_execute: true,
        public_execute: false,
      });
      expect(before.definition).toContain(oldGuard);
      const states = await Promise.all(
        [false, true].map((human) =>
          ownerlessRefreshFixture({ admin: database.admin, client: client! }, human),
        ),
      );
      for (const [index, state] of states.entries()) {
        let callbacks = 0;
        const old = await withSubscriptionCoreCodexRefreshLock(
          client.db,
          { ...state.identity, ...state.lease },
          async () => {
            callbacks++;
            return "control";
          },
        );
        expect(old).toEqual(
          index === 0 ? { status: "completed", value: "control" } : { status: "refused" },
        );
        expect(callbacks).toBe(index === 0 ? 1 : 0);
      }

      // Existing application connections remain open while the rolling DDL
      // replaces the function. No re-provisioning is needed after the patch.
      await owner`delete from schema_migrations where name = ${migration}`;
      await migrate(database.ownerUrl);
      await ready();
      const after = await routine();
      const { definition: beforeDefinition, ...beforePosture } = before;
      const { definition: afterDefinition, ...afterPosture } = after;
      expect(afterPosture).toEqual(beforePosture);
      expect(afterDefinition).toBe(beforeDefinition.replace(oldGuard, newGuard));
      for (const state of states) {
        let providerCalls = 0;
        expect(
          await refreshSubscriptionCoreCodexCredential(
            client.db,
            ownerlessRefreshSettings,
            state.identity,
            state.lease,
            1,
            {
              refresh: async () => {
                providerCalls++;
                return {
                  accessToken: "synthetic-after-upgrade",
                  refreshToken: "synthetic-after-upgrade-refresh",
                };
              },
            },
          ),
        ).toMatchObject({ kind: "refreshed", refreshGeneration: 2 });
        expect(providerCalls).toBe(1);
      }
      await migrate(database.ownerUrl);
      expect((await routine()).definition).toBe(afterDefinition);
      const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
      expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
      // Directly applying an already-replaced/unknown source fails closed and
      // leaves the routine unchanged; the normal ledger safely skips it.
      await expect(owner.begin((tx) => tx.unsafe(source))).rejects.toThrow(
        "Ownerless Codex refresh authorization source changed",
      );
      expect((await routine()).definition).toBe(afterDefinition);
    } finally {
      await client?.close();
      await owner.end();
      await database.release();
    }
  },
  600_000,
);
