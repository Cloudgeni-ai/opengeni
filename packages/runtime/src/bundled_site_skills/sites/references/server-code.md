# App server code

Server code is a small JavaScript program that ships with an app version and
runs on Opengeni's servers when the app's page calls it. It runs **as the
app**, never as the person viewing it:

- Tool calls use only the workspace's **shared** connector accounts (for
  example a Linear account a workspace admin shared with the workspace),
  never a viewer's own connection, and never yours. So every member sees the
  same data, even one who never connected Linear.
- Outbound `fetch` may send workspace vault secrets (API keys) in headers.
  The page never sees them.
- Writes and business rules run on the server, so the page can't skip them.

Use it when the app needs one of those. Do not add it for things the page can
already do: workspace tools as the viewer, AI, app data, and scheduled refills
(`app_sync_save`) or inbound events (`app_webhook_save`) need no server code.

## The code is the app's security boundary

Everyone who can open the app can call its server code, with the shared
accounts and secrets behind it. That includes invited people and, for an app
published to the web, anonymous guests. So:

- Check `env.viewer` before anything sensitive: `env.viewer.kind` is
  `member`, `invited`, `user` or `guest`. Return 403 when it doesn't fit.
- Return only what the caller should see; filter on the server.
- Before publishing to the web, ask the user whether guests should reach the
  shared accounts at all, and say what they would reach.
- The code is not secret: anyone who can read the app's source can read it.
  Keys live only in the vault (below), never in the code.

## Write it

One or more ES modules. The main module exports `fetch`:

```js
// server/index.js
export default {
  async fetch(request, env) {
    if (env.viewer?.kind !== "member") return new Response("Members only", { status: 403 });
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
| `env.viewer` | Who is asking: `{id, email, name, kind}`, or null for a run nobody started from a page. Trustworthy. |
| `env.app` | `{id, versionId}`. |
| `env.trigger` | `"request"` from `site.server.fetch`, `"manual"` from `app_server_run`. |
| `env.runId` | This run's id, as `app_server_runs` lists it. |
| `env.tools.call(tool, args)` | A tool the bundle lists in `tools`, as `"serverId/toolName"`, on a shared account. Returns the tool's result. |
| `env.data` | App data in shared, shared_read or append_only collections: `query(collection, {where, sort, limit, cursor})` (as in `references/site-data.md`), `get(collection, id)` or `get(collection, {key})`, `put(collection, key, value)`, `insert(collection, value)`, `delete(collection, id)`, `write(operations)`. Writes are the app's, not the viewer's. |
| `fetch(url, init)` | HTTPS to hosts the bundle lists in `egress`. Put a listed vault secret in a header value: `Authorization: "Bearer \{{secret:Shared/Weather/api key}}"`. |

A refused call throws an `Error` whose `code` says why, for example
`shared_account_required`, `tool_not_declared`, `egress_not_listed`,
`run_ended` or `host_call_limit`.

- No Node APIs, file system, or other network access. The page's `cookie`
  and `authorization` headers are not passed on.
- One copy of the code serves many viewers at once: keep nothing about a
  viewer in module-level variables.
- Finish all work before returning the response; `ctx.waitUntil` work is
  cut off when the response is sent.
- `console.log` output is kept with the run. A run that overruns its time is
  stopped and keeps its logs; one killed for CPU loses them.

Limits per run: 30 seconds, 5 seconds of CPU, 50 calls to tools, data and
fetch, 1 MB request and 4 MB response bodies. All code together is at most
1 MB in 50 files. An app starts at most 300 runs a minute, one person at most
60, all guests together at most 150, and guests also count against the app's
guest write limit.

## Call it from the page

```ts
const site = createOpenGeniSiteClient();
const response = await site.server.fetch("/issues");
const issues = await response.json();
```

`site.server.fetch(path, init)` takes a path (with query) and the usual
`method`, `headers` and `body` (a string, bytes, `FormData`, or a value sent
as JSON), and returns a `Response`. It works for every viewer who can open
the app, including invited people and public visitors.

## Ship it

Server code versions with the app: publishing a version with new code deploys
it; rolling back the app rolls back its code. Every publish goes live for all
viewers, so try changes with `app_server_run` right after publishing and roll
back if they fail.

1. Bundle the code into JSON:

   ```json
   {
     "main": "index.js",
     "files": [{ "path": "index.js", "content": "..." }],
     "tools": ["linear/list_issues"],
     "egress": ["api.example.com"],
     "secrets": ["\{{secret:Shared/Weather/api key}}"]
   }
   ```

   A build step (esbuild, Bun) that outputs one ES module is simplest.
2. **Write vault references escaped, as above.** The sandbox fills in every
   unescaped reference it sees in a file you write or a command you run,
   which would put the real key into the code. The backslash keeps the
   reference as text; the uploaded file then holds the plain reference,
   which Opengeni fills in only when the request is sent. Publishing refuses
   code that contains a listed secret's value.
3. `artifacts_prepare_upload` returns a `server` upload URL beside the HTML;
   PUT the JSON there and publish with that `uploadId`.
4. Publishing without a server upload keeps the current code. Upload
   `{"files": []}` to remove it.
5. List every tool the code calls in the bundle's `tools`. Tools there run
   only on shared accounts and only for the server code; the page's
   `requestedTools` run as the viewer, so don't add server tools there.
6. Listing vault secrets needs a workspace integration admin, and `egress`
   must list the hosts they are sent to. Each secret must exist when you
   publish. The code pauses if whoever makes a version current later (a
   rollback, a duplicate) can't use workspace secrets.

To edit existing code, `artifacts_get_source` returns the version's `server`
files as download URLs. App packages don't carry server code yet: after
installing one, publish the code again.

## Check it

- `app_server_run` sends one request to the published code as you and
  returns the response, logs and error.
- `app_server_runs` lists recent runs with logs and errors, newest first.
- Managers see one line in the app's header while the newest run fails or
  the code is paused. When asked about it, read `app_server_runs`, fix the
  code and publish.

When a tool call fails with `shared_account_required`, ask a workspace admin
to connect that service and share it with the workspace; do not fall back to
the viewer's connection.
