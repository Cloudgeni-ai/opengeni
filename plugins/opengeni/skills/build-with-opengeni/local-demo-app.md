# Quick local demo app

The smallest correct app with an Opengeni agent chat: a Vite and React page
that renders `OpenGeniChat`, and one Node server that holds the API key, serves
the page, and runs the packaged session proxy. Every chat started in the page
is a session in an Opengeni workspace, visible in the Opengeni app with the
same messages.

Use this recipe when the user asks for a small, local, or demo app with an
Opengeni agent chat. Follow it as written: do not ask the product questions
from the client guide, and do not add a framework, database, login, or extra
features. To add Opengeni to an existing product, follow
`opengeni-client/SKILL.md` instead.

## What you need

- Node.js 20.19+ or 22.12+ with npm.
- A full-access **organization API key** (`ogk_...`), created in Opengeni under
  Organization settings > Developer.
- The Opengeni URL when it is not Opengeni Cloud (`https://app.opengeni.ai`).
- Optional: the ID of an existing shared workspace to put the chats in.
  Without it, the server creates a workspace named "Local demo".

If the user's request contains the key, write it into `.env` without repeating
it. Otherwise leave `OPENGENI_API_KEY=` empty and ask the user to paste the key
into `.env` themselves; never ask for it in chat. Never print, log, or commit
the key.

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

`npm ls` must show one version for every `@opengeni` package; they release
together at one shared version.

## 2. Add the files

```dotenv .env
OPENGENI_API_KEY=
# Only when not Opengeni Cloud:
# OPENGENI_API_BASE_URL=https://app.opengeni.ai
# Optional: an existing shared workspace. Omit to create "Local demo".
# OPENGENI_WORKSPACE_ID=
# Optional: a model id from the workspace's model picker. Omit for the workspace default.
# OPENGENI_MODEL=
```

```gitignore .gitignore
node_modules
.env
```

```ts server.ts
// The app's server: holds the Opengeni API key, serves the page, and proxies the chat.
import { createServer } from "node:http";
import { OpenGeni } from "@opengeni/sdk/chat";
import { toNodeMiddleware } from "@opengeni/sdk/express";
import { createSessionProxyHandler } from "@opengeni/sdk/session-proxy";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";

const apiKey = process.env.OPENGENI_API_KEY?.trim();
if (!apiKey) throw new Error("Set OPENGENI_API_KEY in .env");
const baseUrl = (process.env.OPENGENI_API_BASE_URL?.trim() || "https://app.opengeni.ai").replace(
  /\/+$/,
  "",
);
const model = process.env.OPENGENI_MODEL?.trim(); // optional; omitted = the workspace default
const port = Number(process.env.PORT ?? 5173);
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const og = new OpenGeni({ apiKey, baseUrl, workspaceName: () => "Local demo" });

// Fails fast on a wrong key or URL. Creates the "Local demo" workspace on first run.
const workspaceId =
  process.env.OPENGENI_WORKSPACE_ID?.trim() || (await og.workspaceId({ tenant: "local-demo" }));

// Demo identity: everyone who opens this local page is one fixed user. A real
// app returns its own signed-in user from `resolve`. Opengeni adds the user to
// the workspace on their first request.
const user = "local-demo-user";

const proxy = toNodeMiddleware(
  createSessionProxyHandler(og, {
    resolve: (request) =>
      origins.has(`http://${request.headers.get("host")}`)
        ? { user, workspaceId }
        : new Response("Forbidden", { status: 403 }),
    authorizeMutation: (request) => origins.has(request.headers.get("origin") ?? ""),
    chats: "shared", // visible to everyone in the workspace, including you in the Opengeni app
    // The browser sends only the first message; the server decides everything else.
    createSession: ({ initialMessage, idempotencyKey }) => ({
      initialMessage,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      agent: { capabilities: "none" }, // chat only
      sandboxBackend: "none", // no cloud computer: replies start in seconds
      ...(model ? { model } : {}),
    }),
  }),
);

const http = createServer();
const vite = await createViteServer({
  plugins: [react()],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server: http } },
});
http.on("request", (req, res) => {
  if (req.url?.startsWith("/api/opengeni/")) proxy(req, res);
  else vite.middlewares(req, res);
});
// Loopback only: anyone who can reach this port chats as the demo user.
http.listen(port, "127.0.0.1", () => {
  console.log(`Chat app: http://127.0.0.1:${port}`);
  console.log(`Sessions: ${baseUrl}/workspaces/${workspaceId}`);
});
```

```html index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opengeni demo</title>
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
import { OpenGeniChat } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

createRoot(document.getElementById("root")!).render(<OpenGeniChat baseUrl="/api/opengeni" />);
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

- **Key stays on the server.** The page talks only to `/api/opengeni`, and the
  proxy forwards only the routes the chat needs, in one workspace.
- **Acts as a user, not as the key.** Every call runs as `local-demo-user`.
  Opengeni adds that user to the workspace on the first request, with chat
  permissions and no admin rights. The Opengeni app shows these sessions as
  created by an external user.
- **Chat only.** `capabilities: "none"` and `sandboxBackend: "none"`, so
  replies start in seconds and the agent can only talk.
- **Loopback only.** The server binds `127.0.0.1` and rejects other `Host` and
  `Origin` values. Do not bind it to `0.0.0.0` or put it behind a tunnel: anyone
  who reaches it chats as the demo user on the organization's key. On a remote
  machine, use SSH port forwarding (`ssh -L 5173:127.0.0.1:5173 <host>`).

## 3. Run and verify

```bash
npx tsc        # optional type check; prints nothing when clean
npm run dev
```

The server prints `Chat app: http://127.0.0.1:5173` and the workspace link.
Startup already proved the key and URL. Then:

1. Check the proxy without running the agent; this prints `200`:
   `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/api/opengeni/v1/config/client`
2. Give the user the chat URL and ask them to send a message. Sending runs the
   agent on the workspace's model and uses its credits or connected
   subscription, so do not send one yourself unless the user asked you to. The
   reply streams into the page, and the chat appears in the list.
3. Open the printed workspace link in Opengeni: the chat is listed under
   Sessions with the same conversation. You can reply there too.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Set OPENGENI_API_KEY in .env` | Fill in `.env`. Restart after every `.env` change. |
| `401` at startup | Wrong key, or a key from another deployment than `OPENGENI_API_BASE_URL`. |
| `needs an organization API key` or `403` on the first message | A workspace key or a read-only key. Create a full-access organization key. |
| `403` with `OPENGENI_WORKSPACE_ID` set | A Personal workspace, or one in another organization. Use a shared workspace of the key's organization, or remove the variable. |
| Startup crashes with `"<name>" is not exported by "@opengeni/..."` | The installed `@opengeni` packages are at different versions. Run `npm install @opengeni/sdk@latest @opengeni/react@latest`, and `npm ls` must show one version. If a lockfile keeps an old copy, `rm -rf node_modules package-lock.json && npm install`. |
| `EADDRINUSE` | Port taken: `PORT=5174 npm run dev`, and use that port in the URLs. |
| The message is sent but no reply, or a model error | The workspace has no usable model. Connect one in Opengeni (Organization settings, Models), or set `OPENGENI_MODEL` to an available model ID. |
| `403` from `/api/opengeni` | The page was opened through another host name than `127.0.0.1` or `localhost`. By design. |

## Next steps

- Real users: return the product's signed-in user from `resolve` (for example
  `{ user: me.id, tenant: me.teamId }`) and keep `authorizeMutation` as the
  product's CSRF check. See `opengeni-client/SKILL.md`.
- The product's data and actions: the proxy's `toolServer` option. See
  `opengeni-client/references/tools-and-auth.md`.
- Production hosting: Next.js (`createSessionProxyRoute` from
  `@opengeni/sdk/next`), Express (`toNodeMiddleware`), or Hono
  (`toHonoHandler` from `@opengeni/sdk/hono`), with the frontend built by
  `vite build`.
