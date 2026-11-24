---
name: agents
description: Create an agent with the person, from a plain description of its job, and save it once they confirm. Read this before creating, setting up or making an agent.
---

# Create an agent

An agent is a named helper people start chats with, here and in Slack. Its
Instructions apply in every chat with it; triggers are automations that start
a chat with it.

## 1. Draft it

From what the person said, draft:

- **Name**: two or three words, how people will call it. **Description**: one
  sentence on what it helps with.
- **Instructions**, written to the agent: its job, how to do it step by step,
  when to involve a person, and what to save to Memory. Keep them short.
- **Can use**: rules only make its chats stricter than the connections'
  own settings. Add the safety rules its job needs, such as asking before
  merging (`github.com`, `merge_pull_request`, `ask`). Leave out connections
  it simply uses.
- **Skills** it relies on, by name, from the workspace's Skills.
- **When it starts**: the common triggers below that fit its job.

Check that the apps it needs are connected (`capability_catalog_search`,
`event_sources_list`). If one is missing, say what it blocks and offer its
setup.

## 2. Confirm

Show the draft in one short message. Then make one `request_human_input` call
with two questions: a `multi_select` "When should it start?" listing the common
triggers it can use (mark the ones its job implies as recommended), and a
`single_select` with `confirm` whose options are "Create agent" and "Change
something". Change the draft until the person confirms.

## 3. Save

Save with `bot_template_save`: `name`, `description`, `avatar`,
`instructions`, `toolPermissions` and `skills`. Then add each picked trigger
with `scheduled_tasks_create`:

- `name`: "<agent name>: <trigger name>", exactly, so its page shows the
  trigger as on.
- `runMode`: `new_session_per_run`, `agentConfig.agentName`: the agent's name,
  `prompt`: the trigger's message. Leave `agentConfig.tools` out.
- An Only me agent's trigger is Only me; any other is shared with the
  workspace.

A GitHub trigger listens on the workspace's GitHub source from
`event_sources_list` (a `readyToAdd` one works too). If there is none, tell
the person to turn the trigger on from the agent's page in Agents, which adds
the source.

Finish with what was created: the agent, its triggers, how to ask it in Slack
(the result's `slack` field), and that its page in Agents changes any of it.

## Common triggers

The agent's page offers the same list as on/off switches.

- **When a pull request opens**: GitHub `pull_request.opened` and
  `pull_request.ready_for_review`, condition `data.pull_request.draft` equals
  false. Message: "A pull request was opened or marked ready for review.
  Handle it."
- **When mentioned on a PR**: two GitHub triggers, `issue_comment.created` with
  `data.issue.pull_request` equals true, and
  `pull_request_review_comment.created`; both with `data.comment.mentions_app`
  equals true and `data.comment.author_association` in OWNER, MEMBER,
  COLLABORATOR. Message: "Someone on the team mentioned you in a comment on
  this pull request. Read their comment, do what they ask, and answer them on
  it."
- **Every weekday morning**: a schedule at 09:00, Monday to Friday, in the
  person's time zone. Message: "Do your scheduled work."

In Slack, people already reach a shared agent by mentioning it; that needs no
trigger.
