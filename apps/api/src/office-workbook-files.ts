// Files in and out of a live Excel workbook for `excel_run`: chat files the
// agent's code opens in the workbook, and copies of the workbook saved to the
// chat. The add-in moves the bytes itself, as the person, through the ordinary
// file routes; the API decides which files and who may open the copy.
import {
  retainedArtifactReferenceFromFile,
  type AccessGrant,
  type FileAccess,
  type RetainedArtifactReference,
} from "@opengeni/contracts";
import {
  fileAccessFor,
  fileOwnerContextForAgent,
  resolveNewFileAudience,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getFile,
  getSessionAuthorityProjection,
  recordSandboxFilePublication,
  requireWorkspace,
  withSessionRlsActorContext,
} from "@opengeni/db";
import type { OfficeRunFile } from "./office-workbooks";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** The files one run brings into the workbook, together. */
export const OFFICE_RUN_FILES_MAX_BYTES = 25 * 1024 * 1024;
/** A copy must be uploaded during the run that asked for it. */
const COPY_MAX_AGE_MS = 10 * 60_000;

export class OfficeWorkbookFileError extends Error {}

/** The chat files an agent's code asked for, as the add-in downloads them. */
export async function officeRunFiles(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  artifactIds: readonly string[],
): Promise<OfficeRunFile[]> {
  if (artifactIds.length === 0) return [];
  const actor = await fileOwnerContextForAgent(deps, grant, "files:read");
  return withSessionRlsActorContext(actor, async () => {
    const files: OfficeRunFile[] = [];
    let total = 0;
    for (const artifactId of new Set(artifactIds)) {
      const file = await getFile(deps.db, grant.workspaceId, artifactId);
      const artifact = file ? retainedArtifactReferenceFromFile(file, "file") : null;
      if (!file || !artifact)
        throw new OfficeWorkbookFileError(
          `No ready file ${artifactId} in this chat. Pass the artifactId of an attachment or published file.`,
        );
      total += file.sizeBytes;
      if (total > OFFICE_RUN_FILES_MAX_BYTES)
        throw new OfficeWorkbookFileError(
          `The files are larger than ${OFFICE_RUN_FILES_MAX_BYTES / 1024 / 1024} MB together; bring in fewer at a time.`,
        );
      files.push({ name: file.filename, artifact });
    }
    return files;
  });
}

/**
 * Who a copy of the workbook saved to this chat is for: its owner only in an
 * Only me chat, else the workspace, as for a file the agent publishes. The
 * add-in uploads the copy with this scope.
 */
export async function workbookCopyScope(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
): Promise<"personal" | "workspace"> {
  const { audience, person } = await copyAudience(deps, grant, sessionId);
  if (audience.privateOwnerSubjectId && audience.privateOwnerSubjectId !== person)
    throw new OfficeWorkbookFileError(
      "This chat belongs to someone else, so a copy of this person's workbook can't be saved to it.",
    );
  return audience.privateOwnerSubjectId ? "personal" : "workspace";
}

async function copyAudience(deps: ApiRouteDeps, grant: AccessGrant, sessionId: string) {
  const actor = await fileOwnerContextForAgent(deps, grant, "files:upload");
  return withSessionRlsActorContext(actor, async () => {
    const [authority, workspace] = await Promise.all([
      getSessionAuthorityProjection(deps.db, grant.workspaceId, sessionId),
      requireWorkspace(deps.db, grant.workspaceId),
    ]);
    if (!authority) throw new OfficeWorkbookFileError("This chat is unavailable.");
    const chatOwner =
      authority.visibility === "user_private"
        ? authority.ownerSubjectId
        : authority.memoryScope === "user"
          ? authority.scopeSubjectId
          : null;
    const person = actor.initiatingHumanSubjectId ?? null;
    const audience = await resolveNewFileAudience({
      db: deps.db,
      settings: deps.settings,
      workspace,
      chatOwner,
      person,
      requested: undefined,
    });
    return { actor, workspace, person, audience };
  });
}

export type WorkbookCopyReceipt = {
  artifactId: string;
  filename: string;
  sizeBytes: number;
  access: FileAccess;
  artifact: RetainedArtifactReference;
};

/**
 * Publish the copy the add-in just uploaded to this chat, so it is one of the
 * chat's files like one the agent published. Only the person's own fresh
 * .xlsx upload with the chat's audience qualifies.
 */
export async function publishWorkbookCopy(
  deps: ApiRouteDeps,
  input: { grant: AccessGrant; sessionId: string; fileId: string; now?: number },
): Promise<WorkbookCopyReceipt> {
  const { grant, sessionId } = input;
  const { actor, workspace, person, audience } = await copyAudience(deps, grant, sessionId);
  if (!person) throw new OfficeWorkbookFileError("No person to save the copy for.");
  return withSessionRlsActorContext(
    // As the file's owner, so their Only me copy is found.
    { ...actor, privateFileOwnerSubjectId: person },
    async () => {
      const file = await getFile(deps.db, grant.workspaceId, input.fileId);
      const scope = audience.privateOwnerSubjectId ? "personal" : "workspace";
      if (
        !file ||
        file.status !== "ready" ||
        file.ownerSubjectId !== person ||
        file.scope !== scope ||
        file.contentType !== XLSX_CONTENT_TYPE ||
        (input.now ?? Date.now()) - Date.parse(file.createdAt) > COPY_MAX_AGE_MS
      )
        throw new OfficeWorkbookFileError("The add-in's copy of the workbook didn't arrive.");
      const artifact = retainedArtifactReferenceFromFile(file, "file");
      if (!artifact)
        throw new OfficeWorkbookFileError("The add-in's copy of the workbook isn't ready.");
      await recordSandboxFilePublication(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        fileId: file.id,
        sourceSessionId: sessionId,
      });
      return {
        artifactId: file.id,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        access: await fileAccessFor(deps.db, { workspace, file }),
        artifact,
      };
    },
  );
}
