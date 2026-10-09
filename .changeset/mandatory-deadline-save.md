---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

The save before a sandbox's provider deadline is now mandatory. Before, the deadline backstop waited until every background command had received and outlived its stop request, every owner turn had written its quiescence receipt and no sibling session had a recent attempt, and the zero-holder drain waited for every open request. When any of those could not finish, the box died at the provider deadline without being saved. Inside a fixed window before the deadline (the command stop grace, the drain capture budget and two reaper periods, at most the rotation lead) the reaper now saves and stops the box anyway. Only a live turn, viewer, direct request or interaction on the box, or a supervised command, still blocks it. Requests still open on the box are recorded by rolling migration 0676, left out of the saved checkpoint and settled only after the box is stopped. A file being written at that moment can be saved half-written. Enrollment through this path is counted as `opengeni_sandbox_command_containment_total{outcome="forced_deadline_enrolled"}`.
