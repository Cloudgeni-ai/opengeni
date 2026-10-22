import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import {
  ArtifactCatalogItem,
  ArtifactCatalogKind,
  ArtifactCatalogListQuery,
  ArtifactCatalogListResponse,
  ArtifactPinResponse,
  UpdateArtifactPinRequest,
  retainedArtifactReferenceFromFile,
  retainedGeneratedImageReferenceFromFile,
  type AccessGrant,
  type FileAsset,
} from "@opengeni/contracts";
import {
  editableArtifactId,
  editableArtifactScope,
  EDITABLE_ARTIFACT_READ_BATCH_LIMIT,
  fileOwnerContextForAccess,
  grantHasAgentAttemptAuthority,
  hasPermission,
  requireAccessGrantAuthorization,
  requireLiveAgentAttemptAuthorization,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  siteViewerForGrant,
  type ApiRouteDeps,
  type EditableArtifact,
} from "@opengeni/core";
import {
  getFilesForSubject,
  getGeneratedImageArtifacts,
  getSessionAuthorityProjection,
  isWorkspaceArtifactVisible,
  listArtifactCatalogCandidates,
  nestedPostgresSqlState,
  updateArtifactPin,
  withSessionRlsActorContext,
  type ArtifactCatalogCandidate,
  type ArtifactCatalogPosition,
  type GeneratedImageArtifact,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
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
// Bound both the pool pressure and speculative work beyond the page frontier.
const PROJECTION_BATCH = EDITABLE_ARTIFACT_READ_BATCH_LIMIT;
const MAX_BATCHES = 10;
const iso = (value: Date | string) => new Date(value).toISOString();
const position = (row: ArtifactCatalogCandidate): ArtifactCatalogPosition => ({
  key: row.sort_key,
  kind: row.kind,
  id: row.id,
  pinned: row.pinned ?? false,
});

export function registerArtifactCatalogRoutes(app: Hono, deps: Dependencies): void {
  app.put("/v1/workspaces/:workspaceId/artifact-catalog/:kind/:artifactId/pin", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    if (!hasPermission(grant.permissions, "artifacts:publish"))
      throw new HTTPException(403, { message: "Artifact publish access required" });
    const kind = ArtifactCatalogKind.safeParse(context.req.param("kind"));
    const body = UpdateArtifactPinRequest.safeParse(await context.req.json().catch(() => null));
    const requestedId = context.req.param("artifactId");
    if (
      !kind.success ||
      !body.success ||
      !(editableKinds.has(kind.data)
        ? /^[0-9a-f]{32}$/.test(requestedId)
        : z.string().uuid().safeParse(requestedId).success)
    )
      throw new HTTPException(422, { message: "Invalid artifact pin request" });
    const artifactId = editableKinds.has(kind.data) ? requestedId : requestedId.toLowerCase();
    const fileKind = kind.data === "file" || kind.data === "image";
    if (!hasPermission(grant.permissions, fileKind ? "files:read" : "artifacts:read"))
      throw new HTTPException(403, { message: "Artifact read access required" });
    const actor = fileKind
      ? await fileOwnerContextForAccess(deps, authorization, "files:read")
      : { subjectId: grant.subjectId, privateFileOwnerSubjectId: null };
    context.header("cache-control", "private, no-store");
    return withSessionRlsActorContext(actor, async () => {
      if (editableKinds.has(kind.data)) {
        if (!deps.editableArtifacts)
          throw new HTTPException(503, { message: "Editable artifacts are unavailable" });
        try {
          const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
          const artifact = await deps.editableArtifacts.readArtifact({
            scope,
            actor: editableArtifactActorForGrant(grant, "0000000000000001"),
            artifactId: editableArtifactId(artifactId),
          });
          if (
            artifact.scope.accountId !== scope.accountId ||
            artifact.scope.workspaceId !== scope.workspaceId ||
            artifact.id !== artifactId ||
            artifact.modality !== kind.data
          )
            throw new HTTPException(404, { message: "Artifact not found" });
        } catch (error) {
          if (isInvisibleListCandidate(error))
            throw new HTTPException(404, { message: "Artifact not found" });
          throw editableArtifactHttpError(error);
        }
      }
      // An Only me Site someone else owns answers exactly like a missing one.
      if (
        kind.data === "site" &&
        !(await isWorkspaceArtifactVisible(
          deps.db,
          workspaceId,
          await siteViewerForGrant(deps.db, grant),
          artifactId,
        ))
      )
        throw new HTTPException(404, { message: "Artifact not found" });
      if (fileKind) {
        const subjectId = await fileAuthoritySubjectIdForGrant(deps, grant);
        const [file] = await getFilesForSubject(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId,
          fileIds: [artifactId],
        });
        if (!file || file.status !== "ready")
          throw new HTTPException(404, { message: "Artifact not found" });
      }
      try {
        await updateArtifactPin(
          deps.db,
          { accountId: grant.accountId, workspaceId },
          {
            kind: kind.data,
            artifactId,
            pinned: body.data.pinned,
          },
        );
      } catch (error) {
        if (nestedPostgresSqlState(error) === "42501")
          throw new HTTPException(404, { message: "Artifact not found" });
        throw error;
      }
      return context.json(
        ArtifactPinResponse.parse({ kind: kind.data, artifactId, pinned: body.data.pinned }),
      );
    });
  });
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
    const sourceDecisions = new Map<string, Promise<boolean>>();
    const canReadSession = (sessionId: string): Promise<boolean> => {
      if (!hasPermission(grant.permissions, "sessions:read")) return Promise.resolve(false);
      const cached = sourceDecisions.get(sessionId);
      if (cached) return cached;
      const decision = (async () => {
        try {
          await requireSessionAuthorization(deps, grant, {
            sessionId,
            operation: "session.read",
            surface: "http",
          });
          // The optional-host seam can return null for both a shared standalone
          // session and an RLS-hidden/missing row. Prove visibility independently
          // AFTER it, so a permissive null is never itself provenance authority.
          return !!(await getSessionAuthorityProjection(deps.db, workspaceId, sessionId));
        } catch (error) {
          if (error instanceof SessionAuthorizationDeniedError) return false;
          if (error instanceof SessionAuthorizationUnavailableError)
            throw new HTTPException(503, { message: "Session authorization is unavailable" });
          throw error;
        }
      })();
      // Cache in-flight decisions too: many rows can share one source session.
      sourceDecisions.set(sessionId, decision);
      return decision;
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
      const siteViewer = kinds.includes("site")
        ? await siteViewerForGrant(deps.db, grant)
        : { subjectId: null };
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const candidates = await listArtifactCatalogCandidates(
          deps.db,
          { accountId: grant.accountId, workspaceId },
          {
            query,
            kinds,
            siteViewer,
            snapshotAt,
            ...(after ? { after } : {}),
            limit: CANDIDATE_BATCH,
          },
        );
        for (let offset = 0; offset < candidates.length;) {
          const window = candidates.slice(
            offset,
            offset + Math.min(PROJECTION_BATCH, query.limit - items.length + 1),
          );
          offset += window.length;
          const fileProjection = loadCandidateFiles(deps, grant, window, fileSubject);
          const editableProjection = loadCandidateEditableArtifacts(deps, grant, window);
          // Retain each application's live read/authorization boundary. Settling
          // in parallel must not reorder rows or surface an error after the first
          // eligible lookahead row, which belongs to the next page.
          const projected = await Promise.allSettled(
            window.map((candidate) =>
              projectCandidate(
                deps,
                grant,
                candidate,
                fileSubject,
                fileProjection,
                editableProjection,
              ),
            ),
          );
          const accepted: Array<{
            item: ArtifactCatalogItem;
            candidate: ArtifactCatalogCandidate;
          }> = [];
          let hasNext = false;
          for (let index = 0; index < window.length; index++) {
            const candidate = window[index]!;
            after = position(candidate);
            const result = projected[index]!;
            if (result.status === "rejected") throw result.reason;
            const item = result.value;
            if (
              !item ||
              item.status !== query.status ||
              (query.q && !item.title.toLowerCase().includes(query.q.toLowerCase()))
            )
              continue;
            if (items.length + accepted.length === query.limit) {
              hasNext = true;
              break;
            }
            accepted.push({ item, candidate });
          }
          const authorizedItems = await Promise.all(
            accepted.map(async ({ item, candidate }) => {
              if (
                candidate.source_session_id &&
                (await canReadSession(candidate.source_session_id))
              )
                item.sourceSessionId = candidate.source_session_id;
              return ArtifactCatalogItem.parse(item);
            }),
          );
          items.push(...authorizedItems);
          if (accepted.length) lastReturned = position(accepted[accepted.length - 1]!.candidate);
          if (hasNext) {
            nextCursor = codec.encode({ version: 1, snapshotAt, expiresAt, after: lastReturned! });
            return context.json(ArtifactCatalogListResponse.parse({ items, nextCursor }));
          }
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

type CandidateFiles = {
  files: Map<string, FileAsset>;
  generated: Map<string, GeneratedImageArtifact>;
};

function loadCandidateEditableArtifacts(
  deps: Dependencies,
  grant: AccessGrant,
  candidates: readonly ArtifactCatalogCandidate[],
): Promise<Map<string, PromiseSettledResult<EditableArtifact>>> | null {
  const application = deps.editableArtifacts;
  if (!application?.readArtifacts) return null;
  const artifactIds = candidates
    .filter((row) => editableKinds.has(row.kind))
    .map((row) => editableArtifactId(row.id));
  if (!artifactIds.length) return null;
  return Promise.resolve()
    .then(() =>
      application.readArtifacts!({
        scope: editableArtifactScope({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
        }),
        actor: editableArtifactActorForGrant(grant, "0000000000000001"),
        artifactIds,
      }),
    )
    .then((results) => {
      if (results.length !== artifactIds.length)
        throw new Error("Artifact application returned mismatched batch results");
      return new Map(artifactIds.map((id, index) => [id, results[index]!]));
    });
}

async function loadCandidateFiles(
  deps: Dependencies,
  grant: AccessGrant,
  candidates: readonly ArtifactCatalogCandidate[],
  fileSubject: string | null,
): Promise<CandidateFiles> {
  const fileIds = candidates
    .filter((candidate) => candidate.kind === "file" || candidate.kind === "image")
    .map((candidate) => candidate.id);
  const files = new Map(
    (
      await getFilesForSubject(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: fileSubject,
        fileIds,
      })
    ).map((file) => [file.id, file]),
  );
  const generatedIds = candidates
    .filter(
      (candidate) =>
        candidate.origin === "generated_image" && files.get(candidate.id)?.status === "ready",
    )
    .map((candidate) => candidate.id);
  const generated = new Map(
    (await getGeneratedImageArtifacts(deps.db, grant.workspaceId, generatedIds)).map((artifact) => [
      artifact.artifactId,
      artifact,
    ]),
  );
  return { files, generated };
}

async function projectCandidate(
  deps: Dependencies,
  grant: AccessGrant,
  row: ArtifactCatalogCandidate,
  fileSubject: string | null,
  fileProjection: Promise<CandidateFiles>,
  editableProjection: Promise<Map<string, PromiseSettledResult<EditableArtifact>>> | null,
): Promise<ArtifactCatalogItem | null> {
  const item: ArtifactCatalogItem = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.pinned !== undefined ? { pinned: row.pinned } : {}),
  };
  if (row.version_id) item.versionId = row.version_id;
  if (row.kind === "site")
    item.visibility = row.site_visibility === "user_private" ? "private" : "workspace";
  if (editableKinds.has(row.kind)) {
    const scope = editableArtifactScope({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    try {
      // This is the HTTP application's read-only domain.getArtifact seam, NOT
      // EditableArtifactAgentApplication.read (which touches session links).
      const batchResult = editableProjection ? (await editableProjection).get(row.id) : undefined;
      if (batchResult?.status === "rejected") throw batchResult.reason;
      if (editableProjection && !batchResult)
        throw new Error("Artifact application omitted a batch result");
      const artifact =
        batchResult?.status === "fulfilled"
          ? batchResult.value
          : await deps.editableArtifacts!.readArtifact({
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
    const projection = await fileProjection;
    const file = projection.files.get(row.id);
    if (!file || file.status !== "ready") return null;
    const generated = projection.generated.get(row.id);
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
      // Who can open it, and whether this viewer may change that.
      visibility: file.scope === "personal" ? "private" : "workspace",
      ownedByViewer: fileSubject !== null && file.ownerSubjectId === fileSubject,
      file: reference,
      filename: file.filename,
      contentType: reference.contentType,
      sizeBytes: file.sizeBytes,
    };
  }
  return item;
}
