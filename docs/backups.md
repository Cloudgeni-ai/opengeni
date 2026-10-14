# Database backups

Opengeni's optional backup runner is independent of the API, worker and Temporal.
It uses PostgreSQL's tools, Age encryption and a named rclone remote. Scheduling
belongs to the deployment: use the Helm CronJobs, systemd or cron. Managed
PostgreSQL point-in-time recovery remains a good primary recovery mechanism;
this is a portable logical-dump option, not a replacement for provider-native
backups or a cluster replication controller.

## Quick start

Install Bun (the repository's `.bun-version`), PostgreSQL clients compatible with
your server, `age`, `rclone` and `flock`. The independent container image includes
them; build `docker/backup.Dockerfile` or pin a digest from the **Backup image**
workflow's `backup-image-receipt`. Published images currently target Linux amd64
and PostgreSQL 17; other PostgreSQL majors require a compatible build using
`--build-arg POSTGRES_MAJOR=<major>`. Do not guess a tag from the application chart
version: the operator image publishes independently.

Use one private, persistent state directory and **one writer per destination**.
Every invocation must share that directory/OS lock (the Helm jobs share one PVC).
Do not run two installations against one bucket/prefix with separate state volumes.
The runner fails closed on stale or ambiguous index publication; it does not
pretend eventual-consistency storage provides a distributed lock.

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

Configure a named `backup` remote using rclone's native S3-compatible, S3, Azure
Blob, GCS or filesystem provider configuration. Use a dedicated bucket/prefix and
credentials scoped to it. Keep credentials in the secret-managed rclone file or
provider-native environment, never in the backup configuration or command line.
Provider support is inherited from rclone; test your configured provider before
relying on it. Provider multipart/readback retries remain provider configuration.

Generate an Age identity with `age-keygen`. Save an independent recovery copy in
your secret manager, not only on the database host. Keep old identities available
for retained backups after any rotation. The scheduled runner needs the identity
to validate decryption; this is encryption at rest, not protection against a
compromised runner holding that identity.

Example `config.json` (secret-free):

```json
{
  "remote": "backup:database-backups",
  "stateDirectory": "/var/lib/opengeni-backup",
  "ageRecipient": "<age public recipient>",
  "ageIdentityFile": "/etc/opengeni-backup/age.key",
  "timeZone": "UTC",
  "databases": [
    { "name": "opengeni", "service": "application" },
    { "name": "temporal", "service": "workflow" },
    { "name": "temporal_visibility", "service": "workflow_visibility" }
  ],
  "rolesService": "application"
}
```

Set `PGSERVICEFILE` and `RCLONE_CONFIG` to their private files, then:

```sh
bun run deployment:backup run --config /etc/opengeni-backup/config.json
bun run deployment:backup list --config /etc/opengeni-backup/config.json
bun run deployment:backup check --config /etc/opengeni-backup/config.json
bun run deployment:backup verify --config /etc/opengeni-backup/config.json
```

`check` returns failure when the nightly point is older than 36 hours, the weekly
point is older than eight days, or an object is missing/truncated. `verify` also
reads, hashes, decrypts and parses each full archive. Monitor command/Job failures;
the runner does not silently add a notification receiver or public API endpoint.
`list` works even when a backup is stale. None of these commands require the
application to be up.

## Retention and safety

Retention is deliberately small: **latest successful nightly + one Sunday weekly
checkpoint** in the configured timezone. The first success seeds both references.
The first success in a new week promotes the weekly point, including after a
missed Sunday. That point is zero to seven days old, not an exactly-seven-day
rolling history; the two slots sometimes share one snapshot.

Each database is dumped in compressed custom format and streamed through Age
before anything touches disk. Only one ciphertext at a time is staged locally.
Allow disk space for the largest compressed database (and ordinary operating
headroom), and remote space for both retained points plus their replacement.
The upload is read back once: SHA-256/size over ciphertext, full Age decryption,
then full `pg_restore` SQL rendering to `/dev/null`. This is archive validation,
not a successful database/application recovery drill.

Each run has a unique immutable prefix. `CURRENT.json` references complete
manifests for both retained points. Only verified replacements are published;
only specifically displaced files are removed. Local `pending.json`,
`checkpoint.json` and `cleanup.json` preserve publication/GC intent across
interruption. An ambiguous index write keeps both old/new objects and fails
closed until readback identifies the published index. Do not delete these
journals to silence a conflict. An ungraceful kill before publication can leave
unreferenced ciphertext; inspect it against both complete references before
manual removal. The runner never purges a bucket or guesses at unknown objects.

## Helm

Provision a private PVC large enough for encrypted scratch and a Secret with four
keys: `config.json`, `pg_service.conf`, `rclone.conf`, `age.key`. Use the paths from
the example above and keep the config timezone equal to the chart timezone.
The Secret mounts under `/etc/opengeni-backup`; state mounts under
`/var/lib/opengeni-backup`. The PVC needs working local POSIX file locks.

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
install extension binaries required by the source schema on an isolated recovery PostgreSQL
cluster, using the encrypted `roles.sql.age` or your provider's normal bootstrap
procedure. Review role SQL before applying it; it can contain privileged roles.
Create an empty target database and add a distinct service, e.g. `recovery`, to
the private libpq service file. Never point it at a running application database.

```sh
bun run deployment:backup restore --config /etc/opengeni-backup/config.json \
  --slot weekly --database opengeni --target-service recovery --confirm-restore
```

Restore downloads ciphertext, verifies size/hash/decryption/full archive parsing,
rejects configured source-service names and nonempty targets, then restores in a
single transaction with `--exit-on-error`. Object ownership, grants, RLS policies
and security-definer function owners are preserved; the recovery login needs
permission to restore objects to the original roles. Missing roles fail the
transaction rather than silently transferring ownership to that login. Let the
archive create extensions in the empty target database. Service aliases are
configuration, not proof of isolation: ensure
the target host/database really is separate and has no writers. Repeat for the
other databases into their isolated targets, validate rows/grants/application
behavior, then perform an explicit operational cutover. A failed restore rolls
back its transaction; it does not automatically switch traffic or start workers.

Extension ownership needs separate attention: PostgreSQL creates extensions and
their member objects under the restore login, rather than restoring their
original owners from the archive. Use the intended original extension-owner role
as the recovery login where supported, and inspect extension-owned
security-definer functions after recovery. Do not assume that reassigning a
bootstrap superuser's objects will work: that role also owns required system
objects. An isolated successful restore proves archive recoverability, not exact
application/security parity without these operator checks.

## Coverage limits

These are **database-only** backups. Object files, host enrollment identities,
deployment secrets, and sandbox files need their own recovery plan. Old database
references cannot recover an object deleted since the snapshot without storage
versioning or a separate object backup. NATS is reconstructible transport, not
durable conversation truth. Independently captured live PostgreSQL databases
are not a cross-database atomic snapshot. For a coordinated full-system recovery
point, explicitly quiesce writers and use the deployment's recovery procedure.
