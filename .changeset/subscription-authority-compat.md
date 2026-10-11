---
"@opengeni/db": patch
---

Prepare accepted subscription authority for each provider's own cutover. Every carrier of accepted authority (sessions, turns, scheduled tasks and their revisions, system updates and outbox rows) records when it was accepted, and a new owner-only compatibility relation can hold the accepted authority a provider's cutover carries over from its legacy columns, copied in the database from the exact source each path uses and checked at commit. Both personal-authority checks read these records after a provider's cutover. Nothing changes today: no provider has a cutover that uses them, so Codex and every other provider behave exactly as before.
