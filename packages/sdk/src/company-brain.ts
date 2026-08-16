import type {
  CompanyBrainContextReceiptPage as ContractCompanyBrainContextReceiptPage,
  CompanyBrainKnowledgeProposalPage as ContractCompanyBrainKnowledgeProposalPage,
  CompanyBrainOkfPackage as ContractCompanyBrainOkfPackage,
  KnowledgeBrowseRequest as ContractKnowledgeBrowseRequest,
  KnowledgeBrowseResponse as ContractKnowledgeBrowseResponse,
  KnowledgeGetResponse as ContractKnowledgeGetResponse,
  KnowledgeRecord as ContractKnowledgeRecord,
  KnowledgeSearchRequest as ContractKnowledgeSearchRequest,
  KnowledgeSearchResponse as ContractKnowledgeSearchResponse,
} from "@opengeni/contracts";

export type CompanyBrainOkfPackage = ContractCompanyBrainOkfPackage;
export type CompanyBrainContextReceiptPage = ContractCompanyBrainContextReceiptPage;
export type CompanyBrainKnowledgeProposalPage = ContractCompanyBrainKnowledgeProposalPage;
export type CompanyBrainKnowledgeSearchRequest = ContractKnowledgeSearchRequest;
export type CompanyBrainKnowledgeSearchResponse = ContractKnowledgeSearchResponse;
export type CompanyBrainKnowledgeBrowseRequest = ContractKnowledgeBrowseRequest;
export type CompanyBrainKnowledgeBrowseResponse = ContractKnowledgeBrowseResponse;
export type CompanyBrainKnowledgeGetResponse = ContractKnowledgeGetResponse;
export type CompanyBrainKnowledgeRecord = ContractKnowledgeRecord;

export type CompanyBrainContextReceiptListOptions = {
  attemptId?: string;
  cursor?: string;
  limit?: number;
};

export type CompanyBrainKnowledgeProposalListOptions = {
  limit?: number;
};

export type CompanyBrainInspectorTransport = {
  requestJson<T>(method: string, path: string, body?: unknown): Promise<T>;
};

function inspectorPath(workspaceId: string, suffix: string): string {
  return `/v1/workspaces/${workspaceId}/company-brain/${suffix}`;
}

/** Human-authorized, permission-first Knowledge search for Company Brain inspectors. */
export function searchCompanyBrainKnowledge(
  client: CompanyBrainInspectorTransport,
  workspaceId: string,
  request: CompanyBrainKnowledgeSearchRequest,
): Promise<CompanyBrainKnowledgeSearchResponse> {
  return client.requestJson("POST", inspectorPath(workspaceId, "knowledge/search"), request);
}

export function getCompanyBrainKnowledge(
  client: CompanyBrainInspectorTransport,
  workspaceId: string,
  recordId: string,
): Promise<CompanyBrainKnowledgeGetResponse> {
  return client.requestJson(
    "GET",
    `${inspectorPath(workspaceId, "knowledge/record")}?id=${encodeURIComponent(recordId)}`,
  );
}

export function browseCompanyBrainKnowledge(
  client: CompanyBrainInspectorTransport,
  workspaceId: string,
  request: CompanyBrainKnowledgeBrowseRequest = {},
): Promise<CompanyBrainKnowledgeBrowseResponse> {
  return client.requestJson("POST", inspectorPath(workspaceId, "knowledge/browse"), request);
}

export function listCompanyBrainContextReceipts(
  client: CompanyBrainInspectorTransport,
  workspaceId: string,
  options: CompanyBrainContextReceiptListOptions = {},
): Promise<CompanyBrainContextReceiptPage> {
  const params = new URLSearchParams();
  if (options.attemptId) params.set("attemptId", options.attemptId);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return client.requestJson(
    "GET",
    `${inspectorPath(workspaceId, "context-receipts")}${query ? `?${query}` : ""}`,
  );
}

export function listCompanyBrainKnowledgeProposals(
  client: CompanyBrainInspectorTransport,
  workspaceId: string,
  options: CompanyBrainKnowledgeProposalListOptions = {},
): Promise<CompanyBrainKnowledgeProposalPage> {
  const query =
    options.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
  return client.requestJson("GET", `${inspectorPath(workspaceId, "knowledge-proposals")}${query}`);
}

export type CompanyBrainOkfDownload = {
  content: string;
  contentType: string;
  filename: string;
};
