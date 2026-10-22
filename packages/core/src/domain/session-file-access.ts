import type { AccessGrant, FileAsset } from "@opengeni/contracts";
import {
  getSessionAuthorityProjection,
  getFilesForSubject,
  readSessionFileAttachments,
  withSessionRlsActorContext,
} from "@opengeni/db";
import type { SessionAuthorizationDependencies } from "../session-authorization";
import {
  requireSessionAuthorization,
  withResolvedSessionAuthorization,
} from "../session-authorization";

/** A session attachment grant is never a generic file/Knowledge grant. */
export async function readSessionAttachmentFiles(
  deps: SessionAuthorizationDependencies,
  grant: AccessGrant,
  sessionId: string,
  fileIds: readonly string[],
): Promise<FileAsset[]> {
  const authority = await getSessionAuthorityProjection(deps.db, grant.workspaceId, sessionId);
  if (!authority) return [];
  const authorization = await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.read",
    surface: "core",
  });
  const ordinary = await getFilesForSubject(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    fileIds,
  });
  const actor = authorization?.actor ?? { kind: "subject" as const, subjectId: grant.subjectId };
  const shared: FileAsset[] = [];
  const ids = [...new Set(fileIds)];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const read = () =>
      readSessionFileAttachments(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        fileIds: ids.slice(offset, offset + 1000),
        access: { sessionId, authorityEpoch: authority.authorityEpoch, actor },
      });
    shared.push(
      ...(authorization
        ? await withResolvedSessionAuthorization(authorization, read)
        : await withSessionRlsActorContext({ subjectId: grant.subjectId }, read)),
    );
  }
  const accepted = new Map(shared.map((file) => [file.id, file]));
  return [...accepted.values(), ...ordinary.filter((file) => !accepted.has(file.id))];
}
