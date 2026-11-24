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
  merging (below). Leave out connections it simply uses.
- **Skills** it relies on, by name, from the workspace's Skills.
- **When it starts**: the common triggers below that fit its job.

Check that the apps it needs are connected (`capability_catalog_search`,
`event_sources_list`). If one is missing, say what it blocks and offer its
setup.

## 2. Confirm

Show the draft in one short message. Then make one `request_human_input` call
with one question: a `multi_select` "Create it? When should it start?" with
`required: false`, listing the common triggers it can use (mark the ones its
job implies as recommended). Submitting creates the agent; anything typed in
Other is a change to make first. Change the draft and ask again until the
person submits without changes. If they skip or dismiss it, save nothing.

## 3. Save

Save with `bot_template_save`: `name`, `description`, `avatar`,
`instructions`, `toolPermissions` and `skills`. For asking before merging,
give both GitHub merge tools:

```json
[
  { "connector": "github.com", "tool": "merge_pull_request", "permission": "ask" },
  { "connector": "github.com", "tool": "pull_request_merge", "permission": "ask" }
]
```

Leaving `toolPermissions` out gives exactly these rules.

Then add each picked trigger with one `scheduled_tasks_create` call:

- `name`: "<agent name>: <trigger name>", exactly, so its page shows the
  trigger as on.
- `runMode`: `"new_session_per_run"`.
- `agentConfig`: `{ "agentId": "<the saved agent's id>", "prompt": "<the
  trigger's message>" }`. Leave `agentConfig.tools` out.
- `visibility`: `"private"` for an Only me agent, otherwise `"workspace"`.
- `schedule` and `events` as below. An event trigger's `schedule` is
  `{ "type": "manual" }`.

A GitHub trigger listens on the workspace's GitHub source: its `sourceId`
from `event_sources_list` (a `readyToAdd` one works too). If there is none,
tell the person to turn the trigger on from the agent's page in Agents, which
adds the source.

Finish with what was created: the agent, its triggers, how to ask it in Slack
(the result's `slack` field), and that its page in Agents changes any of it.

## Common triggers

The agent's page offers the same list as on/off switches.

**When a pull request opens**. Message: "A pull request was opened or marked
ready for review. Handle it."

```json
{ "triggers": [{
  "sourceId": "<GitHub source id>",
  "eventTypes": ["pull_request.opened", "pull_request.ready_for_review"],
  "conditions": [{ "field": "data.pull_request.draft", "op": "equals", "value": false }]
}] }
```

**When mentioned on a PR**: a team member's comment that mentions Opengeni's
GitHub App and says the agent's name. One automation with two triggers.
Message: "Someone on the team mentioned you in a comment on this pull request.
Read their comment, do what they ask, and answer them on it."

```json
{ "triggers": [
  { "sourceId": "<GitHub source id>",
    "eventTypes": ["issue_comment.created"],
    "conditions": [
      { "field": "data.issue.pull_request", "op": "equals", "value": true },
      { "field": "data.comment.mentions_app", "op": "equals", "value": true },
      { "field": "data.comment.author_association", "op": "in", "value": ["OWNER", "MEMBER", "COLLABORATOR"] },
      { "field": "data.comment.body", "op": "contains", "value": "<agent name>" }
    ] },
  { "sourceId": "<GitHub source id>",
    "eventTypes": ["pull_request_review_comment.created"],
    "conditions": [
      { "field": "data.comment.mentions_app", "op": "equals", "value": true },
      { "field": "data.comment.author_association", "op": "in", "value": ["OWNER", "MEMBER", "COLLABORATOR"] },
      { "field": "data.comment.body", "op": "contains", "value": "<agent name>" }
    ] }
] }
```

**Every weekday morning**: no `events`. Message: "Do your scheduled work."

```json
{ "type": "calendar", "hour": 9, "minute": 0,
  "daysOfWeek": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  "timeZone": "<the person's time zone>" }
```

In Slack, people already reach a shared agent by mentioning it; that needs no
trigger.
