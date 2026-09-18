---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Remove Packs and their Workflow templates from the application, public clients,
runtime, and active database schema. Plugins, Skills, Connections, sandbox
environments, Knowledge, scheduled tasks, and event automations remain independent.

PR Review now has its own setup authority and fixed automation template. Generic
automation routes cannot mutate review-owned sources or triggers. The API contract
revision changes; deploy matching server and client versions together.

Migration 0482 is a destructive maintenance cutover: drain all API and worker
database clients, settle capability operations and queued Pack automation work,
then apply migrations and provision roles before starting only matching binaries.
It removes Pack data without a compatibility layer or data-preservation migration.
Customized, shared, and re-scoped Skills, Connections, and session history are
preserved; source-only Skills lose their active distribution owner.