import { fileOwnerContextForAccess } from "@opengeni/core";
import { withSessionRlsActorContext } from "@opengeni/db";
import {
  AddDocumentRequest,
  CreateKnowledgeDropRequest,
  CreateDocumentBaseRequest,
  Document,
  DocumentAuthorityReclassification,
  DocumentBase,
  DocumentDefaultCollectionBackfill,
  DocumentDefaultCollectionBackfillAudit,
  GetDocumentDefaultCollectionBackfillAuditQuery,
  FileAsset,
  FileDownloadUrlResponse,
  ListDocumentAuthorityReclassificationsQuery,
  ListDocumentAuthorityReclassificationsResponse,
  ListDocumentDefaultCollectionBackfillRunsResponse,
  ListDocumentMigrationAuditQuery,
  ListOrganizationDocumentAuthorityReclassificationsResponse,
  MoveDocumentRequest,
  ReclassifyDocumentAuthorityRequest,
  RunDocumentDefaultCollectionBackfillRequest,
} from "@opengeni/contracts";
import { recordAuditEvent, completeFileUpload, createFileUpload } from "@opengeni/db";
import {
  addDocumentToBase,
  createDocumentBase,
  deleteDocumentFromBase,
  ensureDefaultBase,
  getDocument,
  getDocumentOriginalFile,
  getDocumentBase,
  getDocumentDefaultCollectionBackfillAudit,
  listAccessibleDocuments,
  listDocumentAuthorityReclassifications,
  listDocumentDefaultCollectionBackfillRuns,
  listDocumentBasesEnsuringDefault,
  listDocuments,
  listOrganizationDocumentAuthorityReclassifications,
  moveDocumentToBase,
  queueDocumentForReindex,
  reclassifyDocumentAuthority,
  runDocumentDefaultCollectionBackfill,
} from "@opengeni/documents";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  requireAccessGrant,
  requireAccountAdminAuthorizationStamp,
  requireAccessGrantAuthorization,
  knowledgeContextForAccess,
} from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildDocumentsMcpServer } from "../mcp/documents";
import { mcpOAuthAuthenticateHeader, resolveMcpOAuthRouteAccess } from "../mcp-oauth";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import {
  buildWorkspaceToolGatewayMcpServer,
  prepareMcpOAuthWorkspaceToolGateway,
} from "../workspace-tool-gateway";
import { sanitizeFilename } from "./files";

export function registerDocumentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, objectStorage, documentIndexer, getDocumentServices } = deps;
  // Document compatibility uploads use the same verified personal file owner as
  // Files and chat uploads. A delegated subject label never becomes an owner.
  for (const path of [
    "/v1/workspaces/:workspaceId/document-bases/*",
    "/v1/workspaces/:workspaceId/documents/*",
    "/v1/workspaces/:workspaceId/knowledge/drops",
  ]) {
    app.use(path, async (c, next) => {
      const permission =
        (c.req.method === "GET" && !c.req.path.includes("/authority-reclassifications")) ||
        c.req.path.endsWith("/search")
          ? "documents:search"
          : "documents:manage";
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        c.req.param("workspaceId") ?? "",
        permission,
      );
      return withSessionRlsActorContext(
        await fileOwnerContextForAccess(deps, access, permission),
        next,
      );
    });
  }

  app.post("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = CreateDocumentBaseRequest.parse(await c.req.json());
    return c.json(
      DocumentBase.parse(
        await createDocumentBase(db, { ...payload, accountId: grant.accountId, workspaceId }),
      ),
      201,
    );
  });

  app.get("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (
        await listDocumentBasesEnsuringDefault(db, {
          accountId: grant.accountId,
          workspaceId,
        })
      ).map((base) => DocumentBase.parse(base)),
    );
  });

  app.get("/v1/workspaces/:workspaceId/document-bases/:baseId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const base = await getDocumentBase(db, workspaceId, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json(DocumentBase.parse(base));
  });

  app.post("/v1/workspaces/:workspaceId/document-default-collection-backfills", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    if (!hasAccountAdminAuthority(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const accountAdminAuthorization = requireAccountAdminAuthorizationStamp(authorization);
    const payload = RunDocumentDefaultCollectionBackfillRequest.parse(await c.req.json());
    try {
      return c.json(
        DocumentDefaultCollectionBackfill.parse(
          await runDocumentDefaultCollectionBackfill(db, {
            ...payload,
            accountId: authorization.grant.accountId,
            workspaceId,
            actorSubjectId: authorization.grant.subjectId,
            accountAdminAuthorization,
          }),
        ),
      );
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/document-default-collection-backfills", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    if (!hasAccountAdminAuthority(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const query = ListDocumentMigrationAuditQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new HTTPException(400, { message: "invalid document migration audit query" });
    }
    try {
      return c.json(
        ListDocumentDefaultCollectionBackfillRunsResponse.parse(
          await listDocumentDefaultCollectionBackfillRuns(db, {
            accountId: authorization.grant.accountId,
            workspaceId,
            actorSubjectId: authorization.grant.subjectId,
            accountAdminAuthorization: requireAccountAdminAuthorizationStamp(authorization),
            ...query.data,
          }),
        ),
      );
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/document-default-collection-backfills/:runId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    if (!hasAccountAdminAuthority(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const runId = RunDocumentDefaultCollectionBackfillRequest.shape.runId.safeParse(
      c.req.param("runId"),
    );
    const query = GetDocumentDefaultCollectionBackfillAuditQuery.safeParse(c.req.query());
    if (!runId.success || !query.success) {
      throw new HTTPException(400, { message: "invalid document migration audit query" });
    }
    try {
      return c.json(
        DocumentDefaultCollectionBackfillAudit.parse(
          await getDocumentDefaultCollectionBackfillAudit(db, {
            accountId: authorization.grant.accountId,
            workspaceId,
            actorSubjectId: authorization.grant.subjectId,
            accountAdminAuthorization: requireAccountAdminAuthorizationStamp(authorization),
            runId: runId.data,
            ...query.data,
          }),
        ),
      );
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/document-authority-reclassifications", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    if (!hasAccountAdminAuthority(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const query = ListDocumentMigrationAuditQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new HTTPException(400, { message: "invalid document migration audit query" });
    }
    try {
      return c.json(
        ListOrganizationDocumentAuthorityReclassificationsResponse.parse(
          await listOrganizationDocumentAuthorityReclassifications(db, {
            accountId: authorization.grant.accountId,
            workspaceId,
            actorSubjectId: authorization.grant.subjectId,
            accountAdminAuthorization: requireAccountAdminAuthorizationStamp(authorization),
            ...query.data,
          }),
        ),
      );
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/document-bases/:baseId/documents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "documents:manage");
    const { grant } = access;
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "document:index",
      quantity: 0,
    });
    const payload = AddDocumentRequest.parse(await c.req.json());
    const organizationAuthorityGranted =
      access.accountGrant?.permissions.includes("account:admin") === true;
    if (payload.authorityKind === "organization" && !organizationAuthorityGranted) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    try {
      const document = await addDocumentToBase(db, {
        ...payload,
        accountId: grant.accountId,
        workspaceId,
        baseId: c.req.param("baseId"),
        createdBy: grant.subjectId,
        initiatingSubjectId: grant.subjectId,
        organizationAuthorityGranted,
        access: { viewerSubjectId: grant.subjectId },
      });
      const wasCreated =
        document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed =
        document.status === "ready"
          ? document
          : ((await documentIndexer.indexDocument({
              accountId: grant.accountId,
              workspaceId,
              documentId: document.id,
              authorityKind: document.authorityKind,
              authorityWorkspaceId: document.authorityWorkspaceId,
              authoritySubjectId: document.authoritySubjectId,
            })) ?? document);
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/document-bases/:baseId/documents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (
        await listDocuments(db, workspaceId, c.req.param("baseId"), {
          viewerSubjectId: grant.subjectId,
        })
      ).map((document) => Document.parse(document)),
    );
  });

  app.get("/v1/workspaces/:workspaceId/documents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (
        await listAccessibleDocuments(db, workspaceId, {
          viewerSubjectId: grant.subjectId,
        })
      ).map((document) => Document.parse(document)),
    );
  });

  app.post(
    "/v1/workspaces/:workspaceId/documents/:documentId/authority-reclassifications",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const payload = ReclassifyDocumentAuthorityRequest.parse(await c.req.json());
      const accountAdminAuthorized = hasAccountAdminAuthority(authorization);
      const accountAdminAuthorization = accountAdminAuthorized
        ? requireAccountAdminAuthorizationStamp(authorization)
        : null;
      try {
        const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
          viewerSubjectId: authorization.grant.subjectId,
        });
        if (!document) throw new HTTPException(404, { message: "document not found" });
        if (
          (document.authorityKind === "organization" ||
            payload.targetAuthorityKind === "organization") &&
          !accountAdminAuthorization
        ) {
          throw new HTTPException(403, { message: "missing permission: account:admin" });
        }
        return c.json(
          DocumentAuthorityReclassification.parse(
            await reclassifyDocumentAuthority(db, {
              ...payload,
              accountId: authorization.grant.accountId,
              workspaceId,
              documentId: document.id,
              actorSubjectId: authorization.grant.subjectId,
              accountAdminAuthorization,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        throw documentHttpException(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/documents/:documentId/authority-reclassifications",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
      try {
        const query = ListDocumentAuthorityReclassificationsQuery.parse(c.req.query());
        return c.json(
          ListDocumentAuthorityReclassificationsResponse.parse(
            await listDocumentAuthorityReclassifications(db, {
              accountId: grant.accountId,
              workspaceId,
              documentId: c.req.param("documentId"),
              actorSubjectId: grant.subjectId,
              ...query,
            }),
          ),
        );
      } catch (error) {
        throw documentHttpException(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/documents/:documentId/original-file", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const file = await getDocumentOriginalFile(db, {
      accountId: grant.accountId,
      workspaceId,
      documentId: c.req.param("documentId"),
      access: { viewerSubjectId: grant.subjectId },
    });
    if (!file) {
      throw new HTTPException(404, { message: "document file not found" });
    }
    return c.json(FileAsset.parse(file));
  });

  app.post(
    "/v1/workspaces/:workspaceId/documents/:documentId/original-file/download-url",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
      await requireAccessGrant(c, deps, workspaceId, "files:read");
      if (!objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      const file = await getDocumentOriginalFile(db, {
        accountId: grant.accountId,
        workspaceId,
        documentId: c.req.param("documentId"),
        access: { viewerSubjectId: grant.subjectId },
      });
      if (!file) {
        throw new HTTPException(404, { message: "document file not found" });
      }
      if (file.status !== "ready") {
        throw new HTTPException(409, { message: `file is ${file.status}` });
      }
      const signed = await objectStorage.createGetUrl({ key: file.objectKey });
      await recordAuditEvent(db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        action: "file.signed_url.issued",
        targetType: "workspace_document",
        targetId: c.req.param("documentId"),
        metadata: {
          fileId: file.id,
          kind: "document_original",
          expiresAt: signed.expiresAt.toISOString(),
        },
      });
      return c.json(
        FileDownloadUrlResponse.parse({
          url: signed.url,
          expiresAt: signed.expiresAt.toISOString(),
        }),
      );
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const { grant } = authorization;
      const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
      try {
        const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
          viewerSubjectId: grant.subjectId,
        });
        if (!document || document.baseId !== c.req.param("baseId")) {
          throw new HTTPException(404, { message: "document not found" });
        }
        requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
        await deleteDocumentFromBase(db, {
          accountId: grant.accountId,
          workspaceId,
          baseId: c.req.param("baseId"),
          documentId: c.req.param("documentId"),
          organizationAuthorityGranted,
          access: { viewerSubjectId: grant.subjectId },
        });
        return c.body(null, 204);
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw documentHttpException(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const { grant } = authorization;
      const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
      if (!objectStorage) {
        throw new HTTPException(503, {
          message: "object storage is not configured",
        });
      }
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId,
        action: "document:index",
        quantity: 0,
      });
      try {
        const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
          viewerSubjectId: grant.subjectId,
        });
        if (!document) {
          throw new HTTPException(404, { message: "document not found" });
        }
        requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
        if (document.status !== "failed") {
          throw new HTTPException(422, { message: "only failed documents can be retried" });
        }
        if (document.baseId !== c.req.param("baseId")) {
          throw new HTTPException(404, { message: "document not found" });
        }
        const queued = await queueDocumentForReindex(
          db,
          workspaceId,
          document.id,
          {
            viewerSubjectId: grant.subjectId,
          },
          organizationAuthorityGranted,
        );
        const indexed =
          (await documentIndexer.indexDocument({
            accountId: grant.accountId,
            // The requested workspace authorizes the human operation; the
            // immutable ingestion workspace remains the indexing authority.
            workspaceId: queued.workspaceId,
            documentId: document.id,
            authorityKind: document.authorityKind,
            authorityWorkspaceId: document.authorityWorkspaceId,
            authoritySubjectId: document.authoritySubjectId,
          })) ?? queued;
        return c.json(Document.parse(indexed));
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw documentHttpException(error);
      }
    },
  );

  for (const path of [
    "/v1/workspaces/:workspaceId/document-bases/:baseId/search",
    "/v1/workspaces/:workspaceId/knowledge/search",
  ]) {
    app.post(path, async (c) => {
      await requireAccessGrant(c, deps, c.req.param("workspaceId")!, "documents:search");
      throw new HTTPException(410, {
        message:
          "Document search moved to /knowledge/entries/search. Pending Knowledge is available through its review view.",
      });
    });
  }

  // Compatibility upload endpoint. Retained originals and extracted text now
  // enter canonical Knowledge. Agent findings use ordinary accepted turns.
  app.post("/v1/workspaces/:workspaceId/knowledge/drops", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "documents:manage");
    const { grant } = access;
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "document:index",
      quantity: 0,
    });
    const payload = CreateKnowledgeDropRequest.parse(await c.req.json());
    const personalFileOwner =
      payload.authorityKind === "personal"
        ? (await fileOwnerContextForAccess(deps, access, "documents:manage"))
            .privateFileOwnerSubjectId
        : null;
    if (payload.authorityKind === "personal" && !personalFileOwner)
      throw new HTTPException(403, {
        message: "Personal source retention requires verified ownership",
      });
    const organizationAuthorityGranted =
      access.accountGrant?.permissions.includes("account:admin") === true;
    if (payload.authorityKind === "organization" && !organizationAuthorityGranted) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    try {
      let fileId: string;
      if (payload.text !== undefined) {
        const bytes = new TextEncoder().encode(payload.text);
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId,
          action: "file:upload",
          quantity: bytes.length,
        });
        if (bytes.length > objectStorage.maxSinglePutSizeBytes) {
          throw new HTTPException(413, {
            message: `drop exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
          });
        }
        const filename = dropFilename(payload.filename ?? payload.title);
        const newFileId = crypto.randomUUID();
        const safeFilename = sanitizeFilename(filename);
        const objectKey = `workspaces/${workspaceId}/files/${newFileId}/original/${safeFilename}`;
        const upload = await createFileUpload(db, {
          accountId: grant.accountId,
          workspaceId,
          fileId: newFileId,
          privateOwnerSubjectId: personalFileOwner ?? null,
          filename,
          safeFilename,
          contentType: "text/plain; charset=utf-8",
          sizeBytes: bytes.length,
          sha256: null,
          bucket: objectStorage.bucket,
          objectKey,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });
        await objectStorage.putObject({
          key: objectKey,
          contentType: "text/plain; charset=utf-8",
          body: bytes,
        });
        const file = await completeFileUpload(db, workspaceId, upload.uploadId);
        await recordWorkspaceUsage(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          eventType: "file.uploaded",
          quantity: file.sizeBytes,
          unit: "byte",
          sourceResourceType: "file",
          sourceResourceId: file.id,
          idempotencyKey: `file.uploaded:${workspaceId}:${file.id}`,
        });
        fileId = file.id;
      } else {
        fileId = payload.fileId as string;
      }
      const defaultBase = await ensureDefaultBase(db, {
        accountId: grant.accountId,
        workspaceId,
      });
      const document = await addDocumentToBase(db, {
        fileId,
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.authorityKind ? { authorityKind: payload.authorityKind } : {}),
        ...(payload.visibility ? { visibility: payload.visibility } : {}),
        ...(payload.agentAccess !== undefined ? { agentAccess: payload.agentAccess } : {}),
        accountId: grant.accountId,
        workspaceId,
        baseId: defaultBase.id,
        createdBy: grant.subjectId,
        initiatingSubjectId: grant.subjectId,
        organizationAuthorityGranted,
        curationStatus: "none",
        access: { viewerSubjectId: grant.subjectId },
      });
      const wasCreated =
        document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed =
        document.status === "ready"
          ? document
          : ((await documentIndexer.indexDocument({
              accountId: grant.accountId,
              workspaceId,
              documentId: document.id,
              authorityKind: document.authorityKind,
              authorityWorkspaceId: document.authorityWorkspaceId,
              authoritySubjectId: document.authoritySubjectId,
            })) ?? document);
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      throw documentHttpException(error);
    }
  });

  // Apply a curation suggestion (no body target) or move to an explicit base.
  app.post("/v1/workspaces/:workspaceId/documents/:documentId/move", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    const { grant } = authorization;
    const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
    const payload = MoveDocumentRequest.parse(await c.req.json().catch(() => ({})));
    try {
      const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
        viewerSubjectId: grant.subjectId,
      });
      if (!document) {
        throw new HTTPException(404, { message: "document not found" });
      }
      requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
      return c.json(
        Document.parse(
          await moveDocumentToBase(db, {
            accountId: grant.accountId,
            workspaceId,
            documentId: document.id,
            targetBaseId: payload.targetBaseId ?? null,
            organizationAuthorityGranted,
            access: { viewerSubjectId: grant.subjectId },
          }),
        ),
      );
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      throw documentHttpException(error);
    }
  });

  // Old clients get an explicit cutover response instead of writing to an
  // invisible second Knowledge store. Historical Memory IDs are entry IDs now.
  for (const path of [
    "/v1/workspaces/:workspaceId/knowledge/memories",
    "/v1/workspaces/:workspaceId/knowledge/memories/*",
  ]) {
    app.all(path, async (c) => {
      await requireAccessGrant(c, deps, c.req.param("workspaceId")!, "documents:search");
      return c.json(
        {
          error: {
            code: "memory_replaced",
            message:
              "Memory has been replaced by Knowledge entries. Use /knowledge/entries and the current SDK Knowledge methods.",
          },
        },
        410,
      );
    });
  }

  app.all("/v1/workspaces/:workspaceId/mcp/docs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    let oauthAccess: Awaited<ReturnType<typeof resolveMcpOAuthRouteAccess>>;
    try {
      oauthAccess = await resolveMcpOAuthRouteAccess(deps, c.req.raw, workspaceId);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 401) {
        c.header("www-authenticate", mcpOAuthAuthenticateHeader(deps, new URL(c.req.url).pathname));
      }
      throw error;
    }
    if (oauthAccess) {
      return await withAccessGrantSessionRlsContext(deps, oauthAccess.grant, async () => {
        const prepared = await prepareMcpOAuthWorkspaceToolGateway(
          deps,
          oauthAccess.grant,
          oauthAccess.allowedToolIdentities,
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        const server = buildWorkspaceToolGatewayMcpServer(
          prepared,
          oauthAccess.grant,
          deps.observability,
        );
        try {
          await server.connect(transport);
          return await transport.handleRequest(c.req.raw);
        } finally {
          await Promise.allSettled([server.close(), prepared.close()]);
        }
      });
    }
    let grant: Awaited<ReturnType<typeof requireAccessGrant>>;
    try {
      grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    } catch (error) {
      if (deps.settings.mcpOauthEnabled && error instanceof HTTPException && error.status === 401) {
        c.header("www-authenticate", mcpOAuthAuthenticateHeader(deps, new URL(c.req.url).pathname));
      }
      throw error;
    }
    return await withAccessGrantSessionRlsContext(deps, grant, async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = buildDocumentsMcpServer(
        db,
        grant.accountId,
        workspaceId,
        getDocumentServices(),
        {
          knowledge: await knowledgeContextForAccess(
            deps,
            await requireAccessGrantAuthorization(c, deps, workspaceId, "documents:search"),
            "documents:search",
          ),
        },
      );
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    });
  });
}

/** Derive a .txt filename for a raw-text drop from its optional title/filename. */
function dropFilename(preferred: string | undefined): string {
  const stem = (preferred ?? "").trim() || `note-${new Date().toISOString().slice(0, 10)}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(stem) ? stem : `${stem}.txt`;
}

function documentHttpException(error: unknown): HTTPException {
  const message = documentDomainErrorMessage(error);
  if (message.includes("organization document") && message.includes("exact account authority")) {
    return new HTTPException(403, { message: "missing permission: account:admin" });
  }
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("document Default collection backfill audit run is unavailable")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("already exists")) {
    return new HTTPException(409, { message });
  }
  if (
    message.includes("operation id was reused") ||
    message.includes("authority changed before reclassification") ||
    message.includes("run identity mismatch")
  ) {
    return new HTTPException(409, { message });
  }
  if (
    message.includes("reclassification requires") ||
    message.includes("backfill requires organization administration") ||
    message.includes("document migration audit requires organization administration") ||
    message.includes("document migration audit scope is invalid")
  ) {
    return new HTTPException(403, { message });
  }
  if (
    message.includes("reclassification input is invalid") ||
    message.includes("reclassification authority is invalid") ||
    message.includes("invalid document authority receipt cursor") ||
    message.includes("document authority receipt limit") ||
    message.includes("invalid document migration audit cursor") ||
    message.includes("document migration audit cursor is invalid") ||
    message.includes("document migration audit limit") ||
    message.includes("document migration audit authority is incomplete") ||
    message.includes("document Default collection backfill audit run id is required")
  ) {
    return new HTTPException(400, { message });
  }
  if (message.includes("no suggested base")) {
    return new HTTPException(422, { message });
  }
  if (message.includes("pending") || message.includes("failed") || message.includes("deleted")) {
    return new HTTPException(422, { message });
  }
  // Workspace-memory write-gate rejections are client errors, not server faults.
  if (
    message.includes("too long") ||
    message.includes("visible memory is full") ||
    message.includes("empty after sanitization") ||
    message.includes("does not match") ||
    message.includes("Ambiguous memory id")
  ) {
    return new HTTPException(400, { message });
  }
  return new HTTPException(500, { message });
}

function documentDomainErrorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const record = current as { cause?: unknown; message?: unknown };
    if (typeof record.message === "string") message = record.message;
    current = record.cause;
  }
  return message;
}

function hasAccountAdminAuthority(
  authorization: Awaited<ReturnType<typeof requireAccessGrantAuthorization>>,
): boolean {
  return authorization.accountGrant?.permissions.includes("account:admin") === true;
}

function requireOrganizationDocumentAuthority(
  authorityKind: string,
  organizationAuthorityGranted: boolean,
): void {
  if (authorityKind === "organization" && !organizationAuthorityGranted) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
}
