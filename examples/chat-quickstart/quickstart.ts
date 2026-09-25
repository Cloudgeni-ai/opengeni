import type { KnownPermission } from "@opengeni/sdk";
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

/**
 * Workspace permissions a product user needs for this chat: open and create
 * conversations, read and stream them, and send follow-ups or answer pending
 * approvals and questions. Grant more only for features your product exposes.
 */
export const CHAT_USER_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
] as const satisfies readonly KnownPermission[];

// Server-side only. The organization API key never reaches the browser.
export function openGeniFromEnvironment(environment = process.env): {
  og: OpenGeni;
  tenant: string;
} {
  const og = new OpenGeni({
    apiKey: environment.OPENGENI_API_KEY!,
    organizationId: environment.OPENGENI_ORGANIZATION_ID!,
    ...(environment.OPENGENI_API_BASE_URL ? { baseUrl: environment.OPENGENI_API_BASE_URL } : {}),
    source: "chat-quickstart",
  });
  return { og, tenant: environment.DEMO_TENANT ?? "demo-tenant" };
}

/**
 * Explicit onboarding: make one product user a member of the tenant's
 * workspace. Chat requests never grant membership, so run this when your
 * product admits the user to the tenant, not on every message. Store the
 * operation id first and reuse it only to retry this same request; a replay
 * never restores a membership that was removed afterwards.
 */
export async function onboardChatUser(
  og: OpenGeni,
  input: { tenant: string; user: string; operationId: string },
): Promise<string> {
  const workspaceId = await og.workspaceId({ tenant: input.tenant });
  await og.client.addExternalWorkspaceMember(workspaceId, {
    identity: { externalId: input.user, source: og.source },
    permissions: [...CHAT_USER_PERMISSIONS],
    operationId: input.operationId,
  });
  return workspaceId;
}

// Stand-in for your own authentication: a real product resolves tenant and
// user from its session cookie or bearer, never from the request body. The
// handler reads the page's x-opengeni-conversation header itself. Conversation
// ids are not namespaced per user: OpenGeni authorization decides who may open
// a conversation, so a real product also checks the user may use that id.
export function createQuickstartChatHandler(
  og: OpenGeni,
  tenant: string,
): (request: Request) => Promise<Response> {
  return createChatHandler(og, {
    resolve: async (request) => {
      const user = request.headers.get("x-demo-user");
      if (!user) return new Response("Unauthorized", { status: 401 });
      return {
        tenant,
        user,
        agentAccess: "session", // every chat isolated; "user" or "workspace" widen it
        memory: "user", // the agent remembers this user across their chats
        create: { sandboxBackend: "none" }, // pure chat, no sandbox
      };
    },
  });
}
