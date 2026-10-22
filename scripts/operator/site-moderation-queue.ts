/**
 * The platform's moderation queue for published Sites, across every
 * workspace: open abuse reports and publications whose last content scan
 * was flagged, newest first. Read-only. Each new report or flagged scan also
 * writes a `site_abuse_notice` log line and, when OPENGENI_SITES_ABUSE_EMAIL
 * and a managed email transport are configured, emails that address.
 *
 *   bun scripts/operator/site-moderation-queue.ts [--limit 100] [--json]
 *
 * Take a Site down with `scripts/operator/site-takedown.ts --site-id <id>`.
 * Needs the database role that owns the Opengeni schema (the migrations
 * credential, OPENGENI_MIGRATIONS_DATABASE_URL), which reads across
 * workspaces through owner-only read policies (migration 0782), no BYPASSRLS
 * needed; or OPENGENI_DATABASE_ADMIN_URL when that is a superuser or
 * BYPASSRLS role. The application role is refused.
 */
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, listSiteModerationQueue } from "@opengeni/db";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    limit: { type: "string" },
    json: { type: "boolean" },
  },
});
const limit = Number(values.limit ?? "100");
if (!Number.isInteger(limit) || limit < 1 || limit > 500)
  throw new Error("--limit must be a whole number from 1 to 500");
const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url)
  throw new Error(
    "Set OPENGENI_MIGRATIONS_DATABASE_URL (the schema owner) or OPENGENI_DATABASE_ADMIN_URL (a superuser or BYPASSRLS role)",
  );
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  const items = await listSiteModerationQueue(client.db, { limit });
  if (values.json) {
    console.log(JSON.stringify(items, null, 2));
  } else if (items.length === 0) {
    console.log("Nothing open.");
  } else {
    for (const item of items)
      console.log(
        [
          item.at.toISOString(),
          item.kind,
          item.label ?? "(no hostname)",
          item.status ?? "-",
          `site=${item.siteId}`,
          `workspace=${item.workspaceId}`,
          item.detail,
          item.message ? JSON.stringify(item.message.slice(0, 200)) : "",
        ]
          .filter(Boolean)
          .join("  "),
      );
  }
} finally {
  await client.close();
}
