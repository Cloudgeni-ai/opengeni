import type {
  ClientConfig,
  CreateFileUploadResponse,
  DocumentBase,
  DocumentSearchResult,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubRepository,
  IndexedDocument,
  ReasoningEffort,
  ResourceRef,
  Session,
  SessionEvent,
  ToolRef,
  TurnSubmission,
} from "./types";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text}`);
  }
  return await response.json() as T;
}

export function createSession(input: {
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<Session> {
  return request<Session>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools ?? [],
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      clientEventId: crypto.randomUUID(),
    }),
  });
}

export function fetchClientConfig(): Promise<ClientConfig> {
  return request<ClientConfig>("/v1/config/client");
}

export function fetchSession(sessionId: string): Promise<Session> {
  return request<Session>(`/v1/sessions/${sessionId}`);
}

export async function fetchEvents(sessionId: string, after = 0): Promise<SessionEvent[]> {
  const limit = 500;
  const events: SessionEvent[] = [];
  let cursor = after;
  while (true) {
    const page = await request<SessionEvent[]>(`/v1/sessions/${sessionId}/events?after=${cursor}&limit=${limit}`);
    events.push(...page);
    if (page.length < limit) {
      return events;
    }
    cursor = page[page.length - 1]!.sequence;
  }
}

export function sendUserMessage(sessionId: string, submission: TurnSubmission): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.message",
      clientEventId: crypto.randomUUID(),
      payload: {
        text: submission.text,
        resources: submission.resources ?? [],
        tools: submission.tools ?? [],
        model: submission.model,
        reasoningEffort: submission.reasoningEffort,
      },
    }),
  });
}

export async function uploadFileAsset(file: File): Promise<FileAsset> {
  const upload = await request<CreateFileUploadResponse>("/v1/files/uploads", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name || "file",
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  const put = await fetch(upload.putUrl, {
    method: "PUT",
    body: file,
    headers: upload.requiredHeaders,
  });
  if (!put.ok) {
    throw new Error(`Object storage upload failed: ${put.status} ${await put.text()}`);
  }
  const completed = await request<{ file: FileAsset }>(`/v1/files/uploads/${upload.uploadId}/complete`, {
    method: "POST",
  });
  return completed.file;
}

export async function fetchFileDownloadUrl(fileId: string): Promise<FileDownloadUrlResponse> {
  return await request<FileDownloadUrlResponse>(`/v1/files/${fileId}/download-url`, {
    method: "POST",
  });
}

export async function fetchFileAsset(fileId: string): Promise<FileAsset> {
  return await request<FileAsset>(`/v1/files/${fileId}`);
}

export function createDocumentBase(input: { name: string; description?: string }): Promise<DocumentBase> {
  return request<DocumentBase>("/v1/document-bases", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchDocumentBases(): Promise<DocumentBase[]> {
  return request<DocumentBase[]>("/v1/document-bases");
}

export function fetchDocuments(baseId: string): Promise<IndexedDocument[]> {
  return request<IndexedDocument[]>(`/v1/document-bases/${baseId}/documents`);
}

export function addDocumentToBase(baseId: string, fileId: string): Promise<IndexedDocument> {
  return request<IndexedDocument>(`/v1/document-bases/${baseId}/documents`, {
    method: "POST",
    body: JSON.stringify({ fileId }),
  });
}

export async function searchDocumentBase(baseId: string, query: string): Promise<DocumentSearchResult[]> {
  const response = await request<{ results: DocumentSearchResult[] }>(`/v1/document-bases/${baseId}/search`, {
    method: "POST",
    body: JSON.stringify({ query, limit: 8 }),
  });
  return response.results;
}

export function sendInterrupt(sessionId: string, reason?: string): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.interrupt",
      clientEventId: crypto.randomUUID(),
      payload: { reason },
    }),
  });
}

export function sendApproval(sessionId: string, approvalId: string, decision: "approve" | "reject"): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.approvalDecision",
      clientEventId: crypto.randomUUID(),
      payload: { approvalId, decision },
    }),
  });
}

export function streamUrl(sessionId: string, after: number): string {
  const url = new URL(`${apiBaseUrl}/v1/sessions/${sessionId}/events/stream`);
  url.searchParams.set("after", String(after));
  return url.toString();
}

export async function fetchGitHubStatus(): Promise<{ configured: boolean; missing: string[]; installUrl: string | null }> {
  return await request("/v1/github/app");
}

export async function fetchGitHubRepositories(): Promise<GitHubRepository[]> {
  const payload = await request<{ repositories: GitHubRepository[] }>("/v1/github/repositories");
  return payload.repositories;
}

export async function startGitHubManifest(organization?: string): Promise<{ actionUrl: string }> {
  return await request("/v1/github/app-manifest", {
    method: "POST",
    body: JSON.stringify({ organization: organization || undefined, public: false, includeCiPermissions: true }),
  });
}
