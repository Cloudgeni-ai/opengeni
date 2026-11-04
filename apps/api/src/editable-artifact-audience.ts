import type { AccessGrant, WorkspaceArtifactVisibility } from "@opengeni/contracts";
import {
  resolveArtifactAudienceChange,
  resolveNewArtifactAudience,
  siteViewerForGrant,
  type AccessDeps,
} from "@opengeni/core";
import type {
  EditableArtifactAudienceResolver,
  EditableArtifactModality,
} from "@opengeni/core/editable-artifacts";
import {
  readEditableArtifactAudiences,
  setEditableArtifactAudience,
  type PersistedEditableArtifactAudience,
} from "@opengeni/db";

/**
 * Who can open a document, spreadsheet or presentation: the workspace, or
 * only its owner ("Only me"). The rule is the one Sites use (core
 * site-audience); the database enforces it in the same decision as every
 * read, edit, export and live session.
 */
export type EditableArtifactAudiencePort = Readonly<{
  /**
   * The audience of a new artifact. An explicit choice wins. Otherwise it
   * follows its source: made in an Only me chat, or from an Only me file, it
   * is Only me; anything else is shared with the workspace. Its owner is the
   * person it is made for, who alone can change that later.
   */
  resolveNew(
    grant: AccessGrant,
    options?: Readonly<{
      requested?: WorkspaceArtifactVisibility | undefined;
      /** The chat it is made in; defaults to an agent attempt's own chat. */
      sourceSessionId?: string | null | undefined;
    }>,
  ): EditableArtifactAudienceResolver;
  /** Stored audiences of artifacts the caller already opened; grants nothing. */
  read(
    scope: Readonly<{ accountId: string; workspaceId: string }>,
    artifactIds: readonly string[],
  ): Promise<ReadonlyMap<string, PersistedEditableArtifactAudience>>;
  /** The owner's change; refuses agents, non-owners and disallowed Only me. */
  change(
    grant: AccessGrant,
    input: Readonly<{
      artifactId: string;
      modality: EditableArtifactModality;
      requested: WorkspaceArtifactVisibility;
    }>,
  ): Promise<PersistedEditableArtifactAudience>;
}>;

/** The chat an exact agent attempt works in; null for people, keys and services. */
export function editableArtifactSourceSessionId(grant: AccessGrant): string | null {
  const sessionId = grant.metadata?.["sessionId"];
  return grant.principalKind === "agent_attempt" && typeof sessionId === "string"
    ? sessionId
    : null;
}

/**
 * The person who may change an artifact's audience from this request: a
 * signed-in person, never an agent, key or service.
 */
export function editableArtifactAudienceViewer(grant: AccessGrant): string | null {
  return grant.principalKind === "human_session" && !grant.subjectId.startsWith("api_key:")
    ? grant.subjectId
    : null;
}

export function postgresEditableArtifactAudiences(
  deps: Pick<AccessDeps, "db" | "settings">,
): EditableArtifactAudiencePort {
  return Object.freeze({
    resolveNew:
      (grant, options = {}) =>
      async ({ modality, sourcePrivate }) =>
        Object.freeze(
          await resolveNewArtifactAudience({
            db: deps.db,
            settings: deps.settings,
            grant,
            viewer: await siteViewerForGrant(deps.db, grant),
            requested: options.requested,
            sourceSessionId:
              options.sourceSessionId === undefined
                ? editableArtifactSourceSessionId(grant)
                : options.sourceSessionId,
            sourcePrivate,
            noun: modality,
          }),
        ),
    read: (scope, artifactIds) => readEditableArtifactAudiences(deps.db, scope, artifactIds),
    change: async (grant, input) => {
      const viewer = await siteViewerForGrant(deps.db, grant);
      const visibility = await resolveArtifactAudienceChange({
        db: deps.db,
        settings: deps.settings,
        grant,
        viewer,
        requested: input.requested,
        noun: input.modality,
      });
      const caller = editableArtifactAudienceViewer(grant);
      if (!caller || viewer.subjectId !== caller) throw new EditableArtifactAudienceRefusedError();
      return await setEditableArtifactAudience(
        deps.db,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        { artifactId: input.artifactId, callerSubjectId: caller, visibility },
      );
    },
  });
}

/** A request without a signed-in person cannot change who can open anything. */
export class EditableArtifactAudienceRefusedError extends Error {
  constructor() {
    super("Only the owner can change who can open this, from the app.");
    this.name = "EditableArtifactAudienceRefusedError";
  }
}

/** The audience as the API shows it to this viewer. */
export function projectEditableArtifactAudience(
  audience: PersistedEditableArtifactAudience | undefined,
  viewerSubjectId: string | null,
): { visibility: WorkspaceArtifactVisibility; ownedByViewer: boolean } {
  return {
    visibility: audience?.visibility === "user_private" ? "private" : "workspace",
    ownedByViewer:
      viewerSubjectId !== null &&
      typeof audience?.ownerSubjectId === "string" &&
      audience.ownerSubjectId === viewerSubjectId,
  };
}
