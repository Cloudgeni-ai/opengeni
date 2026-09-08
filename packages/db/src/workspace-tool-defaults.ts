import { WorkspaceSessionToolDefaultsPatch, type Workspace } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { type Database, withWorkspaceRls } from "./database";
import { requireWorkspace, updateWorkspaceSettings } from "./index";
import { lockWorkspaceInferenceControl } from "./session-control";

/** Independent nested patches; omission preserves and null restores inheritance. */
export async function updateWorkspaceSettingsWithToolDefaults(
  db: Database,
  workspaceId: string,
  patch: Record<string, unknown>,
  options: { controlLockTimeoutMs?: number } = {},
): Promise<Workspace> {
  if (patch.sessionToolDefaults === undefined)
    return updateWorkspaceSettings(db, workspaceId, patch, options);
  const tools = WorkspaceSessionToolDefaultsPatch.parse(patch.sessionToolDefaults);
  const { sessionToolDefaults: _tools, ...other } = patch;
  return withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const transaction = tx as unknown as Database;
      await lockWorkspaceInferenceControl(transaction, workspaceId, "update", {
        ...(options.controlLockTimeoutMs !== undefined
          ? { lockTimeoutMs: options.controlLockTimeoutMs }
          : {}),
      });
      if (Object.keys(other).length)
        await updateWorkspaceSettings(transaction, workspaceId, other, options);
      await transaction.execute(sql`
      update workspaces set settings = jsonb_set(settings, '{sessionToolDefaults}',
        jsonb_strip_nulls(coalesce(settings->'sessionToolDefaults', '{}'::jsonb) || ${JSON.stringify(tools)}::jsonb)),
        updated_at = now()
      where id = ${workspaceId}::uuid
    `);
      return requireWorkspace(transaction, workspaceId);
    }),
  );
}
