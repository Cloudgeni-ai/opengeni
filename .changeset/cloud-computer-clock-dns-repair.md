---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Before each turn on a chat's own cloud computer (a compute box), Opengeni checks the box's clock against the worker's and checks that the box can look up Opengeni's host. A clock more than five minutes off is set to the worker's time. A resolver that cannot look up Opengeni is restored to the name servers the platform gave the box, keeping the replaced file at `/etc/resolv.conf.opengeni-replaced`; a working resolver, a lookup that cannot be judged, or a file that lists only the platform's servers is never changed. A failed check never fails the turn. When setup runs before the first model request, the model gets a short note about what was repaired or is still broken. Connected Machines, Modal and every other backend are never touched.
