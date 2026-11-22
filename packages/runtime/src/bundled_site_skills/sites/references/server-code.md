# App server code

Server code is a small JavaScript program that ships with an app version and
runs on Opengeni's servers when the app's page calls it. It runs **as the
app**, never as the person viewing it:

- Tool calls use only the workspace's **shared** connector accounts (for
  example a Linear account a workspace admin shared with the workspace),
  never a viewer's own connection. So every member sees the same data, even
  one who never connected Linear.
- Outbound `fetch` may send workspace vault secrets (API keys) in headers.
  The page never sees them.
- Writes and business rules run on the server, so the page can't skip them.

Use it when the app needs one of those. Do not add it for things the page can
already do: workspace tools as the viewer, AI, app data, and scheduled refills
(`app_sync_save`) or inbound events (`app_webhook_save`) need no server code.

## Write it

One or more ES modules. The main module exports `fetch`:

```js
// server/index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/issues") {
      const result = await env.tools.call("linear/list_issues", { first: 20 });
      return Response.json(result);
    }
    return new Response("Not found", { status: 404 });
  },
};
```

`env` has:

| Field | What it is |
| --- | --- |
| `env.viewer` | Who the page belongs to: `{id, email, name, kind}`, or null. Trustworthy; check it for per-person rules. |
| `env.app` | `{id, versionId}`. |
| `env.trigger` | `"request"` from `site.server.fetch`, `"manual"` from `app_server_run`. |
| `env.tools.call(tool, args)` | A tool the version declares in `requestedTools`, as `"serverId/toolName"` or `{serverId, toolName}`, on a shared account. Returns the tool's result. |
| `env.data` | App data in shared, shared_read or append_only collections: `query(collection, {where, sort, limit, cursor})` (as in `references/site-data.md`), `get(collection, id)` or `get(collection, {key})`, `put(collection, key, value)`, `insert(collection, value)`, `delete(collection, id)`, `write(operations)`. Writes are the app's, not the viewer's. |
| `fetch(url, init)` | HTTPS to hosts the version lists in `egress`. Put a listed vault secret in a header value: `Authorization: "Bearer {{secret:Shared/Weather/api key}}"`. |

No Node APIs, file system, timers past the run, or other network access.
`console.log` output is kept with the run.

Limits per run: 30 seconds, 5 seconds of CPU, 50 calls to tools, data and
fetch, 1 MB request and 4 MB response bodies. All code together is at most
1 MB in 50 files. An app starts at most 300 runs a minute.

## Call it from the page

```ts
const site = createOpenGeniSiteClient();
const response = await site.server.fetch("/issues");
const issues = await response.json();
```

`site.server.fetch(path, init)` takes a path (with query) and the usual
`method`, `headers` and `body`, and returns a `Response`. It works for every
viewer who can open the app, including invited people and public visitors.

## Ship it

Server code versions with the app: publishing a version with new code deploys
it; rolling back the app rolls back its code.

1. Bundle the code into JSON: `{"main": "index.js", "files": [{"path":
   "index.js", "content": "..."}], "egress": ["api.example.com"], "secrets":
   ["{{secret:Shared/Weather/api key}}"]}`. A build step (esbuild, Bun) that
   outputs one ES module is simplest.
2. `artifacts_prepare_upload` returns a `server` upload URL beside the HTML;
   PUT the JSON there and publish with that `uploadId`.
3. Publishing without a server upload keeps the current code. Upload
   `{"files": []}` to remove it.
4. Declare every tool the code calls in the version's `requestedTools`.
   Listing vault secrets needs a workspace integration admin; each secret
   must exist when you publish.

To edit existing code, `artifacts_get_source` returns the version's `server`
files as download URLs.

## Check it

- `app_server_run` sends one request to the published code as you and
  returns the response, logs and error.
- `app_server_runs` lists recent runs with logs and errors, newest first.
- Managers see one line in the app's header when today's runs had errors.
  When asked about it, read `app_server_runs`, fix the code and publish.

When a tool call fails with "no shared account", ask a workspace admin to
connect that service and share it with the workspace; do not fall back to
the viewer's connection.
