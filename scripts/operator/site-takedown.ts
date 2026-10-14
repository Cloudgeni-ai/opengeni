/**
 * Platform takedown of a published Site, across workspaces (Opengeni has no
 * platform-admin API). Suspends the Site at once, actions its open abuse
 * reports, records an audit event in its workspace and syncs the edge (KV
 * host map and cache purge) when Cloudflare settings are present. Only this
 * script lifts a platform takedown; owners and workspace admins cannot.
 *
 *   bun scripts/operator/site-takedown.ts --host <label or hostname> \
 *     --operator <name> --reason "<why, at least six characters>"
 *   bun scripts/operator/site-takedown.ts --host <label> --operator <name> --restore
 *
 * Needs OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL and
 * the deployment's OPENGENI_SITES_* settings.
 */
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { moderateSiteAsPlatform } from "../../apps/api/src/site-publishing/platform";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    host: { type: "string" },
    operator: { type: "string" },
    reason: { type: "string" },
    restore: { type: "boolean" },
  },
});
if (!values.host || !values.operator?.trim())
  throw new Error("Use --host <label or hostname> --operator <name> (--reason <why> | --restore)");
if (!values.restore && (!values.reason || values.reason.trim().length < 6))
  throw new Error("Provide --reason (at least six characters), or --restore");
const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  const publication = await moderateSiteAsPlatform(
    { db: client.db, settings, objectStorage: null },
    {
      host: values.host,
      operator: values.operator,
      action: values.restore ? "restore" : "takedown",
      reason: values.reason,
    },
  );
  console.log(
    JSON.stringify({
      siteId: publication.siteId,
      label: publication.label,
      status: publication.status,
      suspendedBy: publication.suspendedBy,
    }),
  );
} finally {
  await client.close();
}
