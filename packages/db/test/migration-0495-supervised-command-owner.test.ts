// Regression companion for 0495_supervised_command_settlement.sql.
import { expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { createDb } from "../src";
import { migrate } from "../src/migrate";
import { supervisedCommandProtocolReady } from "../src/retained-provider-commands";

test("0495 rolling expansion applies under the non-bypass owner with FORCE RLS intact", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("supervised-command-owner");
  if (!owned) throw new Error("Supervised migration owner test requires PostgreSQL");
  try {
    await migrate(owned.ownerUrl);
    const client = createDb(owned.ownerUrl);
    try {
      expect(await supervisedCommandProtocolReady(client.db)).toBe(true);
    } finally {
      await client.close();
    }
    const [table] = await owned.admin`select relrowsecurity, relforcerowsecurity
      from pg_class where oid='sandbox_retained_processes'::regclass`;
    expect(table!.relrowsecurity).toBe(true);
    expect(table!.relforcerowsecurity).toBe(true);
    const [retention] = await owned.admin`select attribute.atthasmissing,
      pg_get_expr(definition.adbin, definition.adrelid) as expression
      from pg_attribute attribute join pg_attrdef definition
        on definition.adrelid=attribute.attrelid and definition.adnum=attribute.attnum
      where attribute.attrelid='sandbox_retained_processes'::regclass
        and attribute.attname='supervision_retention_xid'`;
    expect(retention!.atthasmissing).toBe(false);
    expect(retention!.expression).toBe("pg_current_xact_id()");
  } finally {
    await owned.release();
  }
}, 180_000);
