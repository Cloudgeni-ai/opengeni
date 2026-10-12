---
"@opengeni/worker-bundle": patch
---

Finished Connected Machine commands no longer retry their output release forever once the runner that ran them is gone. Output release now settles when nothing answers on the command's runner address and the machine's enrollment retires that runner, using the same rules as running-command reconciliation: the enrollment was revoked, a different runner process now holds the connection, or the runner went offline by stopping, updating or shutting down. Output it had already handed over is marked released, and output it never handed over is recorded as missing. A machine that is merely offline keeps the existing retry, so its output is still collected when it comes back.
