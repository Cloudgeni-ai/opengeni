# Session status, Linked items and report-back

Owner doc for a chat's status line (Working, Waiting on a person, Done,
Failed), its Linked items and their live status, and waking a chat when a
linked pull request merges. The code is the authority:
`packages/contracts/src/session-links.ts`,
`packages/core/src/domain/session-links.ts`,
`apps/api/src/mcp/session-coordination-tools.ts`,
`apps/api/src/integrations/session-link-status.ts`,
`apps/api/src/routes/session-links.ts` and
`packages/react/src/app/components/session/linked-panel.tsx`.

Everything here is general: it works for any agent and any kind of work. There
are no fixed stages and no knowledge of deploy pipelines.

The agent tools `set_waiting_on`, `session_links_add` and
`session_links_remove` belong to the agent's Goals capability and need
`sessions:control`; agents without Goals still show waits from questions and
approvals, and pull requests they open are still linked.

## Status

The chat header and the session list show one status:

| Status | When |
| --- | --- |
| Working | A turn is running. |
| Waiting on <person> | The chat waits on someone (below). "Waiting on you" when it is the viewer. |
| Done | Idle with nothing pending. |
| Failed | The last turn failed. |

Queued, recovering, paused, limit and archived states keep their existing labels.

`Session.waitingOn` (`{ source, person, subjectId, reason, since }`, null when
nobody is waited on) is derived on read:

- `source: "input"`: the chat has an open approval or question
  (`requires_action`). The person is the one the turn works for
  (`initiatingHumanSubjectId`). It clears when they answer, approve or the
  turn moves on, exactly as `requires_action` does
  (see [human-input.md](human-input.md)).
- `source: "agent"`: the agent called `set_waiting_on` with a person (a
  workspace member, matched by name or email, or any free-text name) and a
  short reason. It shows only while the chat is idle after the turn that set
  it; the next turn (a reply, an automation, a wake) clears it on its own, and
  the agent can clear it early with `set_waiting_on` and no person.

Changes publish `session.waiting_on.changed`, so open chats refresh at once.

## Linked items

The Linked tab in the chat's side panel lists what the chat works on: issues,
pull requests, Slack threads, App records and any URL (at most 30).

- The agent adds items with `session_links_add` (`url`, optional `title`) and
  removes them with `session_links_remove`. People with `sessions:control`
  can remove items from the panel, and the HTTP API
  (`GET/POST /v1/workspaces/:ws/sessions/:id/links`,
  `DELETE .../links/:linkId`) does both.
- A pull request the chat opens through the GitHub tools is added by itself.
- Adding a URL that is already linked updates its title instead of adding it
  twice. Changes publish `session.links.changed`.

Each item shows its live status where the deployment can read it, re-read when
the list changes and every minute while the chat is open (cached for 30
seconds on the server; an explicit refresh re-reads an item at most every 5
seconds):

| Item | Live status |
| --- | --- |
| GitHub pull request | Open, draft, merged or closed; checks (passing, failing, running); review (approved, changes requested, review requested). |
| GitHub issue | Open or done. |
| Anything else | Title only. |

GitHub status is read through the workspace's GitHub App installation for the
repository's owner (not the viewer's own GitHub account), and only for
repositories the workspace chose for that installation; that choice is checked
on every read. An item the deployment cannot read shows its title only;
reading never fails the list.

## Report back when a pull request merges

`session_links_add` accepts `wakeWhen: "merged"` (the linked pull request is
merged) or `wakeWhen: "release_published"` (its repository publishes a
release). It creates a one-time event automation on this chat through the same
path as `scheduled_tasks_create` (see
[design/automations-and-events.md](design/automations-and-events.md)), with
conditions on the repository (GitHub's own spelling of `owner/name`), the pull
request number and `merged = true`. Merges made through Opengeni's own GitHub
App count too. Asking again for the same wake reuses the pending automation,
and a pull request that is already merged or closed gets no wake
(`wakeNotSet` says to report back now).

When the event arrives the chat wakes with a short prompt asking it to report
back where the work started and finish any planned follow-up. If the chat
started in a Slack thread, a one-time event automation's wake (such as these)
reopens the thread delivery from the wake, so the woken answer posts back in
that thread (only the woken run's messages, not what happened in the chat
meanwhile). If the thread is still delivering an earlier answer, it stays
open after that answer for the woken one, then settles as usual. Recurring event automations into the chat
leave the thread alone.

`wakeWhen` needs automations with event triggers in the chat (otherwise the
tool refuses it), a GitHub event source the chat's owner can use, and the
workspace's GitHub App able to read the repository. Otherwise, or for a link
that is not a GitHub pull request, the link is added and the result says why
no wake was set (`wakeNotSet`). A workspace has at most one GitHub event
source, so the wake always uses it.

## Workbench

The Changes tab draws one collapsible header per file (unified or split
diff); this applies to every embedder of the workbench. When the chat has an open linked pull request it shows **View on
GitHub**; when there are changes but no open pull request and the viewer can
message the chat it shows **Open PR**, which asks the agent to open one with
its own GitHub tools and permissions. Embedders control both with the
`pullRequest` and `onOpenPullRequest` props
([embedding-workbench.md](embedding-workbench.md)).

## Self-hosted limits

- Live GitHub status and merge wakes need the GitHub App
  ([github-app.md](github-app.md)) installed on the repository's owner, and
  merge wakes need its webhooks reaching the deployment. Without it, items show
  titles only, and `wakeWhen` adds the link without a wake (`wakeNotSet`).
- Linear issues, Slack threads and App records show their title only; their
  live status is not read yet.
- A pull request opened outside the GitHub tools (for example with `gh` in the
  sandbox) is not added automatically; the agent adds it with
  `session_links_add`.
