---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Resuming a browser whose earlier resume timed out no longer gets stuck. Before, the resume first tried to end that interrupted attempt, and when the machine still held the attempt's working copy it refused in order to protect it, so the browser could neither be continued nor resumed.

Now, when the attempt's browser launch completed (still running, or launched and then the machine restarted), the resume asks the machine to re-adopt that exact attempt from its own profile directory, on the same machine instance and under the same controller generation, and marks the browser active again under the same record and history. Nothing is restored over the working copy and nothing is discarded.

When the launch never recorded completion (for example the machine went down mid-launch), the attempt can't be adopted. If a complete process scan proves no browser is running its profile (Linux), the machine moves the attempt's whole session directory aside intact, under `set-aside/<browser>/<generation>` in its browser state directory, and the browser resumes from its saved checkpoint under the same record. A launch that completed, or whose profile may still be in use (including any platform without that proof), keeps refusing and stays preserved. Machines on agents without this option keep their original refusal.

Set-aside directories are kept until an operator removes them; nothing deletes or restores them automatically, because they can hold a private signed-in profile.
