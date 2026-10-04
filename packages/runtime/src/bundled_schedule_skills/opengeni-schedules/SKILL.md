---
name: opengeni-schedules
description: Create a schedule, recurring task, reminder, or monitor in OpenGeni. Read this before turning a user's request into scheduled work, including Create with OpenGeni from Schedules. Discover the required resources and integrations, then create the task with the user's cadence and time zone.
---

# Create a schedule

Turn the user's description into scheduled work in the current workspace.
Research what is available before asking questions. Ask only for essential
details you cannot discover or reasonably decide from the request.

## Choose the destination

By default, schedule a message in this conversation. “Remind me”, “check later”,
“keep watching” and “schedule yourself” mean continue this chat. Supply `name`,
`schedule` and `prompt`; the tool resolves the current chat from its signed
context. Choose another existing chat with `targetSessionId` only when requested.
Its model, tools, machine and attachments apply at run time, so do not copy those
settings into the schedule.

Use `reusable_session` or `new_session_per_run` with `agentConfig` only when the
user requests separate-agent work. Sessionless calls require an explicit
destination or a separate-agent mode.

## Discover what the task needs

- Use `scheduled_tasks_list` to avoid duplicating an existing schedule. Follow
  pagination when needed and use `scheduled_tasks_get` for a relevant task's
  details. A list summary is not its complete configuration.
- If the work needs a repository, use `github_repositories_list` to find the
  authorized repository and select the required resources.
- If a separate agent needs sandbox credentials, use `variable_set_list` to find the suitable
  Variable Set. Attach its identifier; do not copy secret values into prompts.
- If it needs an integration such as Slack or Sentry, use
  `capability_catalog_search` and the available tool discovery to find the
  capability and exact operations. Follow returned connection/setup and approval
  requirements. Do not claim that discovery means the integration is ready.

Select only the resources, Variable Set, and tools the task needs. Missing
optional dependencies are not a reason to ask for unnecessary setup. If a
required capability or authority is unavailable, explain the remaining setup
briefly instead of inventing a tool or borrowing another person's connection.

## Create and verify

Use `scheduled_tasks_create` with:

- A short, descriptive name.
- A `prompt` (or `agentConfig.prompt` for a separate agent) describing the work,
  relevant sources and destinations, what to report, and when to stay quiet.
  Preserve the user's requested brevity and notification conditions.
- The requested cadence and time zone. Use the time zone supplied in the
  request unless the user explicitly chooses another. Inspect the current tool
  schema for supported schedule shapes rather than guessing cron fields.
- For a separate agent, the required repository resources, Variable Set, and tool selections.
  Scheduled runs inherit the creating session's tool and permission ceiling;
  this Skill does not grant authority or change approvals.

Honor an explicit run destination. A task prompt must not depend on unrecorded
details from the setup conversation. Do not trigger an extra run or send a test
message unless the user asks for one.

Check the creation receipt and follow its `scheduled_tasks_get` next action to
verify the saved task before claiming success. If it reports a committed
task with a synchronization failure, report that state and recover the existing
task rather than creating a duplicate. On success, briefly tell the user the
schedule's name and first expected run in their time zone. If the exact first
firing cannot be verified from the saved schedule, say so rather than inventing
a timestamp.

## Edit without reconstructing configuration

Use top-level `prompt` to change the message, and `targetSessionId` to move the
schedule to an existing chat. Omitted fields are preserved. Send the saved
`executionDigest` as `expectedExecutionDigest` to protect the reviewed version.
Never rebuild `agentConfig` from a bounded read or hunt for the original creation
call merely to edit a field. If complete message text is needed, page
`scheduled_tasks_get` with `promptOffset=0`, then its `prompt.nextOffset` and
`expectedExecutionDigest`.

A move that changes attached access reports `scheduled_target_access_change`.
Review the named changes against the user's intent before accepting them with
`adoptSessionSettings=true` and the reviewed digest. Do not erase attachments or
broaden selected accounts merely to clear a validation error.

When history is actually needed, `session_events` with `view=tools` and an exact
`toolName` finds calls; use a returned `callId` to read its result. Content-view
pages accept limits up to 50. Follow `nextCursor` unchanged: it preserves the
selection and page size, including fragmented text.
