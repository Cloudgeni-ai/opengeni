import { OpenGeniClient } from "@opengeni/sdk";
import { resolve } from "node:path";
import { createHostHandler, sameOrigin, type HostIdentity } from "./host";

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the server's .env.local.`);
  return value;
}

if (import.meta.main) {
  const origin = new URL(required("HOST_ORIGIN")).origin;
  const demo = process.env.HOST_DEMO_AUTH === "1";
  if (!demo || !["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) {
    throw new Error(
      "This launcher is local-demo-only. Supply your host authentication adapter from README.md for production.",
    );
  }
  const identity = {
    tenantId: required("HOST_TENANT_ID"),
    userId: required("HOST_USER_ID"),
    workspaceId: required("OPENGENI_WORKSPACE_ID"),
    source: required("HOST_IDENTITY_SOURCE"),
  };
  const cookies = new Map<string, { identity: HostIdentity; expires: number }>();
  const api = createHostHandler(
    new OpenGeniClient({
      baseUrl: required("OPENGENI_API_BASE_URL"),
      apiKey: required("OPENGENI_API_KEY"),
    }),
    {
      origin,
      authenticate: async (request) => {
        const token = request.headers
          .get("cookie")
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("harbor_session="))
          ?.slice("harbor_session=".length);
        const session = token ? cookies.get(token) : undefined;
        return session && session.expires > Date.now() ? session.identity : null;
      },
    },
  );
  const dist = resolve(import.meta.dir, "../dist");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 4104),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/demo-login" && request.method === "POST") {
        if (!sameOrigin(request, origin)) return new Response("Forbidden", { status: 403 });
        const token = crypto.randomUUID();
        cookies.set(token, {
          identity: { ...identity, csrf: crypto.randomUUID() },
          expires: Date.now() + 3_600_000,
        });
        return Response.json(
          { signedIn: true },
          {
            headers: {
              "set-cookie": `harbor_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${origin.startsWith("https:") ? "; Secure" : ""}`,
              "cache-control": "no-store",
            },
          },
        );
      }
      if (path.startsWith("/api/")) return api(request);
      if (!["GET", "HEAD"].includes(request.method))
        return new Response("Not found", { status: 404 });
      // Serve only the built SPA and Vite's generated assets; never source/.env.
      if (path !== "/" && !/^\/assets\/[\w.-]+$/.test(path))
        return new Response("Not found", { status: 404 });
      const file = Bun.file(resolve(dist, path === "/" ? "index.html" : `.${path}`));
      if (!(await file.exists()))
        return new Response("Run npm run build first, or use Vite on port 3104.", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "content-type": file.type,
          "cache-control": path === "/" ? "no-cache" : "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    },
  });
  console.log(`Harbor backend listening at ${server.url} (browser origin ${origin}).`);
}
