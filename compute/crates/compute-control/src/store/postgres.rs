//! The store a fleet runs on: Postgres, through a pool of connections.
//!
//! Registrations and giving up on a host are transactions; everything else
//! is one conditional statement. Host rows carry a change number from a
//! sequence, which replicas read changes by.

use std::collections::BTreeMap;
use std::str::FromStr as _;

use compute_fleet::{AnsweredAt, HostEpoch, HostId, HostState, OwnerEpoch, Ownership, Sends};
use compute_protocol::fleet::{Capacity, HostInfo, Register, Renew, Report, Ruling};
use compute_protocol::host::{Id, ImageId};
use deadpool_postgres::{ClientWrapper, Manager, ManagerConfig, Pool, RecyclingMethod};
use serde_json::Value;
use tokio_postgres::Row;
use tokio_postgres::types::{Json, ToSql};

use super::{
    Admission, Admits, AgentRef, HostRow, LifecycleRow, Linked, RequestRow, Result, SandboxRow,
    Spec, Store, StoreError, Write, admits, rule,
};
use crate::e2b::lifecycle::Record;

mod images;
mod schema;

/// The advisory lock the leader holds for as long as its connection lives.
const LEADER_LOCK: i64 = 7_231_402;

const SANDBOX_COLUMNS: &str = "id, team, spec, metadata, owner, epoch, taken, \
     unanswered_epoch, unanswered_stamp, landed_epoch, landed_host_epoch, landed_seq, \
     class, created_ms, version, whole_epoch";

const LIFECYCLE_COLUMNS: &str = "id, team, record, version";

const HOST_COLUMNS: &str = "id, info, epoch, state, renewals, seq, capacity, changed";

/// Whether the owner a sandbox write names, its parameter `param`, is
/// lost: given up on, or not a host the store has (one given up on and
/// since forgotten). The live row is locked against giving up on it: a
/// write waits for a give-up under way and then sees the host lost, and a
/// give-up waits for the write and then clears the owner it wrote. A write
/// naming no owner is never refused.
fn owner_lost(param: u8) -> String {
    format!(
        "owner as (select true as lost where ${param}::bigint is not null \
         and not exists (select 1 from compute_hosts \
         where id = ${param}::bigint and state <> 'lost' for share))"
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

/// A database error, with its causes: what Postgres said is the source of
/// the client's error.
fn database(error: impl std::error::Error) -> StoreError {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    StoreError::Database(text)
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

const REQUEST_COLUMNS: &str = "team, request_id, id, digest, created_ms, gone_ms";

fn request_row(row: &Row) -> Result<RequestRow> {
    let id: String = row.get(2);
    Ok(RequestRow {
        team: row.get(0),
        request_id: row.get(1),
        id: Id::from_str(&id).map_err(corrupt)?,
        digest: row.get(3),
        created_ms: small(row.get(4))?,
        gone_ms: row.get::<_, Option<i64>>(5).map(small).transpose()?,
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
            whole: optional(row, "whole_epoch")?.map(OwnerEpoch),
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
    whole: Option<i64>,
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
            whole: row.ownership.whole.map(|epoch| big(epoch.0)).transpose()?,
        })
    }
}

impl PostgresStore {
    /// Connects to the database at `url` (a libpq connection string or
    /// URL), over TLS with `tls` when given, and brings its schema to the
    /// latest version.
    pub async fn connect(
        url: &str,
        tls: Option<rustls::ClientConfig>,
        connections: usize,
    ) -> Result<Self> {
        let config = tokio_postgres::Config::from_str(url).map_err(database)?;
        Self::connect_with(config, tls, connections).await
    }

    /// [`PostgresStore::connect`] with settings already parsed, for a
    /// caller that adds what a connection string cannot carry safely, such
    /// as a password from a secret.
    ///
    /// # Errors
    ///
    /// When the database cannot be reached or its schema not brought up
    /// to date.
    pub async fn connect_with(
        config: tokio_postgres::Config,
        tls: Option<rustls::ClientConfig>,
        connections: usize,
    ) -> Result<Self> {
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
        schema::migrate(&mut store.client().await?).await?;
        Ok(store)
    }

    async fn client(&self) -> Result<deadpool_postgres::Object> {
        self.pool.get().await.map_err(database)
    }

    /// Inserts `row`, for `row.team`'s create request `request_id` when
    /// given: then only while the request is not retired, with its row
    /// locked against [`Store::delete_retiring`], which retires it. Answers
    /// how the write went and whether the request was live.
    async fn insert_for(
        &self,
        row: &SandboxRow,
        request_id: Option<&str>,
    ) -> Result<(Write, bool)> {
        let fields = Fields::of(row)?;
        // A retired request's row is locked by the delete that retires it,
        // so this waits for that delete and then reads the row again.
        let request = "request as (select 1 from compute_create_requests \
             where team = $2 and request_id = $17 and gone_ms is null for share)";
        let (request, live) = if request_id.is_some() {
            (
                format!("{request}, "),
                " and exists (select 1 from request)",
            )
        } else {
            (String::new(), "")
        };
        let version = big(row.version)?;
        let mut params: Vec<&(dyn ToSql + Sync)> = vec![
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
            &version,
            &fields.whole,
        ];
        if let Some(request_id) = &request_id {
            params.push(request_id);
        }
        let written = self
            .client()
            .await?
            .query_one(
                &format!(
                    "with {request}{}, written as ( \
                     insert into compute_sandboxes ({SANDBOX_COLUMNS}) \
                     select $1::text, $2::text, $3::jsonb, $4::jsonb, $5::bigint, $6::bigint, \
                     $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint, $12::bigint, \
                     $13::text, $14::bigint, $15::bigint, $16::bigint \
                     where not exists (select 1 from owner where lost){live} \
                     on conflict (id) do nothing returning 1) {WRITTEN}{}",
                    owner_lost(5),
                    if request_id.is_some() {
                        ", exists (select 1 from request) as live"
                    } else {
                        ""
                    },
                ),
                &params,
            )
            .await
            .map_err(database)?;
        let live = request_id.is_none() || written.get::<_, bool>("live");
        Ok((write_of(&written), live))
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
                "select id, owner, epoch, taken, whole_epoch from compute_sandboxes \
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
                whole: optional(&row, "whole_epoch")?.map(OwnerEpoch),
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
                     whole_epoch = $5, version = version + 1 where id = $1",
                    &[
                        name,
                        &owner,
                        &big(change.set.epoch.0)?,
                        &big(change.set.taken.0)?,
                        &change.set.whole.map(|epoch| big(epoch.0)).transpose()?,
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
             state = case when compute_hosts.drained then 'draining' else 'live' end, \
             renewals = compute_hosts.renewals + 1, seq = 0, \
             attempt = excluded.attempt, answer = excluded.answer, \
             capacity = excluded.capacity, changed = excluded.changed, gone_ms = null",
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
        // A renewal without a capacity keeps the one last heard.
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts set renewals = renewals + 1, seq = greatest(seq, $3), \
                 capacity = coalesce($4, capacity), changed = nextval('compute_changes') \
                 where id = $1 and epoch = $2 and state <> 'lost' and name = any($5)",
                &[
                    &big(renew.host)?,
                    &big(renew.epoch)?,
                    &big(renew.seq)?,
                    &renew.capacity.as_ref().map(Json),
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

    async fn give_up(&self, host: HostId, renewals: u64, at_ms: u64) -> Result<Option<usize>> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let id = big(host.0)?;
        let lost = tx
            .execute(
                "update compute_hosts set state = 'lost', gone_ms = $3, \
                 changed = nextval('compute_changes') \
                 where id = $1 and renewals = $2 and state <> 'lost'",
                &[&id, &big(renewals)?, &big(at_ms)?],
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

    async fn prune_hosts(&self, before_ms: u64) -> Result<u64> {
        // A host given up on with no date (before the column, or by an
        // older build during a rollout) is dated now, by the database's
        // clock, and forgotten a whole retention later. Giving up cleared
        // every owner naming it, and no write names a host given up on, so
        // none should still name it; one that did would be kept rather than
        // stop the others from being forgotten.
        self.client()
            .await?
            .execute(
                "with dated as (update compute_hosts \
                 set gone_ms = (extract(epoch from now()) * 1000)::bigint \
                 where state = 'lost' and gone_ms is null) \
                 delete from compute_hosts where state = 'lost' and gone_ms < $1 \
                 and not exists (select 1 from compute_sandboxes \
                 where owner = compute_hosts.id)",
                &[&big(before_ms)?],
            )
            .await
            .map_err(database)
    }

    async fn set_state(&self, host: HostId, from: HostState, to: HostState) -> Result<bool> {
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts \
                 set state = case when state = 'lost' then state else $3 end, \
                 drained = $3 = 'draining', changed = nextval('compute_changes') \
                 where id = $1 and (state = $2 or (state = 'lost' and drained \
                 and $2 = 'draining' and $3 = 'live'))",
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
        self.insert_for(row, None).await.map(|(write, _)| write)
    }

    async fn insert_requested(&self, row: &SandboxRow, request_id: &str) -> Result<Option<Write>> {
        let (write, live) = self.insert_for(row, Some(request_id)).await?;
        Ok(live.then_some(write))
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

    async fn agents(&self, ids: &[Id]) -> Result<Vec<Linked>> {
        let ids: Vec<String> = ids.iter().map(ToString::to_string).collect();
        let rows = self
            .client()
            .await?
            .query(
                "select id, team, spec->'agent' as agent from compute_sandboxes \
                 where id = any($1) and spec ? 'agent'",
                &[&ids],
            )
            .await
            .map_err(database)?;
        rows.iter()
            .map(|row| {
                let id: String = row.try_get("id").map_err(corrupt)?;
                let Json(agent): Json<AgentRef> = row.try_get("agent").map_err(corrupt)?;
                Ok(Linked {
                    id: Id::from_str(&id).map_err(corrupt)?,
                    team: row.try_get("team").map_err(corrupt)?,
                    agent,
                })
            })
            .collect()
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
                     whole_epoch = $13, version = version + 1 where id = $1 and version = $12 \
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
                    &fields.whole,
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

    async fn delete_retiring(&self, id: Id, version: u64, at_ms: u64) -> Result<bool> {
        // One statement: the requests retire only if the row went, and an
        // insert for one of them waits on its row and then sees it retired.
        let deleted = self
            .client()
            .await?
            .query_one(
                "with deleted as ( \
                 delete from compute_sandboxes where id = $1 and version = $2 \
                 returning id, team), \
                 retired as ( \
                 update compute_create_requests set gone_ms = $3 \
                 from deleted \
                 where compute_create_requests.id = deleted.id \
                 and compute_create_requests.team = deleted.team \
                 and gone_ms is null) \
                 select exists (select 1 from deleted) as deleted",
                &[&id.to_string(), &big(version)?, &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        Ok(deleted.get("deleted"))
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

    async fn claim_request(&self, row: &RequestRow) -> Result<RequestRow> {
        let client = self.client().await?;
        // An insert that meets a concurrent one waits for it, then does
        // nothing; the select that follows is a new statement, so it sees
        // the row that won.
        let inserted = client
            .execute(
                &format!(
                    "insert into compute_create_requests ({REQUEST_COLUMNS}) \
                     values ($1, $2, $3, $4, $5, $6) on conflict (team, request_id) do nothing"
                ),
                &[
                    &row.team,
                    &row.request_id,
                    &row.id.to_string(),
                    &row.digest,
                    &big(row.created_ms)?,
                    &row.gone_ms.map(big).transpose()?,
                ],
            )
            .await
            .map_err(database)?;
        if inserted == 1 {
            return Ok(row.clone());
        }
        let stored = client
            .query_one(
                &format!(
                    "select {REQUEST_COLUMNS} from compute_create_requests \
                     where team = $1 and request_id = $2"
                ),
                &[&row.team, &row.request_id],
            )
            .await
            .map_err(database)?;
        request_row(&stored)
    }

    async fn request(&self, team: &str, request_id: &str) -> Result<Option<RequestRow>> {
        self.client()
            .await?
            .query_opt(
                &format!(
                    "select {REQUEST_COLUMNS} from compute_create_requests \
                     where team = $1 and request_id = $2"
                ),
                &[&team, &request_id],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(request_row)
            .transpose()
    }

    async fn prune_requests(&self, before_ms: u64) -> Result<u64> {
        self.client()
            .await?
            .execute(
                "delete from compute_create_requests where gone_ms < $1",
                &[&big(before_ms)?],
            )
            .await
            .map_err(database)
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

    async fn lifecycles_paused(
        &self,
        after: Option<Id>,
        limit: usize,
    ) -> Result<Vec<LifecycleRow>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let after = after.map_or_else(String::new, |id| id.to_string());
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where due_ms = $1 \
                     and id collate \"C\" > $2 order by id collate \"C\" limit $3"
                ),
                &[&i64::MAX, &after, &limit],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }

    async fn image_built(&self, source: &str) -> Result<Option<ImageId>> {
        self.image_built_now(source).await
    }

    async fn record_built(
        &self,
        source: &str,
        name: &str,
        image: ImageId,
        at_ms: u64,
    ) -> Result<ImageId> {
        self.record_built_now(source, name, image, at_ms).await
    }

    async fn latest_built(&self, name: &str) -> Result<Option<ImageId>> {
        self.latest_built_now(name).await
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
