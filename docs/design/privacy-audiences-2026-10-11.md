# One audience model for chats, schedules and machines

Status: approved for build, 2026-10-11.

## Problem

Chats already have an owner and an audience: "Only me" (`user_private`) or the
whole workspace (`workspace_shared`). Private chats are hidden from everyone
else, admins included, by the database read policy. Machines have an owner
scope (`user`, `workspace`, `organization`), and a personal machine is only
attached by its owner.

Schedules have an owner but no audience. Every member of a shared workspace
can read every schedule, including the prompt of a schedule that posts into
someone's Only me chat, and the chats a schedule creates are shared unless the
schedule writes to personal knowledge. A schedule also cannot use its owner's
personal machine, so private recurring work has to run somewhere shared.

## Model

One vocabulary everywhere, matching the chat picker: **Only me** or
**Workspace** (everyone in the workspace).

| Item | Only me | Everyone in the workspace |
| --- | --- | --- |
| Chat | Owner only. Admins cannot see it. (Unchanged.) | All members. |
| Schedule | Owner sees and manages everything. Admins see that it exists: owner, how often it runs, status, last run and cost. They can pause it. They never see its name, prompt, settings or runs. Other members do not see it. | All members see it; only the owner changes or runs it. (Unchanged.) |
| Chats a schedule creates | Only me chats owned by the schedule's owner. | Shared chats. |
| Machine | A personal machine (owner scope `user`). | A workspace or organization machine. |

Rules:

1. A schedule's audience is stored on the schedule (`visibility`), next to the
   owner it already has.
2. A schedule that posts into an Only me chat is always Only me. Widening it is
   refused while the target chat is private.
3. An Only me schedule runs as its owner. Each run rechecks that the owner is
   still an active member who can create Only me chats, exactly like the
   existing personal-knowledge schedule path, and the run's chat is created
   Only me for that owner.
4. An Only me schedule may use its owner's personal machine. Each run
   rechecks that the machine still belongs to the owner and is attachable.
   Shared schedules still cannot use personal machines, because other members
   would then be driving someone's own computer.
5. Schedule visibility is enforced in the one core gate that the HTTP API, the
   agent tools and the Slack integration all use, not in each route.

## Insights

Runs of an Only me schedule are Only me chats, so their usage already lands in
the existing per-person private totals, with no names. The per-schedule list in
Insights leaves out other people's Only me schedules.

## Settings

Organization owners and admins choose, under Security:

- **Only me chats and schedules**: allowed or not (exists today for chats; it
  now also covers schedules).
- **Default for new chats and schedules**: Everyone in the workspace, or Only me.
- **Admins can see private schedules**: on (owner, how often, cost, and pause)
  or off (fully hidden, like private chats).

A product that embeds Opengeni can only narrow these: deployment settings can
turn Only me off, force the shared default, or force admins to see private
schedules, and the organization cannot widen past them. The settings page
shows a locked row with a plain explanation when a choice is fixed.

## Not changing

- Private chats stay invisible to admins. There is no admin override.
- Existing schedules keep their current audience. Schedules that already post
  into an Only me chat, or write to personal knowledge, become Only me, which
  only narrows who can see them.

## Delivery

1. Schedule audience: storage, the core gate, private run chats, the admin
   summary and pause, the schedule form and list.
2. Settings: default audience, admin visibility, deployment limits, Security
   page.
3. Personal machines for Only me schedules.
4. Insights: leave other people's private schedules out of the per-schedule
   list.
