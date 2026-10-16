import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

type SiteRuntimeAdmission = { workspaceId: string; sessionId: string; admissionId: string };
const admissionContext = new AsyncLocalStorage<SiteRuntimeAdmission>();

/** Trusted in-process Site dispatch only. Never populated from request headers or JSON. */
export function withSiteRuntimeAdmission<T>(admission: SiteRuntimeAdmission, run: () => T): T {
  return admissionContext.run(admission, run);
}

/**
 * The conversation lock precedes the session writer prefix and is held through
 * enqueue commit. Recovery revokes the token under this same lock, so even a
 * delayed request cannot enqueue after its reservation has been released.
 * Ordinary session writers do no extra database work.
 */
export async function lockSiteRuntimeAdmission(
  db: Database,
  workspaceId: string,
  sessionIds?: readonly string[],
): Promise<void> {
  const admission = admissionContext.getStore();
  if (
    !admission ||
    admission.workspaceId !== workspaceId ||
    (sessionIds !== undefined && !sessionIds.includes(admission.sessionId))
  )
    return;
  const [row] = await rawRows<{ pending_admission_id: string | null }>(
    db,
    sql`
    select pending_admission_id from site_runtime_conversations
    where workspace_id = ${workspaceId} and session_id = ${admission.sessionId}
    for update`,
  );
  if (row?.pending_admission_id !== admission.admissionId)
    throw new Error("Site conversation admission expired; retry the request");
}
