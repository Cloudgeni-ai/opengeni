import type { AgentRun, ResourceRef, RunEvent } from "./types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

export function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const resolved = (raw ?? DEFAULT_BASE_URL).trim();
  return resolved.replace(/\/$/, "");
}

export function getWebSocketBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base.startsWith("https://")) {
    return "wss://" + base.slice("https://".length);
  }
  if (base.startsWith("http://")) {
    return "ws://" + base.slice("http://".length);
  }
  return base;
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
    return JSON.stringify(body);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(getApiBaseUrl() + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new Error(`API ${response.status}: ${detail}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchRun(runId: string): Promise<AgentRun> {
  return request<AgentRun>(`/v1/runs/${runId}`);
}

export function fetchRunEvents(runId: string): Promise<RunEvent[]> {
  return request<RunEvent[]>(`/v1/runs/${runId}/events`);
}

export function createRun(
  prompt: string,
  resources: ResourceRef[] = [],
): Promise<AgentRun> {
  return request<AgentRun>(`/v1/runs`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      resources,
    }),
  });
}

export function submitFollowUp(
  runId: string,
  prompt: string,
): Promise<AgentRun> {
  return request<AgentRun>(`/v1/runs/${runId}/follow-up`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export function cancelRun(
  runId: string,
  reason: string | null,
): Promise<AgentRun> {
  return request<AgentRun>(`/v1/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function runStreamUrl(runId: string, fromSequence: number): string {
  const params = new URLSearchParams({
    from_sequence: String(Math.max(1, fromSequence)),
  });
  return `${getWebSocketBaseUrl()}/v1/runs/${runId}/stream?${params.toString()}`;
}
