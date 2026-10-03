---
name: opengeni-schedules
description: Create a schedule, recurring task, reminder, or monitor in OpenGeni. Read this before turning a user's request into scheduled work, including Create with OpenGeni from Schedules. Discover the required resources and integrations, then create the task with the user's cadence and time zone.
---

# Create a schedule

Turn the user's description into scheduled work in the current workspace.
Research what is available before asking questions. Ask only for essential
details you cannot discover or reasonably decide from the request.

## Discover what the task needs

- Use `scheduled_tasks_list` to avoid duplicating an existing schedule. Follow
  pagination when needed and use `scheduled_tasks_get` for a relevant task's
  details. A list summary is not its complete configuration.
- If the work needs a repository, use `github_repositories_list` to find the
  authorized repository and select the required resources.
- If it needs sandbox credentials, use `variable_set_list` to find the suitable
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
- A self-contained `agentConfig.prompt` that each run can start from: the work,
  relevant sources and destinations, what to report, and when to stay quiet.
  Preserve the user's requested brevity and notification conditions.
- The requested cadence and time zone. Use the time zone supplied in the
  request unless the user explicitly chooses another. Inspect the current tool
  schema for supported schedule shapes rather than guessing cron fields.
- The required repository resources, Variable Set, and tool selections.
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
