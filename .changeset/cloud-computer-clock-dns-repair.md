---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Before each turn on a chat's own cloud computer (a compute box), Opengeni checks the box's clock against the worker's and checks that the box can look up Opengeni's host. A clock more than five minutes off is set to the worker's time, and a resolver that cannot look up Opengeni is restored to the name servers the platform gave the box, keeping the replaced file at `/etc/resolv.conf.opengeni-replaced`. A working resolver is never changed, a failed check never fails the turn, and the model gets a short note when something was repaired. Connected Machines, Modal and every other backend are never touched.
