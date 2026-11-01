---
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

A schedule runs as its owner, so its owner's own (personal) Connected Machine can now run it whoever can see it: Workspace schedules included, not only Only me ones. Picking the machine on the schedule is the consent; following a workspace default that is a personal machine is still refused. Each run's chat gets the schedule's audience and a grant for that chat alone, and other people's messages in a shared run chat wait for the owner, as in any chat on a personal machine. Nobody else's schedule can use the machine.

Create and update no longer refuse a Workspace schedule on the owner's machine, and widening such a schedule to Workspace is allowed. The schedule form offers your own machines whatever the schedule's audience. When a machine becomes someone's Only me machine, that person's schedules on it keep running unchanged; before, their Workspace schedules there became Only me or paused. Everyone else's still pause. The audience preview no longer produces the `make_only_me` action, and `summary.schedulesMadeOnlyMe` is always 0.
