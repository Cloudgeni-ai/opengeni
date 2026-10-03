// Preview-only authority and API fixture: never creates or exposes a real key.
export const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "44444444-4444-4444-8444-444444444444";
const restricted = new URLSearchParams(location.search).has("restricted");
export const submittedRequests: unknown[] = [];
const context = {
  client: {
    listApiKeys: async () => [],
    createApiKey: async (
      _workspaceId: string,
      request: { name: string; permissions: string[]; expiresAt?: string },
    ) => {
      submittedRequests.push(request);
      return {
        apiKey: {
          ...request,
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accountId,
          workspaceId,
          description: null,
          prefix: "fixture",
          revokedAt: null,
          lastUsedAt: null,
          createdAt: "2026-09-30T10:00:00.000Z",
          updatedAt: "2026-09-30T10:00:00.000Z",
        },
        token: "fixture-only-not-a-real-key",
      };
    },
  },
  accessContext: {
    workspaceGrants: [
      {
        workspaceId,
        accountId,
        permissions: restricted
          ? ["api_keys:manage", "workspace:read", "sessions:read"]
          : ["workspace:admin", "members:manage", "secrets:read"],
      },
    ],
    accountGrants: [],
  },
  workspaces: [{ id: workspaceId, name: "Design preview", accountId }],
  captureWorkspaceInvocation: () => ({ workspaceId }),
  ownsWorkspaceInvocation: () => true,
};
export const useAppContext = () => context;
