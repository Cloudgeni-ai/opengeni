import { createQuickstartChatHandler, openGeniFromEnvironment } from "./quickstart";

// No onboarding step: the tenant workspace is created on first use, and Opengeni
// adds each product user to it on their first request.
const { og, tenant } = openGeniFromEnvironment();
const chat = createQuickstartChatHandler(og, tenant);

const port = Number(process.env.PORT ?? 4200);
Bun.serve({
  hostname: "127.0.0.1",
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
