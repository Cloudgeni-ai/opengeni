---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Free compute is bounded for every kind of sandbox use, not only viewers. A held or denied Free or plan-less organization that has not bought credit or paid for a plan gets no sandbox at all: terminals, commands, background processes, browser and desktop sessions, viewers and new boxes for agent turns are refused, a turn that needs a box fails with a clear message instead of waiting forever, an already running box is no longer kept warm by anything but its in-flight turn, and the reaper drains it. A person who owns or administers such an organization carries the restriction into their other unpaid organizations.

Free, young Free and plan-less organizations share one running-box budget of 2 across every holder kind, plus 2 running boxes and 12 box-hours per UTC day per organization and per person across their organizations. Past the daily budget no box starts and the reaper drains boxes no turn holds, while an in-flight turn finishes. Boxes that nothing uses drain after the viewer idle window, whatever holds them. All values are plan-limit settings (`OPENGENI_SANDBOX_PLAN_LIMITS_JSON`).

Every new Modal box carries hard CPU and memory ceilings (2 cores / 4096 MiB for unpaid organizations, 8 cores / 16384 MiB otherwise), and a create without them is refused. Unpaid boxes can be limited to an outbound CIDR/domain allowlist; Modal has no per-port egress rule, so SMTP cannot be blocked by port alone.

A denied Free organization with no paid history is suspended from sandboxes, Site publishing, invitations, uploads and API keys until the decision is reversed or it buys credit; sign-in keeps working. Creating an additional organization now goes through the signup network checks and rate limit, and inherits its owner's review hold.

Paid, Enterprise and host-provisioned organizations are unaffected.
