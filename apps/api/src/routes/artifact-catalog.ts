import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import {
  ArtifactCatalogItem,
  ArtifactCatalogKind,
  ArtifactCatalogListQuery,
  ArtifactCatalogListResponse,
  retainedArtifactReferenceFromFile,
  retainedGeneratedImageReferenceFromFile,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  editableArtifactId,
  editableArtifactScope,
  fileOwnerContextForAccess,
  grantHasAgentAttemptAuthority,
  hasPermission,
  requireAccessGrantAuthorization,
  requireLiveAgentAttemptAuthorization,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getFilesForSubject,
  getGeneratedImageArtifact,
  getSessionAuthorityProjection,
  listArtifactCatalogCandidates,
  withSessionRlsActorContext,
  type ArtifactCatalogCandidate,
  type ArtifactCatalogPosition,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { artifactCatalogCursorCodec } from "../artifact-catalog-cursor";
import {
  editableArtifactActorForGrant,
  editableArtifactHttpError,
  isInvisibleListCandidate,
  type EditableArtifactRouteDependencies,
} from "./editable-artifacts";
import { fileAuthoritySubjectIdForGrant } from "./files";

type Dependencies = ApiRouteDeps & EditableArtifactRouteDependencies;
const editableKinds = new Set(["document", "spreadsheet", "presentation"]);
const CANDIDATE_BATCH = 200;
const MAX_BATCHES = 10;
const iso = (value: Date | string) => new Date(value).toISOString();
const position = (row: ArtifactCatalogCandidate): ArtifactCatalogPosition => ({
  key: row.sort_key,
  kind: row.kind,
  id: row.id,
});

export function registerArtifactCatalogRoutes(app: Hono, deps: Dependencies): void {
  app.get("/v1/workspaces/:workspaceId/artifact-catalog", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(context, deps, workspaceId);
    const grant = authorization.grant;
    const parsed = ArtifactCatalogListQuery.safeParse(context.req.query());
    if (!parsed.success)
      throw new HTTPException(422, { message: "Invalid artifact catalog query" });
    const query = parsed.data;
    const artifactsAllowed = hasPermission(grant.permissions, "artifacts:read");
    const filesAllowed = hasPermission(grant.permissions, "files:read");
    if (!artifactsAllowed && !filesAllowed)
      throw new HTTPException(403, { message: "Artifact catalog read access required" });
    let kinds = ArtifactCatalogKind.options.filter(
      (kind) =>
        (kind === "image" || kind === "file" ? filesAllowed : artifactsAllowed) &&
        (!query.kind || kind === query.kind),
    );
    if (!deps.editableArtifacts) {
      if (query.kind && editableKinds.has(query.kind) && artifactsAllowed)
        throw new HTTPException(503, { message: "Editable artifacts are unavailable" });
      kinds = kinds.filter((kind) => !editableKinds.has(kind));
    }
    const includesFiles = kinds.includes("file") || kinds.includes("image");
    const actor: SessionRlsActorContext = includesFiles
      ? await fileOwnerContextForAccess(deps, authorization, "files:read")
      : { subjectId: grant.subjectId, privateFileOwnerSubjectId: null };
    // Session visibility follows the frozen live initiator independently of
    // which artifact domains were selected. Never infer it from token labels
    // or require file ownership merely to discover Sites/editable artifacts.
    if (grantHasAgentAttemptAuthority(grant) && actor.initiatingHumanSubjectId === undefined) {
      const callerSessionId = grant.metadata?.["sessionId"];
      try {
        if (typeof callerSessionId !== "string")
          throw new SessionAuthorizationDeniedError("caller_stale");
        const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
        actor.initiatingHumanSubjectId = attempt.initiatingHumanSubjectId;
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError)
          throw new HTTPException(404, { message: "Session not found", cause: error });
        throw error;
      }
    }
    const sourceDecisions = new Map<string, boolean>();
    const canReadSession = async (sessionId: string): Promise<boolean> => {
      if (!hasPermission(grant.permissions, "sessions:read")) return false;
      if (sourceDecisions.has(sessionId)) return sourceDecisions.get(sessionId)!;
      try {
        await requireSessionAuthorization(deps, grant, {
          sessionId,
          operation: "session.read",
          surface: "http",
        });
        // The optional-host seam can return null for both a shared standalone
        // session and an RLS-hidden/missing row. Prove visibility independently
        // AFTER it, so a permissive null is never itself provenance authority.
        if (!(await getSessionAuthorityProjection(deps.db, workspaceId, sessionId))) {
          sourceDecisions.set(sessionId, false);
          return false;
        }
        sourceDecisions.set(sessionId, true);
        return true;
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError) {
          sourceDecisions.set(sessionId, false);
          return false;
        }
        if (error instanceof SessionAuthorizationUnavailableError)
          throw new HTTPException(503, { message: "Session authorization is unavailable" });
        throw error;
      }
    };
    context.header("cache-control", "private, no-store");
    return withSessionRlsActorContext(actor, async () => {
      if (query.sourceSessionId && !(await canReadSession(query.sourceSessionId)))
        throw new HTTPException(404, { message: "Session not found" });
      const secret = resolveFirstPartyDelegationSecret(deps.settings);
      if (!secret)
        throw new HTTPException(503, { message: "Artifact catalog cursor signing is unavailable" });
      const filters = { ...query, cursor: undefined };
      const codec = artifactCatalogCursorCodec(
        secret,
        JSON.stringify({
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          principalKind: grant.principalKind,
          metadata: grant.metadata,
          permissions: [...grant.permissions].sort(),
          initiatingHumanSubjectId: actor.initiatingHumanSubjectId ?? null,
          owner: actor.privateFileOwnerSubjectId ?? null,
          kinds,
          filters,
        }),
      );
      const prior = query.cursor ? codec.decode(query.cursor) : undefined;
      const snapshotAt = prior?.snapshotAt ?? new Date().toISOString();
      const expiresAt = prior?.expiresAt ?? Date.now() + 60 * 60_000;
      let after = prior?.after;
      const items: ArtifactCatalogItem[] = [];
      let lastReturned: ArtifactCatalogPosition | undefined;
      let nextCursor: string | null = null;
      const fileSubject = includesFiles ? await fileAuthoritySubjectIdForGrant(deps, grant) : null;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const candidates = await listArtifactCatalogCandidates(
          deps.db,
          { accountId: grant.accountId, workspaceId },
          {
            query,
            kinds,
            snapshotAt,
            ...(after ? { after } : {}),
            limit: CANDIDATE_BATCH,
          },
        );
        for (const candidate of candidates) {
          after = position(candidate);
          const item = await projectCandidate(deps, grant, candidate, fileSubject);
          if (
            !item ||
            item.status !== query.status ||
            (query.q && !item.title.toLowerCase().includes(query.q.toLowerCase()))
          )
            continue;
          if (items.length === query.limit) {
            nextCursor = codec.encode({ version: 1, snapshotAt, expiresAt, after: lastReturned! });
            return context.json(ArtifactCatalogListResponse.parse({ items, nextCursor }));
          }
          if (candidate.source_session_id && (await canReadSession(candidate.source_session_id)))
            item.sourceSessionId = candidate.source_session_id;
          items.push(ArtifactCatalogItem.parse(item));
          lastReturned = after;
        }
        if (candidates.length < CANDIDATE_BATCH) break;
        // Bounded scanning may produce an empty page; the encrypted frontier
        // reveals neither denied identity nor provenance and can be continued.
        if (batch === MAX_BATCHES - 1 && after)
          nextCursor = codec.encode({ version: 1, snapshotAt, expiresAt, after });
      }
      return context.json(ArtifactCatalogListResponse.parse({ items, nextCursor }));
    });
  });
}

async function projectCandidate(
  deps: Dependencies,
  grant: AccessGrant,
  row: ArtifactCatalogCandidate,
  fileSubject: string | null,
): Promise<ArtifactCatalogItem | null> {
  const item: ArtifactCatalogItem = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.version_id) item.versionId = row.version_id;
  if (editableKinds.has(row.kind)) {
    const scope = editableArtifactScope({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    try {
      // This is the HTTP application's read-only domain.getArtifact seam, NOT
      // EditableArtifactAgentApplication.read (which touches session links).
      const artifact = await deps.editableArtifacts!.readArtifact({
        scope,
        actor: editableArtifactActorForGrant(grant, "0000000000000001"),
        artifactId: editableArtifactId(row.id),
      });
      if (
        artifact.scope.accountId !== scope.accountId ||
        artifact.scope.workspaceId !== scope.workspaceId ||
        artifact.id !== row.id ||
        artifact.modality !== row.kind
      )
        throw new Error("Artifact application returned mismatched catalog metadata");
      return {
        ...item,
        title: artifact.title,
        status: artifact.lifecycle,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      };
    } catch (error) {
      if (isInvisibleListCandidate(error)) return null;
      throw editableArtifactHttpError(error);
    }
  }
  if (row.kind === "file" || row.kind === "image") {
    const [file] = await getFilesForSubject(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: fileSubject,
      fileIds: [row.id],
    });
    if (!file || file.status !== "ready") return null;
    const generated =
      row.origin === "generated_image"
        ? await getGeneratedImageArtifact(deps.db, grant.workspaceId, row.id)
        : null;
    const reference =
      row.origin === "generated_image"
        ? generated?.status === "ready"
          ? retainedGeneratedImageReferenceFromFile({
              ...file,
              width: generated.width,
              height: generated.height,
            })
          : null
        : retainedArtifactReferenceFromFile(file, "file");
    if (!reference) return null;
    return {
      ...item,
      file: reference,
      filename: file.filename,
      contentType: reference.contentType,
      sizeBytes: file.sizeBytes,
    };
  }
  return item;
}
