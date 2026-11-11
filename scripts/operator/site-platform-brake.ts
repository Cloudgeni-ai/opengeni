/**
 * The Opengeni-wide Site platform brake (docs/published-sites.md, "Platform
 * usage"). Shows this month's platform usage of all workspaces together, its
 * estimated cost against OPENGENI_SITES_PLATFORM_MONTHLY_LIMIT_USD and the
 * brake state; lifts the brake (it then stays lifted for the rest of the UTC
 * month, or until an operator engages it again) or engages it by hand.
 *
 *   bun scripts/operator/site-platform-brake.ts status
 *   bun scripts/operator/site-platform-brake.ts lift --operator <name> --reason "<why>"
 *   bun scripts/operator/site-platform-brake.ts engage --operator <name> --reason "<why>"
 *
 * API pods cache the brake state for up to 15 seconds. Needs a database URL
 * (OPENGENI_DATABASE_URL works: the platform tables are reached through
 * their lane) and the deployment's OPENGENI_SITES_PLATFORM_* settings.
 */
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  createDb,
  engageSitePlatformBrake,
  liftSitePlatformBrake,
  readSitePlatformBrake,
  readSitePlatformTotals,
} from "@opengeni/db";
import {
  sitePlatformEstimateMicros,
  sitePlatformLimitMicros,
} from "../../apps/api/src/site-publishing/platform-usage";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: { operator: { type: "string" }, reason: { type: "string" } },
});
const command = positionals[0] ?? "status";
if (!["status", "lift", "engage"].includes(command))
  throw new Error(
    "Use status, lift --operator <name> --reason <why>, or engage --operator <name> --reason <why>",
  );
if (command !== "status" && (!values.operator?.trim() || (values.reason?.trim().length ?? 0) < 6))
  throw new Error("lift and engage need --operator <name> and --reason (at least six characters)");

const settings = getSettings();
const url =
  process.env.OPENGENI_DATABASE_URL ??
  process.env.OPENGENI_MIGRATIONS_DATABASE_URL ??
  process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_DATABASE_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
const usd = (micros: number | null) => (micros === null ? null : Math.round(micros / 10_000) / 100);
try {
  if (command === "lift")
    await liftSitePlatformBrake(client.db, {
      by: values.operator!.trim(),
      reason: values.reason!.trim(),
    });
  if (command === "engage")
    await engageSitePlatformBrake(client.db, {
      reason: `${values.operator!.trim()}: ${values.reason!.trim()}`,
    });
  const [totals, brake] = await Promise.all([
    readSitePlatformTotals(client.db),
    readSitePlatformBrake(client.db),
  ]);
  const estimateMicros = sitePlatformEstimateMicros(settings, totals);
  const limitMicros = sitePlatformLimitMicros(settings);
  console.log(
    JSON.stringify(
      {
        command,
        operator: values.operator?.trim() ?? null,
        totals,
        estimatedUsd: usd(estimateMicros),
        limitUsd: usd(limitMicros),
        percent: limitMicros ? Math.round((estimateMicros / limitMicros) * 1000) / 10 : null,
        alertPercent: settings.sitesPlatformAlertPercent,
        brake,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
