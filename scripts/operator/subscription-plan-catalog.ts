import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { SubscriptionPlanCatalog } from "@opengeni/contracts";
import { createDb } from "@opengeni/db";
import { sql } from "drizzle-orm";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    file: { type: "string" },
    operator: { type: "string" },
    reason: { type: "string" },
    show: { type: "boolean" },
  },
});
if (Boolean(values.file) === Boolean(values.show))
  throw new Error("Use --show, or --file <catalog.json> --operator <name> --reason <reason>");
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(getSettings());
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (values.show) {
    const rows = await client.db.execute(
      sql`select revision, catalog, operator, reason, changed_at from opengeni_private.subscription_plan_catalog_revisions order by revision desc limit 1`,
    );
    console.log(JSON.stringify(rows[0], null, 2));
  } else {
    const catalog = SubscriptionPlanCatalog.parse(await Bun.file(values.file!).json());
    if (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6)
      throw new Error("Provide --operator and --reason (at least six characters)");
    const [row] = await client.db.execute(
      sql`select set_subscription_plan_catalog(${JSON.stringify(catalog)}::jsonb, ${values.operator.trim()}, ${values.reason.trim()}) as revision`,
    );
    console.log(JSON.stringify({ applied: true, revision: row?.revision }));
  }
} finally {
  await client.close();
}
