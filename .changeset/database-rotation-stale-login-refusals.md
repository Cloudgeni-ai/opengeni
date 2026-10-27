---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Rotating the runtime database password no longer fails operations when many connections log in at the moment a pool switches passwords. Each refused login (SQLSTATE `28P01`) is now attributed to the password that login actually used, captured when it asked for its password, instead of to the password the operation saw when it started. A refusal of a password the pool has already replaced (a stale refusal) never moves the pool and never counts against an operation's attempts; otherwise each distinct password gets one attempt, under a hard cap of five. The five-second straggler grace is removed, so a pool switches back at once when the password it switched to is refused (for example during a rollback). A single configured password still fails fast. `RotatingDatabasePassword.password(login)` records the position per login, `reportAuthenticationFailure` now returns whether the refusal was stale, the `candidate_refused` event gains a `stale` flag, and `DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS` and the `staleFailureGraceMs`/`now` options are removed.
