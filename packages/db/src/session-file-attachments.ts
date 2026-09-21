import type { FileAsset, ResourceRef, SessionAuthorizationActor } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/** Only call during verified human initial/Send/Steer acceptance, in its transaction. */
export async function acceptSessionFileAttachments(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    subjectId: string;
    resources: ResourceRef[];
  },
): Promise<void> {
  const ids = [...new Set(input.resources.flatMap((r) => (r.kind === "file" ? [r.fileId] : [])))];
  if (!ids.length) return;
  await withRlsContext(db, input, async (tx) => {
    await tx.execute(sql`select opengeni_private.accept_session_file_attachments(
      ${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sessionId}::uuid,${input.turnId}::uuid,
      ${input.subjectId},ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[])`);
  });
}

export type SessionAttachmentReadAccess = {
  sessionId: string;
  authorityEpoch: number;
  actor: Pick<SessionAuthorizationActor, "kind" | "subjectId"> &
    Partial<{
      callerSessionId: string;
      turnId: string;
      attemptId: string;
      executionGeneration: number;
    }>;
};
/** Core must prove session authorization; workers supply their live own-session attempt. */
export async function readSessionFileAttachments(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    fileIds: readonly string[];
    access: SessionAttachmentReadAccess;
  },
): Promise<FileAsset[]> {
  if (!input.fileIds.length) return [];
  return withRlsContext(db, input, async (tx) => {
    const rows = await rawRows<FileAsset>(
      tx,
      sql`
    select id,case when private_owner_subject_ids is null then 'workspace' else 'personal' end as scope,workspace_id as "workspaceId",status,filename,
      safe_filename as "safeFilename",content_type as "contentType",size_bytes::double precision as "sizeBytes",
      sha256,bucket,object_key as "objectKey",created_at::text as "createdAt",updated_at::text as "updatedAt"
    from opengeni_private.read_session_file_attachments(
      ${input.accountId}::uuid,${input.workspaceId}::uuid,${input.access.sessionId}::uuid,
      ${input.access.authorityEpoch},ARRAY(select jsonb_array_elements_text(${JSON.stringify([...new Set(input.fileIds)])}::jsonb))::uuid[],
      ${JSON.stringify(input.access.actor)}::jsonb)`,
    );
    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  });
}
