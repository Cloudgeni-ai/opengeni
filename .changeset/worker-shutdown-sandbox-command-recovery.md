---
"@opengeni/worker-bundle": patch
---

A turn that a worker restart interrupts while it is running sandbox commands, for example downloading attached files at startup, now resumes on another worker. Before, it failed with the bare message "WORKER_SHUTDOWN", because the cancellation arrived wrapped in the sandbox command's own error and didn't take the shutdown recovery path.
