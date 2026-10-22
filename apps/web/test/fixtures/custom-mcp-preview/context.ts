import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";

const params = new URLSearchParams(window.location.search);
const canManage = params.get("role") !== "viewer";
let attempt: ConnectAttempt;
const capability = {
  id: "mcp:records", kind: "mcp", name: "Records MCP", enabled: true,
  runtime: { mcpServerId: "records" }, tools: [{ kind: "mcp", id: "records" }],
};
const transport: ConnectTransport = {
  catalog: async () => [], accounts: async () => [], pending: async () => [],
  begin: async (_workspace, input) => {
    attempt ??= {
      id: "sample-setup", workspaceId: "sample", providerId: "mcp-headers",
      ownership: input.ownership, mcpSetup: input.mcpSetup,
      revision: 1, state: "credential_input", credentialsCommitted: false,
      integrationInstalled: false, completionRequirement: "integration",
      expiresAt: "2030-01-01T00:00:00Z",
      nextAction: { type: "credentials", fields: [{ name: "key", label: "API key", required: true, secret: true }] },
    };
    return structuredClone(attempt);
  },
  get: async () => structuredClone(attempt),
  advance: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    attempt = params.get("result") === "rejected"
      ? { ...attempt, revision: attempt.revision + 1,
          error: { code: "mcp_verification_failed", message: "Verification failed", retryable: false } }
      : { ...attempt, revision: attempt.revision + 1, state: "complete",
          credentialsCommitted: true, integrationInstalled: true,
          mcpCapabilityId: capability.id, nextAction: { type: "none" } };
    return structuredClone(attempt);
  },
  cancel: async () => {
    attempt = { ...attempt, revision: attempt.revision + 1, state: "cancelled", nextAction: { type: "none" } };
    return structuredClone(attempt);
  },
  disconnect: async () => {},
};
const client = {
  listCapabilities: async () => ({ items: attempt?.state === "complete" ? [capability] : [] }),
  createCapability: async () => await new Promise(() => {}),
  connectTransport: () => transport,
  getSession: async () => ({ id: "sample-session", tools: [], firstPartyMcpTools: [],
    toolPolicy: { mode: "explicit" }, toolPolicyVersion: 1 }),
  updateSessionToolPolicy: async () => {
    if (params.get("result") === "access-failed") throw new Error("Selection changed");
    return { firstPartyMcpTools: [] };
  },
};

export function useAppContext() {
  return {
    client,
    workspaceCapabilityCatalog: [],
    accessContext: {
      subjectId: "sample-human",
      workspaceGrants: [{ workspaceId: "sample", permissions: canManage ? ["capabilities:manage", "connections:write"] : [] }],
    },
  };
}