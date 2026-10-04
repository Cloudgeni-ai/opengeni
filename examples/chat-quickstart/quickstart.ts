import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

// Server-side only. The organization API key never reaches the browser.
export function openGeniFromEnvironment(environment = process.env): {
  og: OpenGeni;
  tenant: string;
} {
  const og = new OpenGeni({
    apiKey: environment.OPENGENI_API_KEY!,
    ...(environment.OPENGENI_API_BASE_URL ? { baseUrl: environment.OPENGENI_API_BASE_URL } : {}),
    source: "chat-quickstart",
  });
  return { og, tenant: environment.DEMO_TENANT ?? "demo-tenant" };
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
