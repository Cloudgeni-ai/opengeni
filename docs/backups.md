# Database backups

Opengeni's optional backup runner is independent of the API, worker and Temporal.
It streams PostgreSQL dumps into a [restic](https://restic.net) repository, which
deduplicates, compresses and encrypts them. Scheduling belongs to the deployment:
use the Helm CronJobs, systemd or cron. Managed PostgreSQL point-in-time recovery
remains a good primary recovery mechanism; this is a portable logical-dump option,
not a replacement for provider-native backups or a cluster replication controller.

## How it works

Each run dumps every configured database with `pg_dump --format=custom
--compress=0` (plus the cluster roles when `rolesService` is set) and streams each
dump straight into `restic backup --stdin`. Nothing is staged on local disk. While
a dump streams, `pg_restore` parses the same bytes, so a run only counts when every
archive is readable.

The dumps are deliberately uncompressed. restic splits each stream into
content-defined chunks and stores every chunk once, so the parts of a database that
did not change since the last run are not stored or uploaded again. restic then
compresses and encrypts what is new. How much a night adds depends on how much the
database changed and how much its row order moved, not on its total size.

Every file of a run is a restic snapshot tagged `opengeni-backup` and
`run=<run id>`. Once all of a run's files are stored, they are tagged `complete`
together. Only complete runs are recovery points; a failed run removes what it
stored.

## Quick start

Install Bun (the repository's `.bun-version`), PostgreSQL clients compatible with
your server, restic 0.17 or newer, and `flock`. The independent container image
includes them; build `docker/backup.Dockerfile` or pin a digest from the **Backup
image** workflow's `backup-image-receipt`. Published images currently target Linux
amd64 and PostgreSQL 18 clients, which also dump and restore PostgreSQL 17 and
older servers; a newer server major requires a compatible build using
`--build-arg POSTGRES_MAJOR=<major>`. Do not guess a tag from the application chart
version: the operator image publishes independently.

Use one private, persistent state directory per installation. Every invocation must
share that directory, which holds the OS lock and restic's cache (the Helm jobs
share one PVC). restic's own repository lock also guards against two writers.

Create a private `pg_service.conf` using PostgreSQL's standard libpq service format:

```ini
[application]
host=postgres.example.internal
dbname=opengeni
user=backup_operator
password=<secret>
sslmode=verify-full

[workflow]
host=postgres.example.internal
dbname=temporal
user=backup_operator
password=<secret>
sslmode=verify-full

[workflow_visibility]
host=postgres.example.internal
dbname=temporal_visibility
user=backup_operator
password=<secret>
sslmode=verify-full
```

Use a dedicated backup/admin credential that can read all required rows, including
RLS-protected data. The restricted application runtime login is not sufficient.
Do not give these credentials to the API or ordinary workers. For self-managed
PostgreSQL, optionally configure `rolesService` with privilege to dump cluster
roles; it may not be permitted by managed providers. Preserve role/bootstrap
configuration independently when omitting it.

Choose a repository on any restic backend: S3 or an S3-compatible store
(`s3:https://host/bucket/prefix`), Azure Blob (`azure:container:/prefix`), Google
Cloud Storage (`gs:bucket:/prefix`), a restic REST server, a local path, or any
rclone remote (`rclone:remote:prefix`). Use a dedicated bucket or prefix and
credentials scoped to it. Put the storage credentials in a private environment file
of literal `KEY=VALUE` lines; the runner passes them only to restic:

```sh
AWS_ACCESS_KEY_ID=<key id>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_DEFAULT_REGION=<region>
```

Use the variables restic documents for your backend, for example
`AZURE_ACCOUNT_NAME`/`AZURE_ACCOUNT_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, or
`RCLONE_CONFIG` pointing at a private rclone configuration file. `RESTIC_*`
variables and `PATH` are rejected there: the repository belongs in the config and
the password in its own file.

Generate a long random repository password and store it in a private file. Save an
independent recovery copy in your secret manager, not only next to the database:
without it the repository cannot be read. The scheduled runner needs the password
to deduplicate and verify; this is encryption at rest, not protection against a
compromised runner.

Example `config.json` (secret-free):

```json
{
  "repository": "s3:https://storage.example.internal/database-backups/opengeni",
  "passwordFile": "/etc/opengeni-backup/restic-password",
  "environmentFile": "/etc/opengeni-backup/restic.env",
  "stateDirectory": "/var/lib/opengeni-backup",
  "timeZone": "UTC",
  "retention": { "daily": 7, "weekly": 4 },
  "databases": [
    { "name": "opengeni", "service": "application" },
    { "name": "temporal", "service": "workflow" },
    { "name": "temporal_visibility", "service": "workflow_visibility" }
  ],
  "rolesService": "application"
}
```

`environmentFile` is optional. `host` (default `opengeni`) names this installation's
snapshots; give each installation its own value if several share one repository.

Set `PGSERVICEFILE` to the private service file. Create the repository once, then
schedule `run`:

```sh
bun run deployment:backup init --config /etc/opengeni-backup/config.json
bun run deployment:backup run --config /etc/opengeni-backup/config.json
bun run deployment:backup list --config /etc/opengeni-backup/config.json
bun run deployment:backup check --config /etc/opengeni-backup/config.json
bun run deployment:backup verify --config /etc/opengeni-backup/config.json
```

`run` never creates a repository; a missing repository or a wrong password fails
with a clear message. It prints one JSON line per run with each file's size and
how many new bytes it added. `check` fails when the newest complete run is older
than 36 hours, or when `restic check` finds the repository structure damaged.
`verify` also reads every file of the newest run back in full and parses each
archive with `pg_restore`; restic authenticates every chunk it reads. Monitor
command/Job failures; the runner does not add a notification receiver or public API
endpoint. `list` works even when a backup is stale. None of these commands require
the application to be up.

Tool error output can contain connection details, so the runner reports only the
failing tool and its exit status. Set `OPENGENI_BACKUP_DIAGNOSTICS=1` to see the
tools' own error output while investigating.

## Retention and safety

After each successful run, the runner keeps the newest complete run of each of the
last `retention.daily` days (default 7) and of each of the last `retention.weekly`
weeks (default 4, weeks starting Monday), in the configured time zone. It forgets
every other run, including incomplete ones, and prunes data no kept run uses,
tolerating up to 20% unused space to avoid rewriting live data on every run.
Retention is decided per run, so a kept recovery point always has every file.

Because unchanged chunks are shared, keeping more points costs only the data that
differs between them. Remote space is the first full run plus what each later run
added while it is still retained. The local state directory holds restic's cache
(repository metadata), not dumps.

`verify` proves the stored archives are complete and readable. It is not a
database/application recovery drill; rehearse restores separately.

## Helm

Provision a private PVC for the lock and restic cache, and a Secret with the keys
`config.json`, `pg_service.conf`, `restic-password` and, when used, `restic.env`.
Use the paths from the example above and keep the config timezone equal to the
chart timezone. The Secret mounts under `/etc/opengeni-backup`; state mounts under
`/var/lib/opengeni-backup`. The PVC needs working local POSIX file locks. Run
`init` once before the first scheduled run, for example in a one-off pod using the
same image, Secret and PVC, or from a workstation with the same configuration.

```yaml
backup:
  enabled: true
  existingSecret: opengeni-backup
  existingClaim: opengeni-backup-state
  image:
    digest: sha256:<published-backup-image-digest>
  schedule: "15 3 * * *"
  checkSchedule: "0 12 * * *"
  timeZone: UTC
```

The jobs do not mount application runtime secrets or a Kubernetes service-account
token. No resource caps or additional services are introduced. Concurrency is
blocked per CronJob and across both commands by the shared file lock. Kubernetes
CronJob timezone support is required. For an immediate run, create a Job from
the `<release>-backup-run` CronJob.

## Restore into isolation

Restore never requires the source database to be alive. Provision roles and
install extension binaries required by the source schema on an isolated recovery
PostgreSQL cluster, using the stored `roles.sql` (`restic dump <snapshot>
/roles.sql`) or your provider's normal bootstrap procedure. Review role SQL before
applying it; it can contain privileged roles. Create an empty target database and
add a distinct service, e.g. `recovery`, to the private libpq service file. Never
point it at a running application database.

```sh
bun run deployment:backup restore --config /etc/opengeni-backup/config.json \
  --run latest --database opengeni --target-service recovery --confirm-restore
```

`--run` takes `latest` (the default) or a run id from `list`. Restore rejects
configured source-service names and nonempty targets, streams the archive out of
restic (which authenticates every chunk) and restores it in a single transaction
with `--exit-on-error`. Object ownership, grants, RLS policies and security-definer
function owners are preserved; the recovery login needs permission to restore
objects to the original roles. Missing roles fail the transaction rather than
silently transferring ownership to that login. Let the archive create extensions in
the empty target database. Service aliases are configuration, not proof of
isolation: ensure the target host/database really is separate and has no writers.
Repeat for the other databases into their isolated targets, validate
rows/grants/application behavior, then perform an explicit operational cutover. A
failed restore rolls back its transaction; it does not automatically switch traffic
or start workers.

Extension ownership needs separate attention: PostgreSQL creates extensions and
their member objects under the restore login, rather than restoring their
original owners from the archive. Use the intended original extension-owner role
as the recovery login where supported, and inspect extension-owned
security-definer functions after recovery. Do not assume that reassigning a
bootstrap superuser's objects will work: that role also owns required system
objects. An isolated successful restore proves archive recoverability, not exact
application/security parity without these operator checks.

## Upgrading from the Age format

Earlier versions wrote Age-encrypted dumps through an rclone remote, indexed by
`CURRENT.json`. This version does not read that format. To switch:

1. Keep the Age identity and the old objects for as long as you need their
   recovery points.
2. Create the restic repository under a new prefix, not inside the old one, and
   update the config and secret keys as described above.
3. Run `init`, then `run` and `verify`, before relying on the new points.

An old point can still be restored by hand: stream
`runs/<run id>/<database>.dump.age` from the old prefix (for example with
`rclone cat`), decrypt it with `age --decrypt --identity <identity file>`, and
restore the result with `pg_restore` into an isolated empty database as above.
Delete the old objects once you no longer need them.

## Coverage limits

These are **database-only** backups. Object files, host enrollment identities,
deployment secrets, and sandbox files need their own recovery plan. Old database
references cannot recover an object deleted since the snapshot without storage
versioning or a separate object backup. NATS is reconstructible transport, not
durable conversation truth. Independently captured live PostgreSQL databases
are not a cross-database atomic snapshot. For a coordinated full-system recovery
point, explicitly quiesce writers and use the deployment's recovery procedure.
