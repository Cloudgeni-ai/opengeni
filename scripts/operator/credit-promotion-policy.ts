import { parseArgs } from "node:util";
import {
  CreditPromotionPolicy,
  configuredModels,
  dbSearchPath,
  getSettings,
} from "@opengeni/config";
import { resolveCatalogSettings } from "@opengeni/core";
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
if (Boolean(values.file) === Boolean(values.show)) {
  throw new Error("Use --show, or --file <policy.json> --operator <name> --reason <reason>");
}
const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (values.show) {
    const rows = await client.db.execute(
      sql`select revision, policy, operator, reason, changed_at from opengeni_private.credit_promotion_policy_revisions order by revision desc limit 1`,
    );
    console.log(
      JSON.stringify(
        rows[0] ?? { policy: settings.creditPromotionPolicy, source: "deployment configuration" },
        null,
        2,
      ),
    );
  } else {
    const policy = CreditPromotionPolicy.parse(await Bun.file(values.file!).json());
    if (!policy.defaultModelIds) throw new Error("Runtime policy requires defaultModelIds");
    if (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6) {
      throw new Error("Provide --operator and --reason (at least six characters)");
    }
    const catalog = configuredModels((await resolveCatalogSettings(client.db, settings)).settings);
    const ids = new Set([
      ...policy.defaultModelIds,
      ...(policy.signupModelIds ?? []),
      ...Object.values(policy.offers).flatMap((offer) => offer.eligibleModelIds ?? []),
    ]);
    for (const id of ids) {
      if (!catalog.some((model) => model.id === id && model.cost === "credits")) {
        throw new Error(
          `Model ${id} must be a canonical credit-funded model in the current catalog`,
        );
      }
    }
    const [row] = await client.db.execute(
      sql`select set_credit_promotion_policy(${JSON.stringify(policy)}::jsonb, ${values.operator.trim()}, ${values.reason.trim()}) as revision`,
    );
    console.log(JSON.stringify({ applied: true, revision: row?.revision }));
  }
} finally {
  await client.close();
}
