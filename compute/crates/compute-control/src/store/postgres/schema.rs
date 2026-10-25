//! The schema of the store in Postgres, and bringing a database up to it.

use deadpool_postgres::Object;

use super::{corrupt, database};
use crate::store::Result;

/// The schema, one migration for each version, applied in order by
/// [`migrate`]. A released migration is never changed: a change to the
/// schema is a new one at the end.
const MIGRATIONS: &[&str] = &[MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4];

/// Version 1: the tables, made if missing.
const MIGRATION_1: &str = "
create sequence if not exists compute_changes;
create sequence if not exists compute_host_epochs;
create table if not exists compute_hosts (
    id bigint primary key,
    name text not null unique,
    info jsonb not null,
    epoch bigint not null,
    state text not null check (state in ('live', 'draining', 'lost')),
    renewals bigint not null,
    seq bigint not null,
    attempt bigint not null,
    answer jsonb not null,
    capacity jsonb not null,
    changed bigint not null
);
create sequence if not exists compute_host_ids owned by compute_hosts.id;
create index if not exists compute_hosts_changed on compute_hosts (changed);
create table if not exists compute_sandboxes (
    id text primary key,
    team text not null,
    spec jsonb not null,
    metadata jsonb not null,
    owner bigint,
    epoch bigint not null,
    taken bigint not null,
    unanswered_epoch bigint,
    unanswered_stamp bigint,
    landed_epoch bigint,
    landed_host_epoch bigint,
    landed_seq bigint,
    class text,
    created_ms bigint not null,
    version bigint not null
);
create index if not exists compute_sandboxes_owner on compute_sandboxes (owner)
    where owner is not null;
create index if not exists compute_sandboxes_team on compute_sandboxes (team, created_ms);
create index if not exists compute_sandboxes_metadata on compute_sandboxes
    using gin (metadata jsonb_path_ops);
create table if not exists compute_keys (digest text primary key, team text not null);
create table if not exists compute_lifecycles (
    id text primary key,
    team text not null,
    record jsonb not null,
    due_ms bigint not null,
    version bigint not null
);
create index if not exists compute_lifecycles_team on compute_lifecycles (team);
create index if not exists compute_lifecycles_due on compute_lifecycles (due_ms, id collate \"C\");
create table if not exists compute_create_requests (
    team text not null,
    request_id text not null,
    id text not null,
    digest text not null,
    created_ms bigint not null,
    gone_ms bigint,
    primary key (team, request_id)
);
create index if not exists compute_create_requests_id on compute_create_requests (id);
create index if not exists compute_create_requests_gone_ms on compute_create_requests (gone_ms)
    where gone_ms is not null;
";

/// Version 2: the owner epoch under which a sandbox's stored copy is its
/// whole latest state (`whole_epoch`, see `Ownership::whole`); a host
/// taking the sandbox up under any other epoch starts it from the copy's
/// files.
const MIGRATION_2: &str = "
alter table compute_sandboxes add column if not exists whole_epoch bigint;
";

/// Version 3: when a host was given up on (`gone_ms`), so hosts given up on
/// are forgotten after a while (`Store::prune_hosts`, which also dates the
/// hosts given up on before this, or by an older build, from when it first
/// sees them); and a sandbox's owner must be a host the store has, so no
/// write, from this build or an older one still running during a rollout,
/// can name a host since forgotten. A sandbox naming a host the store does
/// not have (none should) is first given up on, as giving up on its host
/// would. The owner is checked when a transaction commits, not at each
/// statement: a registration (from this build or an older one) may give a
/// new host the sandboxes it holds before it writes the host itself.
const MIGRATION_3: &str = "
alter table compute_hosts add column if not exists gone_ms bigint;
update compute_sandboxes set owner = null, epoch = epoch + 1, version = version + 1
    where owner is not null
    and not exists (select 1 from compute_hosts where id = compute_sandboxes.owner);
alter table compute_sandboxes add constraint compute_sandboxes_owner_host
    foreign key (owner) references compute_hosts (id) deferrable initially deferred;
";

/// Version 4: the stored images built from OCI images (`Store::record_built`),
/// in the order recorded (`seq`), by the fleet's name for each.
const MIGRATION_4: &str = "
create table if not exists compute_images (
    source text primary key,
    name text not null,
    image text not null,
    built_ms bigint not null,
    seq bigint generated always as identity
);
create index if not exists compute_images_by_name on compute_images (name, seq);
";

/// The transaction-scoped advisory lock replicas starting together take
/// turns migrating by.
const MIGRATION_LOCK: i64 = 7_231_401;

/// Brings the schema to the latest version, in one transaction: either
/// every migration it lacked is applied, or none is. Replicas starting
/// together take turns.
pub(super) async fn migrate(client: &mut Object) -> Result<()> {
    let transaction = client.transaction().await.map_err(database)?;
    transaction
        .execute("select pg_advisory_xact_lock($1)", &[&MIGRATION_LOCK])
        .await
        .map_err(database)?;
    transaction
        .batch_execute(
            "create table if not exists compute_schema ( \
             one boolean primary key default true check (one), \
             version integer not null)",
        )
        .await
        .map_err(database)?;
    let version = transaction
        .query_opt("select version from compute_schema", &[])
        .await
        .map_err(database)?
        .map_or(0, |row| row.get::<_, i32>(0));
    let at = usize::try_from(version).map_err(corrupt)?;
    if at > MIGRATIONS.len() {
        // A newer build migrated it; its migrations keep what this one
        // reads.
        tracing::warn!(
            version,
            known = MIGRATIONS.len(),
            "the database's schema is newer than this build's"
        );
        return Ok(());
    }
    if at == MIGRATIONS.len() {
        return Ok(());
    }
    for migration in &MIGRATIONS[at..] {
        transaction
            .batch_execute(migration)
            .await
            .map_err(database)?;
    }
    let latest = i32::try_from(MIGRATIONS.len()).map_err(corrupt)?;
    transaction
        .execute(
            "insert into compute_schema (version) values ($1) \
             on conflict (one) do update set version = excluded.version",
            &[&latest],
        )
        .await
        .map_err(database)?;
    transaction.commit().await.map_err(database)?;
    tracing::info!(
        from = version,
        to = latest,
        "migrated the database's schema"
    );
    Ok(())
}
