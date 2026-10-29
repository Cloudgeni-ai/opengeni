---
"@opengeni/runtime": patch
---

Honor the sandbox's configured temporary directory for shell supervision markers. Local deployments with a full or quota-limited `/tmp` can now install the managed Codemode client and run tools using their configured disk, while cancellation keeps the same exact marker path.
