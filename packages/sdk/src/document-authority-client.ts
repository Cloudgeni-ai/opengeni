import { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  DocumentAuthorityReclassification,
  DocumentDefaultCollectionBackfill,
  DocumentDefaultCollectionBackfillAudit,
  GetDocumentDefaultCollectionBackfillAuditOptions,
  ListDocumentAuthorityReclassificationsOptions,
  ListDocumentAuthorityReclassificationsResponse,
  ListDocumentDefaultCollectionBackfillRunsResponse,
  ListOrganizationDocumentAuthorityReclassificationsResponse,
  ReclassifyDocumentAuthorityRequest,
  RunDocumentDefaultCollectionBackfillRequest,
} from "./types";

/**
 * Operator-only Document authority and tenancy-backfill surface.
 *
 * The public root and legacy `core` clients extend this class for compatibility.
 * Browser consoles that import `@opengeni/sdk/browser` do not retain these
 * methods or their routes.
 */
export class OpenGeniDocumentAuthorityClient extends OpenGeniCoreClient {
  /**
   * Atomically reclassify a Document's authority and every indexed chunk.
   * The operation is replay-safe and rejects a stale expected authority tuple.
   */
  async reclassifyDocumentAuthority(
    workspaceId: string,
    documentId: string,
    request: ReclassifyDocumentAuthorityRequest,
  ): Promise<DocumentAuthorityReclassification> {
    return await this.requestJson<DocumentAuthorityReclassification>(
      "POST",
      `/v1/workspaces/${workspaceId}/documents/${documentId}/authority-reclassifications`,
      request,
    );
  }

  /** List the current actor's durable authority-reclassification receipts. */
  async listDocumentAuthorityReclassifications(
    workspaceId: string,
    documentId: string,
    options: ListDocumentAuthorityReclassificationsOptions = {},
  ): Promise<ListDocumentAuthorityReclassificationsResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return await this.requestJson<ListDocumentAuthorityReclassificationsResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/documents/${documentId}/authority-reclassifications${query}`,
    );
  }

  /**
   * Advance one resumable, organization-scoped Default collection backfill.
   * Reusing an operation ID is idempotent; keep the run ID across batches.
   */
  async runDocumentDefaultCollectionBackfill(
    workspaceId: string,
    request: RunDocumentDefaultCollectionBackfillRequest,
  ): Promise<DocumentDefaultCollectionBackfill> {
    return await this.requestJson<DocumentDefaultCollectionBackfill>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-default-collection-backfills`,
      request,
    );
  }

  /** List organization-scoped Default collection backfill runs (organization admin only). */
  async listDocumentDefaultCollectionBackfillRuns(
    workspaceId: string,
    options: ListDocumentAuthorityReclassificationsOptions = {},
  ): Promise<ListDocumentDefaultCollectionBackfillRunsResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return await this.requestJson<ListDocumentDefaultCollectionBackfillRunsResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-default-collection-backfills${query}`,
    );
  }

  /** Read bounded operation and workspace receipts for one Default-collection backfill run. */
  async getDocumentDefaultCollectionBackfillAudit(
    workspaceId: string,
    runId: string,
    options: GetDocumentDefaultCollectionBackfillAuditOptions = {},
  ): Promise<DocumentDefaultCollectionBackfillAudit> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.operationCursor) params.set("operationCursor", options.operationCursor);
    if (options.receiptCursor) params.set("receiptCursor", options.receiptCursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return await this.requestJson<DocumentDefaultCollectionBackfillAudit>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-default-collection-backfills/${runId}${query}`,
    );
  }

  /** List organization-wide Document authority changes (organization admin only). */
  async listOrganizationDocumentAuthorityReclassifications(
    workspaceId: string,
    options: ListDocumentAuthorityReclassificationsOptions = {},
  ): Promise<ListOrganizationDocumentAuthorityReclassificationsResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return await this.requestJson<ListOrganizationDocumentAuthorityReclassificationsResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-authority-reclassifications${query}`,
    );
  }
}
