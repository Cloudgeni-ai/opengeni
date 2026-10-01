---
name: offload-to-opengeni
description: >-
  Run work in the cloud on an OpenGeni workspace instead of locally. Use when
  the user asks to run something in the cloud, in the background, in parallel,
  "on OpenGeni", or to hand off a long-running task; or asks about the status,
  result, or a follow-up for an OpenGeni session. Creates a session with a
  self-contained brief, reports its link, checks status, fetches results, and
  sends follow-ups through the OpenGeni workspace MCP server.
---

# Offload work to OpenGeni

OpenGeni runs durable agent sessions in the user's workspace, each with its own
cloud sandbox, repository checkout, and connected tools. You talk to it through
the workspace MCP server configured by this plugin. The remote agent does not
see this conversation, your files, or your local machine.

## Tools

The OpenGeni MCP server exposes tools named `opengeni__<tool>`. Clients add
their own prefix: in Claude Code with this plugin the full name is
`mcp__plugin_opengeni_opengeni__opengeni__session_create`; with a manually
added server named `opengeni` it is `mcp__opengeni__opengeni__session_create`.
Match on the `opengeni__<tool>` suffix.

| Tool | Use |
| --- | --- |
| `opengeni__session_create` | Start a session. Required: `initialMessage`. Also: `title`, `idempotencyKey`, `resources`, `projectId`, `instructions`, `model`, `reasoningEffort`. |
| `opengeni__session_get` | Status snapshot: `{ sessionId }`. |
| `opengeni__session_events` | History: `{ sessionId, view: "results" \| "conversation" }`, then `cursor: nextCursor`. |
| `opengeni__session_send_message` | Follow-up: `{ sessionId, text, idempotencyKey }`. Queues if the session is busy. |
| `opengeni__session_pause` / `opengeni__session_resume` | `{ sessionId, idempotencyKey }`. Pause is resumable. |
| `opengeni__sessions_list` | Find earlier sessions: `{ query, limit }`. |
| `opengeni__github_repositories_list` | Repositories the workspace can check out, each with a ready `resource` object. |
| `opengeni__github_connect_link` | GitHub connection status and a link for the user to connect it. |
| `opengeni__project_list` | Projects to file the session into. |

If no `opengeni__` tools are available, or a call fails with an authentication
error, stop and tell the user to sign in to the `opengeni` MCP server: in Claude
Code run `/mcp`, select the server, and sign in; in Codex run
`codex mcp login opengeni`; in Gemini CLI run `/mcp auth opengeni`; in Devin
run `devin mcp login opengeni`; in the Cursor CLI run
`agent mcp login opengeni`; in Cursor, VS Code, or Zed use the sign-in prompt
the editor shows for the server. If the server is not configured at all, point
them to https://docs.opengeni.ai/guides/coding-agents. The user must already be
signed in to OpenGeni in their default browser; the consent page then asks for
a workspace: pick the same workspace as in the configured URL. Never work
around authentication with API keys, cookies, or other credentials.

## 1. Decide whether to offload

Offload long-running, parallelizable, or compute-heavy work, and anything the
user explicitly wants run in the cloud or in the background. Keep quick edits,
questions, and work that depends on local-only state (uncommitted changes,
local services, files outside the repository) here, unless the user insists;
then explain what the remote agent will not be able to see.

Each session consumes the workspace's OpenGeni credits or connected model
subscription. Ask before starting more than one session for a single request.

## 2. Make the code reachable

The remote agent clones from the Git host, not from this machine.

1. Check `git status`, the current branch, and whether it is pushed
   (`git rev-parse --abbrev-ref @{upstream}` and `git log @{upstream}..`).
2. If the work needs unpushed commits or uncommitted changes, ask the user
   before committing or pushing anything. Pushing is their decision.
3. Call `opengeni__github_repositories_list`, find the repository, and copy its
   `resource` object into `resources`, setting `ref` to the branch to work on.
4. If the repository is missing, call `opengeni__github_connect_link`, give the
   user the returned link or status, and wait for them to connect it. Do not
   start a session that silently lacks the repository.

## 3. Write a self-contained brief

`initialMessage` is the only context the remote agent gets. Include:

- **Goal**: what to do and why, in a few sentences.
- **Code**: repository, branch, and the relevant files, commands, or errors.
- **Constraints**: what must not change, style or dependency rules from the
  repository's agent instructions that matter here.
- **Acceptance criteria**: the checks that prove it is done, such as tests,
  type checks, or a reproduction that must pass.
- **Delivery**: exactly what the user authorized, for example "push branch
  `fix/flaky-retry` and open a draft pull request" or "do not push; report the
  diff". Pushing, merging, deploying, and messaging people require the user's
  explicit permission.
- **Report**: what to include in the final answer (summary, branch or PR link,
  test results, open questions).

Never put secrets in a session: no API keys, tokens, passwords, private keys,
`.env` contents, or connection strings in `initialMessage`, `instructions`,
`metadata`, or follow-up messages. If the task needs a credential, tell the
user to add it in OpenGeni (Variables or Connections) themselves, and refer to
it by name.

## 4. Create the session

Call `opengeni__session_create` with:

- `initialMessage`: the brief.
- `title`: a short, specific title.
- `idempotencyKey`: a fresh UUID. If the call fails with an uncertain outcome,
  retry with the same key and input so you do not create a duplicate.
- `resources`: the repository resource from step 2, when there is code.
- `projectId`: only if the user named a project (from `opengeni__project_list`).

Do not set `model`, `reasoningEffort`, or `latencyMode` unless the user asked
for a specific choice. Omitting them uses the workspace's own default and
billing path, which is the user's choice to make. Never pick a more expensive
model on your own. Leave `sandboxBackend` unset for coding work.

The receipt's `resource.id` is the session ID. Report the session link:

```text
${user_config.base_url}/workspaces/${user_config.workspace_id}/sessions/<sessionId>
```

Claude Code fills in the two values from the plugin settings. If the line above
still shows `${user_config...}` placeholders, build the link from the OpenGeni
MCP URL the user configured (`<origin>/v1/workspaces/<workspaceId>/mcp` becomes
`<origin>/workspaces/<workspaceId>/sessions/<sessionId>`), or ask the user for
their OpenGeni URL and workspace ID once. Do not search configuration files for
it. Then tell the user what you delegated and how you will follow up.

## 5. Check status and fetch results

- `opengeni__session_get { sessionId }` returns `status` (`queued`,
  `running`, `idle`, `requires_action`, `waiting_capacity`, `recovering`,
  `failed`, `cancelled`) plus queue and goal facts. `queued` or a recent
  `updatedAt` is not proof of progress.
- Do not poll in a tight loop. Check when the user asks, when you have other
  work to interleave, or at most every few minutes for a task the user is
  waiting on.
- `requires_action` means the remote agent needs a person (an approval or a
  question). Approvals cannot be answered through this MCP server: send the
  user the session link.
- When the session is `idle` after running, read
  `opengeni__session_events { sessionId, view: "results" }` for final answers;
  use `view: "conversation"` for recent messages and follow `nextCursor` for
  more.
- Verify claims before relaying them as done: fetch the branch, check the pull
  request or CI status, and run the acceptance checks locally when practical.
  Do not merge or deploy without the user's approval.

## 6. Follow up

- Send corrections or the next step with `opengeni__session_send_message`
  (`sessionId`, `text`, a new `idempotencyKey`). The same session keeps its
  context and sandbox; prefer it over starting a new session for related work.
- Use `opengeni__session_pause` to stop work resumably and
  `opengeni__session_resume` to continue.
- To find an earlier session, use `opengeni__sessions_list` with `query` (title
  or goal words) and `limit`.
