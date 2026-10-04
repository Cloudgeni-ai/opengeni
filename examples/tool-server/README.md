# Your own tools, as the signed-in user

A tiny Express product that gives the OpenGeni agent its own data through an MCP
server built with the official MCP SDK. The packaged session proxy attaches the
server to every chat with a short-lived per-user token, refreshes it on every
message and approval, and `verifyToolRequest` checks it on every MCP call.
`rename_post` waits for the user's approval; `search_posts` runs directly.

```bash
# .env.local:
# OPENGENI_API_BASE_URL=https://app.opengeni.ai
# OPENGENI_ORGANIZATION_ID=...
# OPENGENI_API_KEY=ogk_...          # full-access organization key, server only
bun run setup                       # prints OPENGENI_WORKSPACE_ID=...; add it to .env.local
cloudflared tunnel --url http://localhost:4101   # OpenGeni must reach /api/mcp over HTTPS
# add OPENGENI_TOOL_SERVER_URL=https://<name>.trycloudflare.com/api/mcp to .env.local
bun run dev                         # http://localhost:4101
bun run e2e ada                     # chat through the proxy as "ada"
```

`e2e.ts` drives the proxy exactly like the browser: it asks which posts mention
"launch" (answered from `search_posts`), asks to rename one (the session pauses
in `requires_action`), approves, and prints the renamed post. Run it as `grace`
to see that she cannot read or rename Ada's posts: scope comes from the verified
token, never from ids the model sends.

The demo `resolve` trusts an `x-demo-user` header. A real product returns the
user from its own session cookie and passes its CSRF check as
`authorizeMutation`.
