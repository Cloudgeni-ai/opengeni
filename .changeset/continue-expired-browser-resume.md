---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Resuming a browser whose earlier resume timed out now continues the same browser from the working copy its machine still holds, instead of refusing. Before, the resume first tried to end that interrupted attempt; when the machine had already launched it (or launched it and then restarted), it refused in order to protect that working copy, and the browser could neither be continued nor resumed. The resume now asks the machine to re-adopt that exact attempt from its own profile directory, on the same machine instance and under the same controller generation, and marks the browser active again under the same record and history. Nothing is restored over the working copy and nothing is discarded. When the machine has no adoptable working copy (the attempt never finished launching, its desktop is gone, or the machine instance changed), the resume falls back to the existing path: end the attempt and restore from the saved checkpoint.
