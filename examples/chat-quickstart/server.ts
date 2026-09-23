import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

// Server-side only. The organization API key never reaches the browser.
const og = new OpenGeni({
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
  ...(process.env.OPENGENI_API_BASE_URL ? { baseUrl: process.env.OPENGENI_API_BASE_URL } : {}),
  source: "chat-quickstart",
});

// Stand-in for your own authentication: a real product resolves tenant and
// user from its session cookie or bearer, never from the request body. The
// handler reads the page's x-opengeni-conversation header itself and scopes
// that conversation id to the resolved user, so a guessed id cannot reach
// another user's chat.
const tenant = process.env.DEMO_TENANT ?? "demo-tenant";

const chat = createChatHandler(og, {
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

const port = Number(process.env.PORT ?? 4200);
Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat" || url.pathname === "/api/chat/respond") {
      return chat(request);
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`chat quickstart backend on http://127.0.0.1:${port} (tenant ${tenant})`);
