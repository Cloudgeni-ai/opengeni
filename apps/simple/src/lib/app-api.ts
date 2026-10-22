import { OpenGeniClient, type SendMessageInput } from "@opengeni/sdk";

type Reasoning = "low" | "medium" | "high";

/**
 * The thinking setting each agent runs with. There is no model picker: every
 * message a person sends carries its agent's effort, and the server keeps the
 * session's model.
 */
export const sessionEffort = new Map<string, Reasoning>();

function withEffort(sessionId: string, message: string | SendMessageInput): SendMessageInput {
  const input = typeof message === "string" ? { text: message } : message;
  const effort = sessionEffort.get(sessionId);
  return effort && !input.reasoningEffort ? { ...input, reasoningEffort: effort } : input;
}

class AppClient extends OpenGeniClient {
  override async sendMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ) {
    return await super.sendMessage(workspaceId, sessionId, withEffort(sessionId, message));
  }

  override async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ) {
    return await super.steerMessage(workspaceId, sessionId, withEffort(sessionId, message));
  }
}

/** The browser reaches Opengeni through this origin's `/v1` proxy. */
export const client: OpenGeniClient = new AppClient({
  baseUrl: window.location.origin,
});

export type EffortLevel = "fast" | "balanced" | "thorough";

export type AgentProfile = {
  workspaceId: string;
  sessionId: string;
  emoji: string | null;
  color: string | null;
  description: string | null;
  avatarArtifactId: string | null;
  avatarStatus: "none" | "pending" | "ready" | "failed";
  avatarPrompt: string | null;
  effort: EffortLevel | null;
  name: string | null;
  role: "main" | "agent" | null;
  updatedAt: string;
};

export type UsageSummary = {
  sessionId: string;
  score: number;
  lastUsedAt: string | null;
};

export type AppState = {
  profiles: AgentProfile[];
  usage: UsageSummary[];
  prefs: Record<string, string>;
};

export type Bootstrap = AppState & {
  /** Null until a model is connected (Opengeni can't start a chat without one). */
  mainSessionId: string | null;
  needsModel: boolean;
  config: {
    fullAppUrl: string | null;
    effortLevels: EffortLevel[];
    defaultEffort: EffortLevel;
    avatarThemes: AvatarThemeOption[];
    defaultAvatarTheme: string;
  };
};

export type AvatarThemeOption = { id: string; name: string; blurb: string };

export type AppliedBlock = {
  key: string;
  kind: string;
  state: "applying" | "applied" | "failed";
  result: { sessionId: string; name: string } | null;
};

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    body: init?.json === undefined ? (init?.body ?? null) : JSON.stringify(init.json),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(value?.error ?? `Request failed (${response.status})`);
  return value as T;
}

export const appApi = {
  bootstrap: (workspaceId: string) =>
    request<Bootstrap>(`/app/bootstrap?workspaceId=${encodeURIComponent(workspaceId)}`),
  state: (workspaceId: string) =>
    request<AppState>(`/app/state?workspaceId=${encodeURIComponent(workspaceId)}`),
  setPrefs: (workspaceId: string, values: Record<string, string | null>) =>
    request<Record<string, string>>("/app/prefs", {
      method: "PUT",
      json: { workspaceId, values },
    }),
  createBlankAgent: (workspaceId: string, shared: boolean) =>
    request<{ sessionId: string }>("/app/agents", {
      method: "POST",
      json: { workspaceId, shared, requestId: crypto.randomUUID() },
    }),
  usage: (workspaceId: string, sessionId: string, kind: "open" | "send") =>
    request<{ ok: true }>(`/app/agents/${sessionId}/usage`, {
      method: "POST",
      json: { workspaceId, kind },
    }).catch(() => null),
  updateProfile: (
    workspaceId: string,
    sessionId: string,
    patch: { effort?: EffortLevel | null; emoji?: string | null },
  ) =>
    request<AgentProfile>(`/app/agents/${sessionId}/profile`, {
      method: "PUT",
      json: { workspaceId, ...patch },
    }),
  regenerateAvatar: (workspaceId: string, sessionId: string, hint?: string) =>
    request<AgentProfile>(`/app/agents/${sessionId}/avatar`, {
      method: "POST",
      json: { workspaceId, hint: hint ?? null },
    }),
  retryAvatars: (workspaceId: string) =>
    request<{ ok: true }>("/app/avatars/retry", {
      method: "POST",
      json: { workspaceId },
    }).catch(() => null),
  getBlock: (key: string) => request<AppliedBlock | null>(`/app/blocks/${encodeURIComponent(key)}`),
  applyBlock: (input: {
    workspaceId: string;
    key: string;
    kind: "agent" | "profile";
    sourceSessionId: string;
    payload: Record<string, unknown>;
  }) => request<AppliedBlock>("/app/blocks/apply", { method: "POST", json: input }),
};

export const EFFORT_REASONING: Record<EffortLevel, "low" | "medium" | "high"> = {
  fast: "low",
  balanced: "medium",
  thorough: "high",
};

export const EFFORT_LABELS: Record<EffortLevel, { label: string; hint: string }> = {
  fast: { label: "Fast", hint: "Quickest replies" },
  balanced: { label: "Balanced", hint: "Quick and smart" },
  thorough: { label: "Thorough", hint: "Thinks longer" },
};
