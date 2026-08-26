---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add explicit managed onboarding: ordinary verified signup completes an organization-name-only setup that creates only the owner membership and canonical Personal workspace, while unregistered invitees can use a digest-only one-time account setup link before signing in normally.

Migration 0348 is a one-way maintenance cutover. Stop and drain every API,
control worker, and turn worker before applying it, pass the exact old/new
application database roles to the migration runner, and start only binaries
built for schema ordinal 0348 or newer. Never restart a pre-0348 image after
the migration commits; remain in maintenance and fix forward if the new runtime
cannot start.
