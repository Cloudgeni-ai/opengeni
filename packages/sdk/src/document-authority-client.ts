import type { CompanyBrainOkfDownload, CompanyBrainOkfPackage } from "./company-brain";
import { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  Document,
  DocumentBase,
  FileDownloadUrlResponse,
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
  async listDocumentBases(workspaceId: string): Promise<DocumentBase[]> {
    return await this.requestJson<DocumentBase[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-bases`,
    );
  }

  /**
   * List every Document the current human can manage from this workspace,
   * including portable personal and organization-scoped Documents whose
   * immutable ingestion workspace is different.
   */
  async listAccessibleDocuments(workspaceId: string): Promise<Document[]> {
    return await this.requestJson<Document[]>("GET", `/v1/workspaces/${workspaceId}/documents`);
  }

  /** Mint a source-file URL through the Document's effective authority. */
  async createDocumentOriginalFileDownloadUrl(
    workspaceId: string,
    documentId: string,
  ): Promise<FileDownloadUrlResponse> {
    return await this.requestJson<FileDownloadUrlResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/documents/${documentId}/original-file/download-url`,
    );
  }

  /** Retry indexing for a failed document. */
  async reindexDocument(
    workspaceId: string,
    baseId: string,
    documentId: string,
  ): Promise<Document> {
    return await this.requestJson<Document>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/documents/${documentId}/reindex`,
    );
  }

  /** Permission-filtered Company Brain package with authorized guidance bodies. */
  getCompanyBrain(workspaceId: string): Promise<CompanyBrainOkfPackage> {
    return this.requestJson<CompanyBrainOkfPackage>(
      "GET",
      `/v1/workspaces/${workspaceId}/company-brain`,
    );
  }

  /** Download the deterministic Markdown/YAML Company Brain package. */
  async exportCompanyBrainOkf(workspaceId: string): Promise<CompanyBrainOkfDownload> {
    const response = await this.requestResponse(
      "GET",
      `/v1/workspaces/${workspaceId}/company-brain/export`,
    );
    const headers = response.headers;
    return {
      content: await response.text(),
      contentType: headers.get("content-type") ?? "text/markdown",
      filename: headers.get("content-disposition")?.split('"')[1] ?? "company-brain.okf.md",
    };
  }

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
