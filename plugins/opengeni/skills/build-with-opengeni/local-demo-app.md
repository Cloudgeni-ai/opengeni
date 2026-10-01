# Quick local demo app

The smallest correct app with an OpenGeni agent chat: a Vite + React page that
renders `@opengeni/react`'s `OpenGeniChat`, and one Node server that holds the
API key, serves the page, and runs the packaged session proxy from
`@opengeni/sdk`. Every chat the user starts in the page is a session in their
OpenGeni workspace, visible in the OpenGeni app with the same messages.

Use this recipe when the user asks for a small, local, or demo app with an
OpenGeni agent chat, for example "create a small local web app with an Opengeni
agent chat". Follow it as written: do not ask the four product questions from
`SKILL.md`, and do not add a framework, database, login, or extra features. To
add OpenGeni to an existing product, use `SKILL.md` instead.

## What you need

- Node.js 20.19+ or 22.12+ with npm.
- An **organization API key** (`ogk_...`, full access), the **organization ID**,
  and the ID of a **shared workspace** in that organization (not a Personal
  workspace). OpenGeni's Get started page shows all three; the key is also
  created under Organization settings, Developer.
- The OpenGeni URL when it is not OpenGeni Cloud (`https://app.opengeni.ai`).

Put the IDs from the user's request into `.env` yourself. For the key, create
`.env` with an empty `OPENGENI_API_KEY=` and ask the user to paste the key there,
unless they already put it in `.env` or the environment. Never ask for the key
in chat, and never print, log, or commit it.

## 1. Create the project

In a new folder outside any existing repository (default `opengeni-demo/`):

```bash
mkdir opengeni-demo && cd opengeni-demo
npm init -y
npm pkg set type=module scripts.dev="tsx --env-file=.env server.ts"
npm install @opengeni/sdk@latest @opengeni/react@latest react react-dom
npm install -D vite @vitejs/plugin-react tsx typescript @types/node @types/react @types/react-dom
npm ls @opengeni/sdk @opengeni/react
```

`npm ls` must show one `@opengeni/sdk` version, equal to `@opengeni/react`'s.

## 2. Add the files

```dotenv .env
OPENGENI_API_KEY=
OPENGENI_BASE_URL=https://app.opengeni.ai
OPENGENI_ORGANIZATION_ID=
OPENGENI_WORKSPACE_ID=
# Optional: a model id from the workspace's model picker. Omit to use the workspace default.
# OPENGENI_MODEL=
```

```gitignore .gitignore
node_modules
.env
```

```ts server.ts
// The app's server: holds the OpenGeni API key, serves the page, and proxies the chat.
import { createServer } from "node:http";
import { createSessionProxyHandler, OpenGeniClient } from "@opengeni/sdk";
import { toNodeMiddleware } from "@opengeni/sdk/express";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
};
const apiKey = required("OPENGENI_API_KEY");
const baseUrl = (process.env.OPENGENI_BASE_URL?.trim() || "https://app.opengeni.ai").replace(
  /\/+$/,
  "",
);
const organizationId = required("OPENGENI_ORGANIZATION_ID");
const workspaceId = required("OPENGENI_WORKSPACE_ID");
const model = process.env.OPENGENI_MODEL?.trim(); // optional; omitted = the workspace default
const port = Number(process.env.PORT ?? 5173);
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const og = new OpenGeniClient({ baseUrl, apiKey });

// Fail fast on a wrong key, URL, or ID.
const workspace = await og.getWorkspace(workspaceId);
if (workspace.accountId !== organizationId || workspace.kind !== "shared") {
  throw new Error(`${workspaceId} is not a shared workspace of organization ${organizationId}`);
}

// Demo identity: everyone who opens this local page is one fixed user. A real app
// resolves its own signed-in user in `resolve` and onboards each user once.
const user = "local-demo-user";
const source = "local-demo";
// Idempotent: repeating it with the same permissions changes nothing.
await og.addExternalWorkspaceMember(workspaceId, {
  identity: { externalId: user, source },
  permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
});

const proxy = toNodeMiddleware(
  createSessionProxyHandler(og, {
    // Every request acts as `user` in this one workspace (asUser), never as the key itself.
    resolve: (request) =>
      origins.has(`http://${request.headers.get("host")}`)
        ? { workspaceId, user, source }
        : new Response("Forbidden", { status: 403 }),
    authorizeMutation: (request) => origins.has(request.headers.get("origin") ?? ""),
    // The browser sends only the first message; the server decides everything else.
    createSession: ({ initialMessage, idempotencyKey }) => ({
      initialMessage,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      sandboxBackend: "none", // chat only: no cloud computer, replies start in seconds
      tools: [],
      firstPartyMcpTools: [],
      bundledSkillIds: [],
      ...(model ? { model } : {}),
    }),
  }),
);

const http = createServer();
const vite = await createViteServer({
  plugins: [react()],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server: http } },
  define: { "import.meta.env.OPENGENI_WORKSPACE_ID": JSON.stringify(workspaceId) },
});
http.on("request", (req, res) => {
  if (req.url?.startsWith("/api/opengeni/")) proxy(req, res);
  else vite.middlewares(req, res);
});
// Loopback only: anyone who can reach this port chats as the demo user.
http.listen(port, "127.0.0.1", () => {
  console.log(`Chat app: http://127.0.0.1:${port}`);
  console.log(`Sessions: ${baseUrl}/workspaces/${workspaceId} (${workspace.name})`);
});
```

```html index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenGeni demo</title>
  </head>
  <body style="margin: 0; height: 100dvh">
    <div id="root" style="height: 100%"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```tsx src/main.tsx
// The browser never sees the API key: it talks only to this app's /api/opengeni proxy.
import { createRoot } from "react-dom/client";
import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react";
import "@opengeni/react/compiled.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={import.meta.env.OPENGENI_WORKSPACE_ID}>
    <OpenGeniChat />
  </OpenGeniProvider>,
);
```

```json tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vite/client"]
  }
}
```

What the server does, so you can explain it:

- **Key stays on the server.** The page uses an unmodified `OpenGeniClient`
  pointed at `/api/opengeni`; `createSessionProxyHandler` forwards only the
  routes the chat needs, pinned to `OPENGENI_WORKSPACE_ID`.
- **Acts as a user, not as the key.** The proxy runs every call through
  `asUser("local-demo-user", { source: "local-demo" })`. That external user
  must be a workspace member, so the server onboards it at startup with the
  smallest chat permissions. OpenGeni shows these sessions as created by an
  external user; there is no display-name field for external users.
- **Chat only.** `sandboxBackend: "none"`, no tools, and no bundled guidance,
  so replies start in seconds and the agent can only talk.
- **Loopback only.** The server binds `127.0.0.1` and rejects other `Host` and
  `Origin` values. Do not bind it to `0.0.0.0` or put it behind a tunnel: anyone
  who reaches it chats as the demo user on the organization's key. On a remote
  machine, use SSH port forwarding (`ssh -L 5173:127.0.0.1:5173 <host>`).

## 3. Run and verify

```bash
npx tsc        # optional type check; prints nothing when clean
npm run dev
```

The server prints `Chat app: http://127.0.0.1:5173` and the OpenGeni workspace
link. Startup already proved the key, URL, and IDs. Then:

1. Check the proxy without running the agent; this prints `200`:
   `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/api/opengeni/v1/workspaces/<workspace ID>`
2. Give the user the chat URL and ask them to send a message. Sending runs the
   agent on the workspace's model and uses its credits or connected
   subscription, so do not send one yourself unless the user asked you to. The
   reply streams into the page, and the chat appears in the list on the left.
3. In OpenGeni, open the workspace (`<OpenGeni URL>/workspaces/<workspace ID>`):
   the chat is listed under Sessions, titled after its first message, with the
   same conversation. You can reply there too.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Set OPENGENI_... in .env` | Fill in `.env`. Restart after every `.env` change. |
| `401` at startup | Wrong key, or a key from another deployment than `OPENGENI_BASE_URL`. |
| `... is not a shared workspace of organization ...` | A Personal workspace or a mismatched organization ID. Use a shared workspace of that organization. |
| `403 external onboarding requires an organization service key` or `membership exceeds key authority` | A workspace key or a read-only organization key. Create a full-access organization key. |
| `409 existing membership differs` | The demo user was onboarded before with other permissions. Change `user` to a new ID. |
| Startup crashes with `"ConnectPopupClosedError" is not exported by "@opengeni/connect"` | The published `@opengeni/connect` is older than `@opengeni/react` needs (seen with 7.4.0 and connect 0.3.0). Run `npm pkg set overrides.@opengeni/connect=canary`, then `rm -rf node_modules package-lock.json && npm install` (a plain `npm install` keeps the locked version). Remove the override once a newer `@opengeni/connect` is on `latest`. |
| `EADDRINUSE` | Port taken: `PORT=5174 npm run dev`, and use that port in the URLs. |
| The message is sent but no reply, or a model error | The workspace has no usable model for this user. Connect one in OpenGeni (Organization settings, Models), or set `OPENGENI_MODEL` to an available model ID. |
| `403` from `/api/opengeni` | The page was opened through another host name than `127.0.0.1` or `localhost`. By design. |

## Next steps

- Give the agent the product's data and actions: an MCP server in
  `createSession` (`mcpServers` plus a matching `tools: [{ kind: "mcp", id }]`)
  and `mcp_servers:attach` in the onboarding permissions. See `SKILL.md`.
- Real users: replace the fixed user in `resolve` with the product's own signed
  in user, onboard each user once when they join, and keep `authorizeMutation`
  as the product's CSRF check.
- Production hosting: Express (`app.use("/api/opengeni", toNodeMiddleware(handler))`),
  Hono (`@opengeni/sdk/hono`), or Next.js (`createSessionProxyRoute` from
  `@opengeni/sdk/next`), with the frontend built by `vite build`.
