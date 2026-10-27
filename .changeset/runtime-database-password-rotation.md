---
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

The runtime database password can now be rotated without restarting pods or failing requests and turns. New optional settings `OPENGENI_DATABASE_PASSWORD_FILE` and `OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE` name files with the runtime login's current and previous password. Every pool that logs in as the runtime role (the API and worker pools, the session-list LISTEN connection, the managed-auth pool and the runtime CLIs) re-reads them on each new connection, starts on the previous password and switches to the current one after a single refused login (SQLSTATE `28P01`). A pool query or transaction start refused with `28P01` is retried on the newly selected password, only while another distinct password exists and at most once per password. With a single password a refused login still fails fast, and unset or missing files keep today's behavior: the password in `OPENGENI_DATABASE_URL`. `createDb` accepts the same files as `passwordFiles` (with `databasePasswordFileOptions(settings)`) and reports content-free `onCredentialEvent` events; embedders that do not pass them are unaffected. The Helm chart's new `runtimeDatabasePasswordFiles.enabled` mounts the optional runtime Secret keys `OPENGENI_DATABASE_PASSWORD` and `OPENGENI_DATABASE_PREVIOUS_PASSWORD` as files into the api, worker-control and worker-turns pods. See docs/deployment.md, "Rotating the runtime database password".
