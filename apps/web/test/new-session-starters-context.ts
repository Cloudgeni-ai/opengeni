// Only context/service boundaries are replaced. No UI, route, or resolver copies.
import { useCallback, useRef } from "react";
import type { AppContextValue } from "../src/context";
import type { OpenGeniClient } from "@opengeni/sdk";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const evidence = { sends: [] as unknown[], saves: [] as unknown[] };
const noop = () => {};
const model = {
  id: "qa-model",
  label: "QA model",
  provider: "openai",
  providerLabel: "OpenAI",
  api: "responses",
  capabilities: { reasoning: { efforts: ["medium"], defaultEffort: "medium" }, latencyModes: [] },
  cost: "free",
  credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
  policyAllowed: true,
  availability: { status: "available", selectable: true, reason: null, checkedAt: null },
};
let draft = {
  revision: 0,
  text: "",
  resources: [],
  tools: [],
  toolsProvided: false,
  model: model.id,
  reasoningEffort: "medium",
  latencyMode: "standard",
  options: {},
  selectionHistory: { projects: [] },
};
export const fixtureClient = {
  uploadFile: async () => {
    throw new Error("QA blocks file uploads");
  },
  getSessionTenancyCreateCapabilities: async () => ({
    activated: true,
    canCreatePrivate: false,
    reason: "available",
  }),
  getWorkspaceModelCatalog: async () => ({ models: [model] }),
  getWorkspaceRealtimeModelCatalog: async () => ({ models: [] }),
  listChannels: async () => [],
  listSessionPage: async () => ({
    sessions: Array.from({ length: 6 }, (_, i) => ({
      id: `qa-session-${i}`,
      workspaceId,
      title: `QA recent session ${i + 1}`,
      status: "idle",
      model: model.id,
      resources: [],
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    pinned: [],
    nextCursor: null,
  }),
  getNewSessionDraft: async () => structuredClone(draft),
  saveNewSessionDraft: async (_id: string, value: typeof draft) => {
    evidence.saves.push(structuredClone(value));
    draft = { ...value, revision: draft.revision + 1, selectionHistory: { projects: [] } };
    return structuredClone(draft);
  },
} as unknown as OpenGeniClient;
const context = {
  client: fixtureClient,
  accessKeyVersion: 0,
  busy: false,
  workspaces: [{ id: workspaceId, kind: "shared", settings: {} }],
  accessContext: {
    subjectId: "qa",
    workspaceGrants: [{ workspaceId, permissions: ["sessions:create", "sessions:read"] }],
    accountGrants: [],
  },
  managedSelfContext: null,
  authSession: null,
  clientConfig: {
    defaultSandboxBackend: "none",
    auth: { mode: "none" },
    fileUploads: { enabled: false },
    voiceInput: { available: false },
    firstPartyMcpTools: { default: [], allowed: [] },
  },
  model: model.id,
  reasoningEffort: "medium",
  latencyMode: "standard",
  selectedCapabilityToolIds: new Set(),
  workspaceDefaultToolIds: [],
  workspaceMcpCatalogReady: true,
  currentResources: [],
  githubRepos: [],
  githubCatalogReady: true,
  personalGitHubCatalogReady: true,
  personalGitHubRepositories: [],
  personalGitHubAuthority: null,
  selectedPersonalGitHubRepoIds: new Set(),
  selectedPersonalGitHubRepoRefs: {},
  selectedRepoIds: new Set(),
  selectedRepoRefs: {},
  manualRepos: [],
  repositoryGroups: [],
  toolMcpServers: [],
  selectedInstallationId: null,
  resetSessionView: noop,
  setModel: noop,
  setReasoningEffort: noop,
  setLatencyMode: noop,
  setSelectedCapabilityToolIds: noop,
  setManualRepos: noop,
  setSelectedRepoIds: noop,
  setSelectedRepoRefs: noop,
  setSelectedPersonalGitHubRepoIds: noop,
  setSelectedPersonalGitHubRepoRefs: noop,
  startSession: async (id: string, submission: unknown) => {
    evidence.sends.push([id, structuredClone(submission)]);
    return null; // Stop at the service boundary; no session, navigation, or agent execution.
  },
} as unknown as AppContextValue;
export const useAppContext = () => context;
export function useLatestCallback<T extends (...args: any[]) => any>(callback: T): T {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}
