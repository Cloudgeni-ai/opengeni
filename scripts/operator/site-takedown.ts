/**
 * Platform takedown of a published Site, across workspaces (Opengeni has no
 * platform-admin API). Suspends the Site at once, revokes its viewer
 * sessions, actions its open abuse reports, holds its hostname for the
 * platform, records an audit event in its workspace and syncs the edge (KV
 * host map and cache purge) when Cloudflare settings are present. Only this
 * script lifts a platform takedown; owners and workspace admins cannot.
 *
 *   bun scripts/operator/site-takedown.ts --host <label or hostname> \
 *     --operator <name> --reason "<why, at least six characters>"
 *   bun scripts/operator/site-takedown.ts --site-id <id> --operator <name> --reason "<why>"
 *   bun scripts/operator/site-takedown.ts --host <label> --operator <name> --restore
 *   bun scripts/operator/site-takedown.ts --host <label> --operator <name> --release-hold
 *
 * `--release-hold` frees a platform-held hostname whose Site or workspace is
 * gone (a restore releases the hold of a live Site by itself). List what
 * needs attention with `scripts/operator/site-moderation-queue.ts`.
 *
 * Needs OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL and
 * the deployment's OPENGENI_SITES_* settings.
 */
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, liftSiteHostnameHold } from "@opengeni/db";
import { moderateSiteAsPlatform } from "../../apps/api/src/site-publishing/platform";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    host: { type: "string" },
    "site-id": { type: "string" },
    operator: { type: "string" },
    reason: { type: "string" },
    restore: { type: "boolean" },
    "release-hold": { type: "boolean" },
  },
});
const target = values["site-id"] ?? values.host;
if (!target || !values.operator?.trim())
  throw new Error(
    "Use --host <label or hostname> | --site-id <id>, --operator <name>, and --reason <why> | --restore | --release-hold",
  );
if (values["release-hold"] && !values.host) throw new Error("--release-hold needs --host <label>");
if (
  !values.restore &&
  !values["release-hold"] &&
  (!values.reason || values.reason.trim().length < 6)
)
  throw new Error("Provide --reason (at least six characters), --restore or --release-hold");
const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (values["release-hold"]) {
    const label = values.host!.trim().toLowerCase().split(".")[0] ?? "";
    const released = await liftSiteHostnameHold(client.db, label);
    console.log(JSON.stringify({ label, released, operator: values.operator.trim() }));
  } else {
    const publication = await moderateSiteAsPlatform(
      { db: client.db, settings, objectStorage: null },
      {
        host: target,
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
  }
} finally {
  await client.close();
}
