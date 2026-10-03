---
name: offload-to-opengeni
description: >-
  Run work in the cloud on an OpenGeni workspace instead of locally. Use when
  the user asks to run something in the cloud, in the background, in parallel,
  "on OpenGeni", or to hand off a long-running task; or asks about the status,
  result, or a follow-up for an OpenGeni session. Creates a session with a
  self-contained brief, reports its link, checks status, fetches results, and
  sends follow-ups through the OpenGeni MCP server.
---

# Offload work to OpenGeni

OpenGeni runs durable agent sessions in the user's workspace, each with its own
cloud sandbox, repository checkout, and connected tools. You talk to it through
the `opengeni` MCP server this plugin connects
(`https://app.opengeni.ai/v1/mcp`). The remote agent does not see this
conversation, your files, or your local machine.

## Tools

The server has three tools that reach every OpenGeni API action. Clients add
their own prefix (in Claude Code:
`mcp__plugin_opengeni_opengeni__opengeni_actions_search`); match on the suffix.

| Tool | Use |
| --- | --- |
| `opengeni_actions_search` | Find an action: `{ query, limit }`, e.g. `"create session"`, `"session events"`, `"github repositories"`. |
| `opengeni_action_describe` | Read an action's path parameters and input schema: `{ id }`. |
| `opengeni_action_call` | Run it: `{ id, pathParameters, query, body }`. |

Describe an action before calling it and send only the fields its schema lists.
Below, "the create-session action" means: find it, describe it, call it. If a
workspace MCP server with `opengeni__session_*` tools is configured instead,
use those tools for the same steps.

The first call opens a browser sign-in where the user picks the organization
and what the agent may do. If the tools are missing or a call fails with an
authentication error, tell the user to sign in to the `opengeni` server: in
Claude Code run `/mcp`, select it, and sign in; in Codex run
`codex mcp login opengeni`. If no server is configured at all, point them to
https://docs.opengeni.ai/guides/coding-agents. Never work around
authentication with API keys, cookies, or other credentials.

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
3. Pick the workspace (list the workspaces; ask once if there are several).
   List its GitHub repositories, find this one, and reference it in the
   session's `resources` with `ref` set to the branch to work on.
4. If the repository is missing, get the GitHub connect link, give it to the
   user, and wait for them to connect it. Do not start a session that silently
   lacks the repository.

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

Run the create-session action with:

- `initialMessage`: the brief.
- `title`: a short, specific title.
- `idempotencyKey`: a fresh UUID. If the call fails with an uncertain outcome,
  retry with the same key and input so you do not create a duplicate.
- `resources`: the repository resource from step 2, when there is code.
- `projectId`: only if the user named a project.

Do not set `model`, `reasoningEffort`, or `latencyMode` unless the user asked
for a specific choice. Omitting them uses the workspace's own default and
billing path, which is the user's choice to make. Never pick a more expensive
model on your own. Leave `sandboxBackend` unset for coding work.

Report the session link,
`https://app.opengeni.ai/workspaces/<workspaceId>/sessions/<sessionId>` (use
the MCP server's origin if it is not `app.opengeni.ai`). Then tell the user
what you delegated and how you will follow up.

## 5. Check status and fetch results

- The get-session action returns `status` (`queued`, `running`, `idle`,
  `requires_action`, `waiting_capacity`, `recovering`, `failed`, `cancelled`)
  plus queue and goal facts. `queued` or a recent `updatedAt` is not proof of
  progress.
- Do not poll in a tight loop. Check when the user asks, when you have other
  work to interleave, or at most every few minutes for a task the user is
  waiting on.
- `requires_action` means the remote agent needs a person (an approval or a
  question). Approvals cannot be answered through this MCP server: send the
  user the session link.
- When the session is `idle` after running, read its events (the
  session-events action) for the final answer, following the page cursor for
  more.
- Verify claims before relaying them as done: fetch the branch, check the pull
  request or CI status, and run the acceptance checks locally when practical.
  Do not merge or deploy without the user's approval.

## 6. Follow up

- Send corrections or the next step as a message to the same session, with a
  new `idempotencyKey`. The session keeps its context and sandbox; prefer it
  over starting a new session for related work.
- Pause stops work resumably; resume continues it (the session control
  action).
- To find an earlier session, list the workspace's sessions.
