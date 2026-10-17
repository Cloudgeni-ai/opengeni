//! The store a fleet runs on: Postgres, through a pool of connections.
//!
//! Registrations and giving up on a host are transactions; everything else
//! is one conditional statement. Host rows carry a change number from a
//! sequence, which replicas read changes by.

use std::collections::BTreeMap;
use std::str::FromStr as _;

use compute_fleet::{AnsweredAt, HostEpoch, HostId, HostState, OwnerEpoch, Ownership, Sends};
use compute_protocol::fleet::{Capacity, HostInfo, Register, Renew, Report, Ruling};
use compute_protocol::host::Id;
use deadpool_postgres::{ClientWrapper, Manager, ManagerConfig, Pool, RecyclingMethod};
use serde_json::Value;
use tokio_postgres::Row;
use tokio_postgres::types::Json;

use super::{
    Admission, Admits, HostRow, LifecycleRow, Result, SandboxRow, Spec, Store, StoreError, Write,
    admits, rule,
};
use crate::e2b::lifecycle::Record;

/// The tables, created if missing. Replicas starting together take turns
/// through a transaction-scoped advisory lock.
const SCHEMA: &str = "
begin;
select pg_advisory_xact_lock(7231401);
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
commit;
";

/// The advisory lock the leader holds for as long as its connection lives.
const LEADER_LOCK: i64 = 7_231_402;

const SANDBOX_COLUMNS: &str = "id, team, spec, metadata, owner, epoch, taken, \
     unanswered_epoch, unanswered_stamp, landed_epoch, landed_host_epoch, landed_seq, \
     class, created_ms, version";

const LIFECYCLE_COLUMNS: &str = "id, team, record, version";

const HOST_COLUMNS: &str = "id, info, epoch, state, renewals, seq, capacity, changed";

/// The owner a sandbox write names, its parameter `param`, locked against
/// giving up on it: a write waits for a give-up under way and then sees the
/// host lost, and a give-up waits for the write and then clears the owner
/// it wrote.
fn owner_lost(param: u8) -> String {
    format!(
        "owner as (select state = 'lost' as lost from compute_hosts \
         where id = ${param} for share)"
    )
}

/// What a sandbox write returns: whether the owner was lost, and whether
/// the row was written.
const WRITTEN: &str = "select exists (select 1 from owner where lost) as lost, \
     exists (select 1 from written) as written";

/// How a sandbox write went, from its [`WRITTEN`] row.
fn write_of(row: &Row) -> Write {
    match (row.get("lost"), row.get("written")) {
        (true, _) => Write::OwnerLost,
        (false, true) => Write::Done,
        (false, false) => Write::Conflict,
    }
}

/// Postgres, through a pool.
#[derive(Clone, Debug)]
pub struct PostgresStore {
    pool: Pool,
}

/// The leader's own connection, which holds the advisory lock; dropping it
/// closes the connection and so releases the lock.
#[derive(Debug)]
pub struct PostgresLead(ClientWrapper);

fn database(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

fn corrupt(error: impl std::fmt::Display) -> StoreError {
    StoreError::Corrupt(error.to_string())
}

/// A `u64` as Postgres's `bigint`.
fn big(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(corrupt)
}

/// A `bigint` back as a `u64`.
fn small(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(corrupt)
}

/// When a lifecycle is due, as a `bigint`: never is the largest one.
fn due(record: &Record) -> i64 {
    i64::try_from(record.due_ms()).unwrap_or(i64::MAX)
}

fn lifecycle_row(row: &Row) -> Result<LifecycleRow> {
    let id: String = row.get(0);
    let Json(record): Json<Record> = row.try_get(2).map_err(corrupt)?;
    Ok(LifecycleRow {
        id: Id::from_str(&id).map_err(corrupt)?,
        team: row.get(1),
        record,
        version: small(row.get(3))?,
    })
}

/// A registration attempt, a nonce over all of `u64`, as the `bigint` of the
/// same bits: compared only for equality, it needs no order.
fn nonce(attempt: u64) -> i64 {
    i64::from_ne_bytes(attempt.to_ne_bytes())
}

/// A stored attempt back as the nonce it was.
fn nonce_of(stored: i64) -> u64 {
    u64::from_ne_bytes(stored.to_ne_bytes())
}

fn state_name(state: HostState) -> &'static str {
    match state {
        HostState::Live => "live",
        HostState::Draining => "draining",
        HostState::Lost => "lost",
    }
}

fn state_of(name: &str) -> Result<HostState> {
    match name {
        "live" => Ok(HostState::Live),
        "draining" => Ok(HostState::Draining),
        "lost" => Ok(HostState::Lost),
        other => Err(corrupt(format!("host state {other}"))),
    }
}

fn host_row(row: &Row) -> Result<HostRow> {
    let Json(info): Json<HostInfo> = row.try_get("info").map_err(corrupt)?;
    let Json(capacity): Json<Capacity> = row.try_get("capacity").map_err(corrupt)?;
    Ok(HostRow {
        id: HostId(small(row.try_get("id").map_err(corrupt)?)?),
        info,
        epoch: HostEpoch(small(row.try_get("epoch").map_err(corrupt)?)?),
        state: state_of(row.try_get("state").map_err(corrupt)?)?,
        renewals: small(row.try_get("renewals").map_err(corrupt)?)?,
        seq: small(row.try_get("seq").map_err(corrupt)?)?,
        capacity,
        changed: small(row.try_get("changed").map_err(corrupt)?)?,
    })
}

fn optional(row: &Row, column: &str) -> Result<Option<u64>> {
    row.try_get::<_, Option<i64>>(column)
        .map_err(corrupt)?
        .map(small)
        .transpose()
}

fn sends_of(row: &Row) -> Result<Sends> {
    let unanswered = match (
        optional(row, "unanswered_epoch")?,
        optional(row, "unanswered_stamp")?,
    ) {
        (Some(epoch), Some(stamp)) => Some((OwnerEpoch(epoch), stamp)),
        _ => None,
    };
    let landed = match (optional(row, "landed_epoch")?, optional(row, "landed_seq")?) {
        (Some(epoch), Some(seq)) => Some((
            OwnerEpoch(epoch),
            AnsweredAt {
                host_epoch: optional(row, "landed_host_epoch")?.map(HostEpoch),
                seq,
            },
        )),
        _ => None,
    };
    Ok(Sends { unanswered, landed })
}

fn sandbox_row(row: &Row) -> Result<SandboxRow> {
    let id: String = row.try_get("id").map_err(corrupt)?;
    let Json(spec): Json<Spec> = row.try_get("spec").map_err(corrupt)?;
    let Json(metadata): Json<BTreeMap<String, String>> =
        row.try_get("metadata").map_err(corrupt)?;
    Ok(SandboxRow {
        id: Id::from_str(&id).map_err(corrupt)?,
        team: row.try_get("team").map_err(corrupt)?,
        spec,
        metadata,
        ownership: Ownership {
            owner: optional(row, "owner")?.map(HostId),
            epoch: OwnerEpoch(small(row.try_get("epoch").map_err(corrupt)?)?),
            taken: OwnerEpoch(small(row.try_get("taken").map_err(corrupt)?)?),
        },
        sends: sends_of(row)?,
        class: row.try_get("class").map_err(corrupt)?,
        created_ms: small(row.try_get("created_ms").map_err(corrupt)?)?,
        version: small(row.try_get("version").map_err(corrupt)?)?,
    })
}

/// A sandbox row's fields as statement parameters, in
/// [`SANDBOX_COLUMNS`] order without the version.
struct Fields {
    id: String,
    spec: Json<Spec>,
    metadata: Json<BTreeMap<String, String>>,
    owner: Option<i64>,
    epoch: i64,
    taken: i64,
    unanswered: (Option<i64>, Option<i64>),
    landed: (Option<i64>, Option<i64>, Option<i64>),
    created_ms: i64,
}

impl Fields {
    fn of(row: &SandboxRow) -> Result<Self> {
        let unanswered = match row.sends.unanswered {
            Some((epoch, stamp)) => (Some(big(epoch.0)?), Some(big(stamp)?)),
            None => (None, None),
        };
        let landed = match row.sends.landed {
            Some((epoch, at)) => (
                Some(big(epoch.0)?),
                at.host_epoch.map(|epoch| big(epoch.0)).transpose()?,
                Some(big(at.seq)?),
            ),
            None => (None, None, None),
        };
        Ok(Self {
            id: row.id.to_string(),
            spec: Json(row.spec.clone()),
            metadata: Json(row.metadata.clone()),
            owner: row.ownership.owner.map(|host| big(host.0)).transpose()?,
            epoch: big(row.ownership.epoch.0)?,
            taken: big(row.ownership.taken.0)?,
            unanswered,
            landed,
            created_ms: big(row.created_ms)?,
        })
    }
}

impl PostgresStore {
    /// Connects to the database at `url` (a libpq connection string or
    /// URL), over TLS with `tls` when given, and creates the tables if
    /// they are missing.
    pub async fn connect(
        url: &str,
        tls: Option<rustls::ClientConfig>,
        connections: usize,
    ) -> Result<Self> {
        let config = tokio_postgres::Config::from_str(url).map_err(database)?;
        let manager_config = ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        };
        let manager = match tls {
            Some(tls) => Manager::from_config(
                config,
                tokio_postgres_rustls::MakeRustlsConnect::new(tls),
                manager_config,
            ),
            None => Manager::from_config(config, tokio_postgres::NoTls, manager_config),
        };
        let pool = Pool::builder(manager)
            .max_size(connections)
            .build()
            .map_err(database)?;
        let store = Self { pool };
        store
            .client()
            .await?
            .batch_execute(SCHEMA)
            .await
            .map_err(database)?;
        Ok(store)
    }

    async fn client(&self) -> Result<deadpool_postgres::Object> {
        self.pool.get().await.map_err(database)
    }

    /// Applies a registration that meets no live one, in `tx`.
    async fn register_fresh(
        tx: &deadpool_postgres::Transaction<'_>,
        register: &Register,
        known: Option<i64>,
    ) -> Result<Admission> {
        let id = match known {
            Some(id) => id,
            None => tx
                .query_one("select nextval('compute_host_ids')", &[])
                .await
                .map_err(database)?
                .get(0),
        };
        let host = HostId(small(id)?);
        let epoch: i64 = tx
            .query_one("select nextval('compute_host_epochs')", &[])
            .await
            .map_err(database)?
            .get(0);
        let ids: Vec<String> = register
            .held
            .iter()
            .map(|held| held.id.to_string())
            .collect();
        let mut rows = BTreeMap::new();
        for row in tx
            .query(
                "select id, owner, epoch, taken from compute_sandboxes \
                 where id = any($1) order by id for update",
                &[&ids],
            )
            .await
            .map_err(database)?
        {
            let id: String = row.get("id");
            let ownership = Ownership {
                owner: optional(&row, "owner")?.map(HostId),
                epoch: OwnerEpoch(small(row.get("epoch"))?),
                taken: OwnerEpoch(small(row.get("taken"))?),
            };
            rows.insert(id, ownership);
        }
        let mut rulings: Vec<Ruling> = Vec::with_capacity(register.held.len());
        for (held, name) in register.held.iter().zip(&ids) {
            let (ruling, change) = rule(host, *held, rows.get(name).copied());
            if let Some(change) = change {
                let owner = change.set.owner.map(|host| big(host.0)).transpose()?;
                tx.execute(
                    "update compute_sandboxes set owner = $2, epoch = $3, taken = $4, \
                     version = version + 1 where id = $1",
                    &[
                        name,
                        &owner,
                        &big(change.set.epoch.0)?,
                        &big(change.set.taken.0)?,
                    ],
                )
                .await
                .map_err(database)?;
            }
            rulings.push(ruling);
        }
        tx.execute(
            "insert into compute_hosts \
             (id, name, info, epoch, state, renewals, seq, attempt, answer, capacity, changed) \
             values ($1, $2, $3, $4, 'live', 1, 0, $5, $6, $7, nextval('compute_changes')) \
             on conflict (id) do update set info = excluded.info, epoch = excluded.epoch, \
             state = 'live', renewals = compute_hosts.renewals + 1, seq = 0, \
             attempt = excluded.attempt, answer = excluded.answer, \
             capacity = excluded.capacity, changed = excluded.changed",
            &[
                &id,
                &register.info.name,
                &Json(&register.info),
                &epoch,
                &nonce(register.attempt),
                &Json(&rulings),
                &Json(&register.capacity),
            ],
        )
        .await
        .map_err(database)?;
        Ok(Admission::Registered {
            host,
            epoch: HostEpoch(small(epoch)?),
            rulings,
        })
    }
}

impl Store for PostgresStore {
    type Lead = PostgresLead;

    async fn register(&self, register: &Register) -> Result<Admission> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let found = tx
            .query_opt(
                "select id, state, attempt, epoch, answer from compute_hosts \
                 where name = $1 for update",
                &[&register.info.name],
            )
            .await
            .map_err(database)?;
        let known = match &found {
            Some(row) => Some((
                row.get::<_, i64>("id"),
                state_of(row.get("state"))?,
                nonce_of(row.get("attempt")),
            )),
            None => None,
        };
        match admits(
            known.map(|(_, state, attempt)| (state, attempt)),
            register.attempt,
        ) {
            Admits::Again => {
                let row = found.expect("a row");
                let Json(rulings): Json<Vec<Ruling>> = row.try_get("answer").map_err(corrupt)?;
                return Ok(Admission::Registered {
                    host: HostId(small(row.get("id"))?),
                    epoch: HostEpoch(small(row.get("epoch"))?),
                    rulings,
                });
            }
            Admits::StillLive => return Ok(Admission::StillLive),
            Admits::Fresh => {}
        }
        let admission = Self::register_fresh(&tx, register, known.map(|(id, ..)| id)).await?;
        tx.commit().await.map_err(database)?;
        Ok(admission)
    }

    async fn renew(&self, renew: &Renew, names: &[String]) -> Result<bool> {
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts set renewals = renewals + 1, seq = greatest(seq, $3), \
                 capacity = $4, changed = nextval('compute_changes') \
                 where id = $1 and epoch = $2 and state <> 'lost' and name = any($5)",
                &[
                    &big(renew.host)?,
                    &big(renew.epoch)?,
                    &big(renew.seq)?,
                    &Json(&renew.capacity),
                    &names,
                ],
            )
            .await
            .map_err(database)?;
        Ok(updated == 1)
    }

    async fn report(&self, report: &Report, names: &[String]) -> Result<bool> {
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts set capacity = $3, changed = nextval('compute_changes') \
                 where id = $1 and epoch = $2 and state <> 'lost' and name = any($4)",
                &[
                    &big(report.host)?,
                    &big(report.epoch)?,
                    &Json(&report.capacity),
                    &names,
                ],
            )
            .await
            .map_err(database)?;
        Ok(updated == 1)
    }

    async fn hosts_changed(&self, after: u64) -> Result<Vec<HostRow>> {
        let rows = self
            .client()
            .await?
            .query(
                &format!(
                    "select {HOST_COLUMNS} from compute_hosts where changed > $1 order by changed"
                ),
                &[&big(after)?],
            )
            .await
            .map_err(database)?;
        rows.iter().map(host_row).collect()
    }

    async fn renewals(&self) -> Result<Vec<(HostId, u64)>> {
        let rows = self
            .client()
            .await?
            .query(
                "select id, renewals from compute_hosts where state <> 'lost'",
                &[],
            )
            .await
            .map_err(database)?;
        rows.iter()
            .map(|row| Ok((HostId(small(row.get(0))?), small(row.get(1))?)))
            .collect()
    }

    async fn give_up(&self, host: HostId, renewals: u64) -> Result<Option<usize>> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let id = big(host.0)?;
        let lost = tx
            .execute(
                "update compute_hosts set state = 'lost', changed = nextval('compute_changes') \
                 where id = $1 and renewals = $2 and state <> 'lost'",
                &[&id, &big(renewals)?],
            )
            .await
            .map_err(database)?;
        if lost != 1 {
            return Ok(None);
        }
        let cleared = tx
            .execute(
                "update compute_sandboxes set owner = null, epoch = epoch + 1, \
                 version = version + 1 where owner = $1",
                &[&id],
            )
            .await
            .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(Some(usize::try_from(cleared).map_err(corrupt)?))
    }

    async fn set_state(&self, host: HostId, from: HostState, to: HostState) -> Result<bool> {
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts set state = $3, changed = nextval('compute_changes') \
                 where id = $1 and state = $2",
                &[&big(host.0)?, &state_name(from), &state_name(to)],
            )
            .await
            .map_err(database)?;
        Ok(updated == 1)
    }

    async fn try_lead(&self) -> Result<Option<PostgresLead>> {
        let client = self.client().await?;
        let taken: bool = client
            .query_one("select pg_try_advisory_lock($1)", &[&LEADER_LOCK])
            .await
            .map_err(database)?
            .get(0);
        // Taken out of the pool either way: a pooled connection must never
        // carry the lock to a request.
        let client = deadpool_postgres::Object::take(client);
        Ok(taken.then_some(PostgresLead(client)))
    }

    async fn leads(&self, lead: &mut PostgresLead) -> bool {
        !lead.0.is_closed() && lead.0.simple_query("select 1").await.is_ok()
    }

    async fn insert(&self, row: &SandboxRow) -> Result<Write> {
        let fields = Fields::of(row)?;
        let written = self
            .client()
            .await?
            .query_one(
                &format!(
                    "with {}, written as ( \
                     insert into compute_sandboxes ({SANDBOX_COLUMNS}) \
                     select $1::text, $2::text, $3::jsonb, $4::jsonb, $5::bigint, $6::bigint, \
                     $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint, $12::bigint, \
                     $13::text, $14::bigint, $15::bigint \
                     where not exists (select 1 from owner where lost) \
                     on conflict (id) do nothing returning 1) {WRITTEN}",
                    owner_lost(5)
                ),
                &[
                    &fields.id,
                    &row.team,
                    &fields.spec,
                    &fields.metadata,
                    &fields.owner,
                    &fields.epoch,
                    &fields.taken,
                    &fields.unanswered.0,
                    &fields.unanswered.1,
                    &fields.landed.0,
                    &fields.landed.1,
                    &fields.landed.2,
                    &row.class,
                    &fields.created_ms,
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(write_of(&written))
    }

    async fn sandbox(&self, id: Id) -> Result<Option<SandboxRow>> {
        self.client()
            .await?
            .query_opt(
                &format!("select {SANDBOX_COLUMNS} from compute_sandboxes where id = $1"),
                &[&id.to_string()],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(sandbox_row)
            .transpose()
    }

    async fn replace(&self, row: &SandboxRow) -> Result<Write> {
        let fields = Fields::of(row)?;
        let written = self
            .client()
            .await?
            .query_one(
                &format!(
                    "with {}, written as ( \
                     update compute_sandboxes set metadata = $2, owner = $3, epoch = $4, \
                     taken = $5, unanswered_epoch = $6, unanswered_stamp = $7, \
                     landed_epoch = $8, landed_host_epoch = $9, landed_seq = $10, class = $11, \
                     version = version + 1 where id = $1 and version = $12 \
                     and not exists (select 1 from owner where lost) returning 1) {WRITTEN}",
                    owner_lost(3)
                ),
                &[
                    &fields.id,
                    &fields.metadata,
                    &fields.owner,
                    &fields.epoch,
                    &fields.taken,
                    &fields.unanswered.0,
                    &fields.unanswered.1,
                    &fields.landed.0,
                    &fields.landed.1,
                    &fields.landed.2,
                    &row.class,
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(write_of(&written))
    }

    async fn delete(&self, id: Id, version: u64) -> Result<bool> {
        let deleted = self
            .client()
            .await?
            .execute(
                "delete from compute_sandboxes where id = $1 and version = $2",
                &[&id.to_string(), &big(version)?],
            )
            .await
            .map_err(database)?;
        Ok(deleted == 1)
    }

    async fn list(
        &self,
        team: &str,
        metadata: &BTreeMap<String, String>,
    ) -> Result<Vec<SandboxRow>> {
        let filter: Value = serde_json::to_value(metadata).map_err(corrupt)?;
        let rows = self
            .client()
            .await?
            .query(
                &format!(
                    "select {SANDBOX_COLUMNS} from compute_sandboxes \
                     where team = $1 and metadata @> $2 order by created_ms, id"
                ),
                &[&team, &Json(filter)],
            )
            .await
            .map_err(database)?;
        rows.iter().map(sandbox_row).collect()
    }

    async fn owned_by(&self, host: HostId) -> Result<Vec<SandboxRow>> {
        let rows = self
            .client()
            .await?
            .query(
                &format!("select {SANDBOX_COLUMNS} from compute_sandboxes where owner = $1"),
                &[&big(host.0)?],
            )
            .await
            .map_err(database)?;
        rows.iter().map(sandbox_row).collect()
    }

    async fn team_of(&self, digest: &str) -> Result<Option<String>> {
        Ok(self
            .client()
            .await?
            .query_opt(
                "select team from compute_keys where digest = $1",
                &[&digest],
            )
            .await
            .map_err(database)?
            .map(|row| row.get(0)))
    }

    async fn add_key(&self, digest: &str, team: &str) -> Result<()> {
        self.client()
            .await?
            .execute(
                "insert into compute_keys (digest, team) values ($1, $2) \
                 on conflict (digest) do update set team = excluded.team",
                &[&digest, &team],
            )
            .await
            .map_err(database)?;
        Ok(())
    }

    async fn insert_lifecycle(&self, row: &LifecycleRow) -> Result<bool> {
        let written = self
            .client()
            .await?
            .execute(
                "insert into compute_lifecycles (id, team, record, due_ms, version) \
                 values ($1, $2, $3, $4, $5) on conflict (id) do nothing",
                &[
                    &row.id.to_string(),
                    &row.team,
                    &Json(&row.record),
                    &due(&row.record),
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(written == 1)
    }

    async fn lifecycle(&self, id: Id) -> Result<Option<LifecycleRow>> {
        self.client()
            .await?
            .query_opt(
                &format!("select {LIFECYCLE_COLUMNS} from compute_lifecycles where id = $1"),
                &[&id.to_string()],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(lifecycle_row)
            .transpose()
    }

    async fn replace_lifecycle(&self, row: &LifecycleRow) -> Result<bool> {
        let written = self
            .client()
            .await?
            .execute(
                "update compute_lifecycles set record = $2, due_ms = $3, version = version + 1 \
                 where id = $1 and version = $4",
                &[
                    &row.id.to_string(),
                    &Json(&row.record),
                    &due(&row.record),
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(written == 1)
    }

    async fn delete_lifecycle(&self, id: Id, version: u64) -> Result<bool> {
        let deleted = self
            .client()
            .await?
            .execute(
                "delete from compute_lifecycles where id = $1 and version = $2",
                &[&id.to_string(), &big(version)?],
            )
            .await
            .map_err(database)?;
        Ok(deleted == 1)
    }

    async fn lifecycles(&self, team: &str) -> Result<Vec<LifecycleRow>> {
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where team = $1 order by id"
                ),
                &[&team],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }

    async fn lifecycles_due(
        &self,
        now_ms: u64,
        after: Option<(u64, Id)>,
        limit: usize,
    ) -> Result<Vec<LifecycleRow>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        // The largest `bigint` is never (see `due`), so no time reaches it.
        let now = i64::try_from(now_ms).unwrap_or(i64::MAX).min(i64::MAX - 1);
        // Due times are never negative, so -1 comes before every row.
        let (after_due, after_id) = after.map_or((-1, String::new()), |(due, id)| {
            (i64::try_from(due).unwrap_or(i64::MAX), id.to_string())
        });
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where due_ms <= $1 \
                     and (due_ms, id collate \"C\") > ($2, $3) \
                     order by due_ms, id collate \"C\" limit $4"
                ),
                &[&now, &after_due, &after_id, &limit],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_attempt_round_trips_through_a_bigint() {
        for attempt in [0, 1, u64::MAX / 2, u64::MAX / 2 + 1, u64::MAX] {
            assert_eq!(super::nonce_of(super::nonce(attempt)), attempt);
        }
        assert!(
            super::nonce(u64::MAX) < 0,
            "the upper half is stored, not refused"
        );
    }
}
