//! Carrying out the E2B lifecycle: creates, pauses, kills, connects (which
//! resume), timeouts, and the sweeper that applies timeouts and finishes
//! what a crash cut short.
//!
//! Every change is a conditional write of the sandbox's record
//! ([`super::lifecycle`]) first, then the work on the host. A replica that
//! stops between the two leaves a record that is due at once, so another
//! replica's sweeper finishes the work.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_guest::GATEWAY_PORT;
use compute_guest::envd::InitData;
use compute_protocol::host::{Id, LevelName, PriorityName, SandboxConfig};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::time::Instant;

use super::lifecycle::{self, Due, OnConnect, OnPause, OnTimeout, Record, State};
use super::wire::NewSandbox;
use super::{Front, Refused};
use crate::service::{Depth, Failure, new_id};
use crate::store::{LifecycleRow, Spec, Store, replace_lifecycle};

/// How the hold an open stream keeps on its sandbox is named: this, then
/// the replica's name (see [`super::traffic`]).
pub const STREAM_HOLD: &str = "e2b-streams-";

/// How long the guest may take to pass a create's `init` to envd.
const INIT_WITHIN: Duration = Duration::from_secs(60);
/// How often a pause asks its host how deep the sandbox sleeps.
const POLL_EVERY: Duration = Duration::from_millis(250);
/// How often a pause asks its host again to save the sandbox.
const SLEEP_AGAIN_EVERY: Duration = Duration::from_secs(2);
/// How often a connect looks again at a pause or create under way.
const WAIT_EVERY: Duration = Duration::from_millis(200);
/// How long the sweeper leaves a sandbox alone after failing on it.
const SWEEP_BACKOFF: Duration = Duration::from_secs(5);
/// How many due records the sweeper reads at a time.
const SWEEP_BATCH: usize = 64;
/// How many paused records a check of their hosts reads at a time.
const CHECK_BATCH: usize = 256;

/// The time now in milliseconds since the Unix epoch.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// A random token: 32 bytes in hex.
fn token() -> Result<String, Refused> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| Refused::internal(format!("no randomness: {error}")))?;
    Ok(bytes
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        }))
}

/// A team's sandbox's record; gone to everyone but its team.
async fn read<S: Store>(front: &Front<S>, team: &str, id: Id) -> Result<LifecycleRow, Refused> {
    front
        .store()
        .lifecycle(id)
        .await?
        .filter(|row| row.team == team)
        .ok_or_else(|| Refused::not_found(id))
}

/// A sandbox created: its id and its record.
#[derive(Debug)]
pub struct Created {
    pub id: Id,
    pub record: Record,
}

/// Creates a sandbox from `body` for `team`: records it as `Creating`,
/// has the fleet create it, gives envd its environment and access token
/// through the guest's gateway, and records it `Running`.
///
/// # Errors
///
/// For a body asking for what is not offered or for an unknown template,
/// and when the fleet or the guest fails; a failed create is killed.
pub async fn create<S: Store>(
    front: &Front<S>,
    team: &str,
    body: NewSandbox,
) -> Result<Created, Refused> {
    body.refuse_unoffered().map_err(Refused::invalid)?;
    let template = front
        .settings
        .templates
        .get(&body.template_id)
        .ok_or_else(|| Refused::new(404, format!("template '{}' not found", body.template_id)))?
        .clone();
    let timeout_ms = lifecycle::timeout_ms(body.timeout).map_err(Refused::invalid)?;
    let auto_pause = body.auto_pause.unwrap_or(false);
    let auto_resume = body.auto_resume.is_some_and(|resume| resume.enabled);
    if auto_resume && !auto_pause {
        return Err(Refused::invalid(
            "autoResume needs autoPause: a sandbox that is killed at its timeout cannot resume",
        ));
    }
    let public = body
        .network
        .as_ref()
        .and_then(|network| network.allow_public_traffic)
        .unwrap_or(true);
    let id = new_id()?;
    let now = now_ms();
    let record = Record {
        template: body.template_id.clone(),
        state: State::Creating,
        started_ms: now,
        end_ms: now.saturating_add(timeout_ms),
        timeout_ms,
        on_timeout: if auto_pause {
            OnTimeout::Pause
        } else {
            OnTimeout::Kill
        },
        auto_resume,
        envd_token: token()?,
        traffic_token: if public { None } else { Some(token()?) },
        cpu_count: u32::from(template.vcpus),
        memory_mb: template.memory_mib,
        changed_ms: now,
    };
    let row = LifecycleRow {
        id,
        team: team.to_owned(),
        record,
        version: 1,
    };
    if !front.store().insert_lifecycle(&row).await? {
        return Err(Refused::internal("a new sandbox id was taken; try again"));
    }
    let init = InitData {
        env_vars: body.env_vars.unwrap_or_default(),
        access_token: Some(row.record.envd_token.clone()),
        default_user: None,
        default_workdir: None,
    };
    let spec = Spec {
        image: template.image.clone(),
        config: SandboxConfig::new(template.vcpus, template.memory_mib, front.settings.sleep),
    };
    let metadata: BTreeMap<String, String> = body.metadata.unwrap_or_default();
    let started = async {
        front.service.create_as(id, team, spec, metadata).await?;
        give_init(front, team, id, &init).await
    };
    if let Err(refused) = started.await {
        tracing::warn!(%id, error = %refused.message, "an E2B create failed; killing it");
        if let Err(error) = kill(front, team, id).await {
            tracing::warn!(%id, error = %error.message, "killing a failed create; the sweeper goes on");
        }
        return Err(refused);
    }
    let record = settle(front, team, id, |record, now| match record.state {
        State::Creating => {
            record.set(State::Running, now);
            record.end_ms = now.saturating_add(record.timeout_ms);
            Ok(true)
        }
        State::Killing => Err(Refused::not_found(id)),
        _ => Ok(false),
    })
    .await?;
    Ok(Created { id, record })
}

/// Gives envd its environment and token through the guest's gateway.
async fn give_init<S: Store>(
    front: &Front<S>,
    team: &str,
    id: Id,
    init: &InitData,
) -> Result<(), Refused> {
    let reached = front
        .service
        .connect(team, id, GATEWAY_PORT, PriorityName::Interactive)
        .await?;
    let mut stream = reached.answered.stream;
    let json = serde_json::to_string(init)
        .map_err(|error| Refused::internal(format!("encoding init: {error}")))?;
    let answer = tokio::time::timeout(INIT_WITHIN, async {
        stream
            .get_mut()
            .write_all(format!("init {json}\n").as_bytes())
            .await?;
        stream.get_mut().flush().await?;
        let mut line = String::new();
        (&mut stream).take(1024).read_line(&mut line).await?;
        Ok::<_, std::io::Error>(line)
    })
    .await
    .map_err(|_| Refused::new(502, "the sandbox's envd did not take its init in time"))?
    .map_err(|error| Refused::new(502, format!("giving the sandbox its init: {error}")))?;
    match answer.trim_end() {
        "ok" => Ok(()),
        other => Err(Refused::new(
            502,
            format!("the sandbox refused its init: {other}"),
        )),
    }
}

/// Applies `change` to a sandbox's record until a write lands, and answers
/// the record as written. `change` answers whether it changed anything,
/// or refuses.
async fn settle<S: Store>(
    front: &Front<S>,
    team: &str,
    id: Id,
    mut change: impl FnMut(&mut Record, u64) -> Result<bool, Refused>,
) -> Result<Record, Refused> {
    loop {
        let mut row = read(front, team, id).await?;
        if !change(&mut row.record, now_ms())? {
            return Ok(row.record);
        }
        if replace_lifecycle(front.store(), &mut row).await? {
            return Ok(row.record);
        }
    }
}

/// Pauses a team's sandbox: records `Pausing`, ends its streams, has its
/// host save it, and records `Paused` once the host reports it saved.
///
/// # Errors
///
/// 409 when it is paused already or not created yet, 404 when gone, and
/// 503 when the save takes longer than the settings allow: the pause then
/// goes on in the background.
pub async fn pause<S: Store>(front: &Front<S>, team: &str, id: Id) -> Result<(), Refused> {
    let mut began = false;
    settle(front, team, id, |record, now| {
        match lifecycle::on_pause(record.state) {
            OnPause::Begin => {
                record.set(State::Pausing, now);
                began = true;
                Ok(true)
            }
            OnPause::Join => Ok(false),
            OnPause::AlreadyPaused => {
                Err(Refused::new(409, format!("sandbox {id} is already paused")))
            }
            OnPause::NotYet => Err(Refused::new(
                409,
                format!("sandbox {id} is still being created"),
            )),
            OnPause::Gone => Err(Refused::not_found(id)),
        }
    })
    .await?;
    tracing::debug!(%id, began, "pausing an E2B sandbox");
    finish_pause(front, team, id, front.settings.pause_within).await
}

/// Finishes a pause recorded as `Pausing`, within `within`. It ends this
/// replica's streams and releases its hold; every other replica's sweeper
/// sees `Pausing` and does the same for its own, and until then the host
/// keeps the sandbox awake, so the save is asked for again until it is
/// done.
///
/// Every step is for the pause the record still asks for: each round reads
/// it again and stops once it is no longer `Pausing` (finished, or
/// resumed after another replica finished it). `Paused` is written only on
/// condition that the record is still at the version read before the host
/// reported the save, so traffic that woke the sandbox meanwhile, and
/// wrote the record again (see [`fence_wake`]), makes it look again.
async fn finish_pause<S: Store>(
    front: &Front<S>,
    team: &str,
    id: Id,
    within: Duration,
) -> Result<(), Refused> {
    let deadline = Instant::now() + within;
    let mut asked_at: Option<Instant> = None;
    loop {
        let mut row = read(front, team, id).await?;
        match row.record.state {
            State::Pausing => {}
            State::Paused => return Ok(()),
            State::Running | State::Creating => {
                // Resumed after another replica finished the pause. A
                // save this asked for may have come after the resume's
                // wake, so it is woken again, and the pause fenced against
                // it like any wake.
                if asked_at.is_some() {
                    let woken = front
                        .service
                        .wake(team, id, PriorityName::Interactive)
                        .await;
                    if let Err(refused) = woken.map_err(Refused::from) {
                        tracing::debug!(%id, error = %refused.message, "waking a sandbox resumed during a pause");
                    }
                    fence_wake(front, id).await?;
                }
                return Ok(());
            }
            State::Killing => return Err(Refused::not_found(id)),
        }
        if asked_at.is_none() {
            front.traffic.cut(id);
            match front.service.release(team, id, front.stream_hold()).await {
                Ok(()) | Err(Failure::NotFound) => {}
                Err(failure) => {
                    tracing::debug!(%id, %failure, "releasing a pausing sandbox's stream hold");
                }
            }
        }
        if asked_at.is_none_or(|at| at.elapsed() >= SLEEP_AGAIN_EVERY) {
            asked_at = Some(Instant::now());
            match front.service.sleep(team, id, LevelName::Saved).await {
                Ok(()) => {}
                Err(Failure::NotFound) => return gone(front, id).await,
                Err(failure) => tracing::debug!(%id, %failure, "asking for a pause's save"),
            }
        }
        match front.service.depth(team, id).await {
            Ok(depth) if depth.saved() => {
                row.record.set(State::Paused, now_ms());
                if replace_lifecycle(front.store(), &mut row).await? {
                    return Ok(());
                }
                // Written meanwhile: look again at once.
                continue;
            }
            Ok(_) => {}
            Err(Failure::NotFound) => return gone(front, id).await,
            Err(failure) => {
                tracing::debug!(%id, %failure, "asking how deep a pausing sandbox sleeps");
            }
        }
        if Instant::now() >= deadline {
            return Err(Refused::new(
                503,
                format!("sandbox {id} is still pausing; it goes on in the background"),
            ));
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

/// Checks that the hosts of paused sandboxes keep them saved, and pauses
/// again any found awake: a wake-capable call that started before a pause
/// may reach its host after the pause completed, from a replica that has
/// stopped since too. Reads paused records a page at a time; each owner
/// host is asked once per page for all it owns. A sandbox found awake is
/// recorded as pausing again, conditional on the record read before its
/// host was asked, so a resume meanwhile wins; the sweeper then finishes
/// that pause like any other, so no pause is waited for here.
pub async fn check_paused<S: Store>(front: &Front<S>) {
    let mut after = None;
    loop {
        let paused = match front.store().lifecycles_paused(after, CHECK_BATCH).await {
            Ok(paused) => paused,
            Err(error) => {
                tracing::warn!(%error, "reading paused E2B sandboxes");
                return;
            }
        };
        let Some(last) = paused.last() else {
            return;
        };
        after = Some(last.id);
        let full = paused.len() == CHECK_BATCH;
        let asked: Vec<(String, Id)> = paused
            .iter()
            .map(|row| (row.team.clone(), row.id))
            .collect();
        let depths: HashMap<Id, Result<Depth, Failure>> =
            front.service.depths(&asked).await.into_iter().collect();
        for row in paused {
            match depths.get(&row.id) {
                Some(Ok(depth)) if !depth.saved() => {
                    if let Err(refused) = pause_again(front, row).await {
                        tracing::debug!(error = %refused.message, "pausing again a paused sandbox found awake");
                    }
                }
                Some(Err(Failure::NotFound)) => {
                    if let Err(refused) = gone(front, row.id).await {
                        tracing::debug!(error = %refused.message, "forgetting a sandbox the fleet no longer has");
                    }
                }
                _ => {}
            }
        }
        if !full {
            return;
        }
    }
}

/// Records as pausing again a sandbox recorded paused that its host was
/// found to run, for the sweeper to finish, unless the record changed
/// since it was read.
async fn pause_again<S: Store>(front: &Front<S>, mut row: LifecycleRow) -> Result<(), Refused> {
    tracing::info!(id = %row.id, "a paused sandbox was found awake; pausing it again");
    row.record.set(State::Pausing, now_ms());
    replace_lifecycle(front.store(), &mut row).await?;
    Ok(())
}

/// After traffic that may have woken sandbox `id` (a connect through its
/// host, or a hold), found running before it: repairs at once a pause
/// that began or finished since. A `Paused` record goes back to
/// `Pausing`, and a `Pausing` one is written again, so a pause about to
/// record `Paused` looks at the host again; the sweeper of any replica
/// then finishes the pause. When this does not run (its caller gone, or
/// its replica stopped), [`check_paused`] finds the sandbox awake later.
/// Answers whether the sandbox is still recorded running.
///
/// # Errors
///
/// When the store fails; the caller tries again.
pub async fn fence_wake<S: Store>(front: &Front<S>, id: Id) -> Result<bool, Refused> {
    loop {
        let Some(mut row) = front.store().lifecycle(id).await? else {
            return Ok(false);
        };
        match row.record.state {
            State::Running => return Ok(true),
            State::Creating | State::Killing => return Ok(false),
            State::Pausing | State::Paused => {
                row.record.set(State::Pausing, now_ms());
                if replace_lifecycle(front.store(), &mut row).await? {
                    return Ok(false);
                }
            }
        }
    }
}

/// The fleet no longer has the sandbox: forget its record too.
async fn gone<S: Store>(front: &Front<S>, id: Id) -> Result<(), Refused> {
    front.traffic.forget(id);
    if let Some(row) = front.store().lifecycle(id).await? {
        front.store().delete_lifecycle(id, row.version).await?;
    }
    Err(Refused::not_found(id))
}

/// Kills a team's sandbox: records `Killing`, ends its streams, has the
/// fleet delete it, and deletes its record.
///
/// # Errors
///
/// 404 when it is gone already, and when the fleet cannot delete it now:
/// the sweeper then goes on with it.
pub async fn kill<S: Store>(front: &Front<S>, team: &str, id: Id) -> Result<(), Refused> {
    settle(front, team, id, |record, now| {
        if record.state == State::Killing {
            return Ok(false);
        }
        record.set(State::Killing, now);
        Ok(true)
    })
    .await?;
    finish_kill(front, team, id).await
}

/// Finishes a kill recorded as `Killing`.
async fn finish_kill<S: Store>(front: &Front<S>, team: &str, id: Id) -> Result<(), Refused> {
    front.traffic.cut(id);
    match front.service.delete(team, id).await {
        Ok(()) | Err(Failure::NotFound) => {}
        Err(failure) => return Err(failure.into()),
    }
    front.traffic.forget(id);
    loop {
        let Some(row) = front.store().lifecycle(id).await? else {
            return Ok(());
        };
        if front.store().delete_lifecycle(id, row.version).await? {
            return Ok(());
        }
    }
}

/// What a connect found.
#[derive(Debug)]
pub struct Connected {
    pub record: Record,
    /// Whether it was paused and this resumed it.
    pub resumed: bool,
}

/// Connects to a team's sandbox: a running one gets a later timeout if
/// `timeout_ms` asks for one, a paused one resumes with that timeout (its
/// own when `None`), and one pausing or being created is waited for.
///
/// # Errors
///
/// 404 when gone, and when waking it fails.
pub async fn connect<S: Store>(
    front: &Front<S>,
    team: &str,
    id: Id,
    timeout_ms: Option<u64>,
) -> Result<Connected, Refused> {
    let deadline = Instant::now() + front.service.settings().wake_within;
    loop {
        let row = read(front, team, id).await?;
        match lifecycle::on_connect(row.record.state) {
            OnConnect::Extend => {
                let record = match timeout_ms {
                    None => row.record,
                    Some(timeout_ms) => {
                        settle(front, team, id, |record, now| {
                            if record.state != State::Running {
                                return Ok(false);
                            }
                            let end = lifecycle::extended(record.end_ms, now, timeout_ms);
                            let later = end != record.end_ms;
                            record.end_ms = end;
                            Ok(later)
                        })
                        .await?
                    }
                };
                return Ok(Connected {
                    record,
                    resumed: false,
                });
            }
            OnConnect::Resume => {
                let mut resumed = false;
                let record = settle(front, team, id, |record, now| {
                    if record.state != State::Paused {
                        return Ok(false);
                    }
                    record.set(State::Running, now);
                    record.end_ms = now.saturating_add(timeout_ms.unwrap_or(record.timeout_ms));
                    resumed = true;
                    Ok(true)
                })
                .await?;
                if !resumed {
                    continue;
                }
                front
                    .service
                    .wake(team, id, PriorityName::Interactive)
                    .await?;
                // Paused again while it woke: what was asked for is a
                // running sandbox, so it resumes again.
                if !fence_wake(front, id).await? {
                    continue;
                }
                return Ok(Connected {
                    record,
                    resumed: true,
                });
            }
            OnConnect::Wait => {
                if Instant::now() >= deadline {
                    return Err(Refused::new(
                        503,
                        format!("sandbox {id} is still changing state; try again"),
                    ));
                }
                tokio::time::sleep(WAIT_EVERY).await;
            }
            OnConnect::Gone => return Err(Refused::not_found(id)),
        }
    }
}

/// Sets a team's running sandbox's timeout to `timeout_ms` from now,
/// earlier or later.
///
/// # Errors
///
/// 404 when gone, 409 when it is paused or not created yet.
pub async fn set_timeout<S: Store>(
    front: &Front<S>,
    team: &str,
    id: Id,
    timeout_ms: u64,
) -> Result<Record, Refused> {
    settle(front, team, id, |record, now| match record.state {
        State::Running => {
            record.end_ms = now.saturating_add(timeout_ms);
            Ok(true)
        }
        State::Pausing | State::Paused => Err(Refused::new(409, format!("sandbox {id} is paused"))),
        State::Creating => Err(Refused::new(
            409,
            format!("sandbox {id} is still being created"),
        )),
        State::Killing => Err(Refused::not_found(id)),
    })
    .await
}

/// Applies timeouts, and finishes pauses and kills a crash cut short, for
/// as long as it runs. Every replica runs one; a sandbox two replicas work
/// on at once ends the same way, since every step is idempotent. Each round
/// reads every due record, a page at a time, so records it cannot finish
/// yet (a host away, say) never keep it from later ones. Alongside, and
/// apart, so neither holds up the other, it checks paused sandboxes'
/// hosts ([`check_paused`]): a check starts every period, or as soon as
/// the previous one ends if that took longer.
pub async fn sweep<S: Store>(front: Arc<Front<S>>) {
    let rounds = async {
        let mut every = tokio::time::interval(front.settings.sweep_every);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            sweep_round(&front).await;
        }
    };
    let checks = async {
        let mut every = tokio::time::interval_at(
            Instant::now() + front.settings.check_paused_every,
            front.settings.check_paused_every,
        );
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            check_paused(&front).await;
        }
    };
    tokio::join!(rounds, checks);
}

/// One round of the sweeper: starts the work due for every due record it
/// is not already working on or leaving alone after a failure.
pub async fn sweep_round<S: Store>(front: &Arc<Front<S>>) {
    let now = now_ms();
    let mut after = None;
    loop {
        let due = match front.store().lifecycles_due(now, after, SWEEP_BATCH).await {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!(%error, "reading due E2B sandboxes");
                return;
            }
        };
        let full = due.len() == SWEEP_BATCH;
        after = due.last().map(|row| (row.record.due_ms(), row.id));
        for row in due {
            if !front.begin_sweep(row.id) {
                continue;
            }
            let front = Arc::clone(front);
            tokio::spawn(async move {
                let id = row.id;
                let result = sweep_row(&front, row).await;
                if let Err(refused) = &result {
                    tracing::warn!(%id, error = %refused.message, "sweeping an E2B sandbox");
                }
                front.end_sweep(id, result.is_ok());
            });
        }
        if !full {
            return;
        }
    }
}

/// Does what is due for one record as it was read. A record changed since
/// (a timeout moved, a connect) is left alone: every transition the sweep
/// begins is conditional on the version read, and the next sweep decides
/// again.
///
/// # Errors
///
/// When the store, the fleet or the host fail.
pub async fn sweep_row<S: Store>(front: &Front<S>, row: LifecycleRow) -> Result<(), Refused> {
    let team = row.team.clone();
    let mut row = row;
    match lifecycle::due(&row.record, now_ms()) {
        Due::Nothing => Ok(()),
        Due::Kill => {
            if row.record.state != State::Killing {
                row.record.set(State::Killing, now_ms());
                if !replace_lifecycle(front.store(), &mut row).await? {
                    return Ok(());
                }
            }
            finish_kill(front, &team, row.id).await
        }
        Due::Pause => {
            if row.record.state == State::Running {
                row.record.set(State::Pausing, now_ms());
                if !replace_lifecycle(front.store(), &mut row).await? {
                    // Changed meanwhile: the next sweep decides again.
                    return Ok(());
                }
            }
            match Box::pin(finish_pause(
                front,
                &team,
                row.id,
                front.settings.pause_within,
            ))
            .await
            {
                Err(refused) if refused.status == 404 => Ok(()),
                other => other,
            }
        }
    }
}

impl<S> Front<S> {
    /// Whether the sweeper may take `id` now; marks it taken.
    fn begin_sweep(&self, id: Id) -> bool {
        let mut sweeping = self
            .sweeping
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match sweeping.get(&id) {
            Some(None) => false,
            Some(Some(until)) if Instant::now() < *until => false,
            _ => {
                sweeping.insert(id, None);
                true
            }
        }
    }

    /// The sweeper is done with `id`, for now if it failed.
    fn end_sweep(&self, id: Id, done: bool) {
        let mut sweeping = self
            .sweeping
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if done {
            sweeping.remove(&id);
        } else {
            sweeping.insert(id, Some(Instant::now() + SWEEP_BACKOFF));
        }
        // Forget failures long past, so the map stays small.
        sweeping.retain(|_, until| until.is_none_or(|until| until > Instant::now()));
    }
}
