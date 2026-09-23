import { expect, test } from "bun:test";

test("0484 preserves the complete 0359 usage authority body except the returned projection", async () => {
  const original = await Bun.file(
    new URL("../drizzle/0359_insights_force_rls_read_capability.sql", import.meta.url),
  ).text();
  const candidate = await Bun.file(
    new URL("../drizzle/0484_insights_usage_projection.sql", import.meta.url),
  ).text();
  const lastUsageFunction = original.slice(
    original.lastIndexOf(
      "CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_usage_events(",
    ),
  );
  const body = (source: string) => source.split("AS $function$")[1]!.split("$function$;")[0]!;
  expect(body(candidate)).toBe(
    body(lastUsageFunction).replace(
      "SELECT usage_row.*",
      "SELECT usage_row.event_type, usage_row.quantity,\n          usage_row.occurred_at, usage_row.source_resource_id",
    ),
  );
  expect(candidate).toStartWith("-- deployment-mode: rolling");
  expect(candidate).toContain("VOLATILE\n    SECURITY DEFINER");
  expect(candidate).toContain("SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp");
  expect(candidate).toContain("REVOKE ALL ON FUNCTION");
  expect(candidate).toContain(
    "'opengeni_private.visible_workspace_insights_usage_events(uuid,timestamptz,timestamptz,text[])', 'EXECUTE'",
  );
  expect(candidate).not.toContain("ALTER POLICY");
  expect(candidate).not.toContain("NO FORCE ROW LEVEL SECURITY");
});
