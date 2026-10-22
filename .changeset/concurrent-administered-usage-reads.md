---
"@opengeni/db": patch
---

Let organization administrators inspect usage on independent subscription connections concurrently. Keep the organization membership fence shared for these reads, while lifecycle writers and each connection's credential custody retain their exclusive locks. Demotion still waits for in-flight provider reads and prevents subsequent reads and quota recording.
