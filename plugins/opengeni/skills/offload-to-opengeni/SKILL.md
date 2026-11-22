---
name: offload-to-opengeni
description: >-
  Run work in the cloud on an Opengeni workspace instead of locally. Use when
  the user asks to run something in the cloud, in the background, in parallel,
  "on Opengeni", or to hand off a long-running task; or asks about the status,
  result, or a follow-up for an Opengeni session; or to share Skills,
  Knowledge, apps or files with the workspace, or change its schedules or
  agents. Uses the Opengeni MCP server.
---

# Offload work to Opengeni

Opengeni runs durable agent sessions in the user's workspace, each with its own
cloud sandbox, repository checkout, and connected tools. You talk to it through
the `opengeni` MCP server this plugin connects
(`https://app.opengeni.ai/v1/mcp`). The remote agent does not see this
conversation, your files, or your local machine.

## Tools

The server has named tools for the common steps. Clients add their own prefix
(in Claude Code: `mcp__plugin_opengeni_opengeni__delegate`); match on the
suffix.

| Tool | Use |
| --- | --- |
| `delegate` | Start an Opengeni chat: `message`, optional `repository` (owner/name), `branch`, `agent`, `sandboxEnvironment`, `title`. |
| `wait_for` | Wait up to 50 s for a chat: `sessionId`, `cursor`. `done` means it finished with a final answer. |
| `session_send`, `sessions_list`, `session_get`, `session_events`, `session_pause`, `session_resume` | Follow up on, find and control chats. |
| `agents_list`, `sandbox_environments_list`, `workspaces_list`, `workspace_use` | Choices for `delegate`; set the default workspace of this connection. |
| `apps_list`, `app_describe`, `app_query`, `app_write` | Read and change data in the workspace's apps. |
| `app_save`, `app_publish`, `file_save` | Share what you built: save an app (new or a new version), choose who can open it, share a file. |
| `tools_search`, `tool_call` | Use the workspace's connected tools. |
| `skills_sync`, `skills_list`, `knowledge_search`, `knowledge_get`, `knowledge_save` | Share Skills and Knowledge with the workspace. |

`skills_sync` uploads local Skill folders as Personal unless `scope` is
`workspace` or `organization` (which may wait for review, per the workspace's
Agent learning setting); `direction: "pull"` gets the workspace's Skills;
`direction: "repository"` syncs a public GitHub repository's Skill folders. Schedules, agents (their instructions) and
workspace instructions change through `opengeni_actions_search`,
`opengeni_action_describe`, then `opengeni_action_call`.

For anything else, `opengeni_actions_search`, `opengeni_action_describe` and
`opengeni_action_call` reach every Opengeni API action.

The first call opens a browser sign-in where the user picks the organization
and what the agent may do. If the tools are missing or a call fails with an
authentication error, tell the user to sign in to the `opengeni` server: in
Claude Code run `/mcp`, select it, and sign in; in Codex run
`codex mcp login opengeni`. If no server is configured at all, suggest
`npx opengeni connect` or point them to
https://docs.opengeni.ai/guides/coding-agents. Never work around
authentication with API keys, cookies, or other credentials.

## 1. Decide whether to offload

Offload long-running, parallelizable, or compute-heavy work, and anything the
user explicitly wants run in the cloud or in the background. Keep quick edits,
questions, and work that depends on local-only state (uncommitted changes,
local services, files outside the repository) here, unless the user insists;
then explain what the remote agent will not be able to see.

Each session uses the workspace's Opengeni credits or connected model
subscription.

## 2. Make the code reachable

The remote agent clones from the Git host, not from this machine.

Unpushed commits and uncommitted changes aren't visible to it. Pass the
repository as `owner/name` and the branch to work on. With several
workspaces, `delegate` lists them: pass `workspaceId`, or call
`workspace_use` once. If `delegate` reports the repository is missing, give
the user the GitHub connect link it returns (or `opengeni_actions_search`
"github connect").

## 3. Write a self-contained brief

`message` is the only context the remote agent gets. Include:

- **Goal**: what to do and why, in a few sentences.
- **Code**: repository, branch, and the relevant files, commands, or errors.
- **Constraints**: what must not change, style or dependency rules from the
  repository's agent instructions that matter here.
- **Acceptance criteria**: the checks that prove it is done, such as tests,
  type checks, or a reproduction that must pass.
- **Delivery**: what the user authorized, for example "push branch
  `fix/flaky-retry` and open a draft pull request" or "do not push; report the
  diff".
- **Report**: what to include in the final answer (summary, branch or PR link,
  test results, open questions).

Never put secrets in a session: no API keys, tokens, passwords, private keys,
`.env` contents, or connection strings in the message or follow-ups. If the task needs a credential, tell the
user to add it in Opengeni (Variables or Connections) themselves, and refer to
it by name.

## 4. Delegate

Call `delegate` with the brief as `message`, a short `title`, and the
`repository` and `branch`. `agent` and `sandboxEnvironment` are optional; the
workspace defaults apply otherwise. Retrying `delegate` with the same input
doesn't start a second chat; errors say whether a retry is safe.

Pushing, merging, deploying and messaging people need the user's permission.

Report the returned `url`, then tell the user what you delegated and how you
will follow up.

## 5. Wait and fetch results

- Call `wait_for` with the `sessionId` and the returned `cursor`; call again
  with the new cursor while `state` is `running`. Interleave other work
  rather than looping when the task is long.
- `done`: relay `finalAnswer`. `needs_attention`: the remote agent needs a
  person (an approval or a question); send the user the `url`. `failed`:
  report the error.
- Stopping your wait stops only your tracking; the chat keeps running. Use
  `session_pause` to stop it.

## 6. Follow up

- Send corrections or the next step with `session_send`, then `wait_for`
  with its `cursor` and `turnId`. The chat keeps its context and sandbox; prefer it over
  starting a new chat for related work.
- `session_pause` stops work resumably; `session_resume` continues it.
- `sessions_list` finds earlier chats.

## Tools that need approval

`tools_search` shows which tools need a person's approval. When `tool_call`
returns `needsApproval`, give the user `approvalUrl`; after they approve,
call `tool_call` again with the same `operationId`.
