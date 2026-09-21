import { sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";

/** Retain the installation row through the caller's outer transaction. This is
 * a no-write reconciliation read; it never activates or alters an installation.
 * Acquisition callers must already hold the organization policy fence. */
export async function withLockedCapabilityInstallation<T>(
  db: Database,
  workspaceId: string,
  capabilityId: string,
  read: (tx: Database) => Promise<T>,
) {
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(sql`select id from capability_installations
      where workspace_id = ${workspaceId}::uuid and capability_id = ${capabilityId}
      for update`);
    return read(tx);
  });
}
