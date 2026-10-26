//! A pool: the scale set's runners, each in its own sandbox, scaled to the
//! jobs GitHub assigns it and reconciled with what compute and GitHub
//! hold, which is all the state there is.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::compute::{Compute, NewSandbox};
use crate::github::wire::{Message, Session};
use crate::github::{Github, Polled, Removed, SessionError};

/// The metadata keys a runner's sandbox carries.
pub const POOL_KEY: &str = "runner-pool";
pub const NAME_KEY: &str = "runner-name";
pub const ID_KEY: &str = "runner-id";
pub const BORN_KEY: &str = "runner-born";
/// The variable the runner reads its just-in-time configuration from.
pub const JIT_ENV: &str = "ACTIONS_RUNNER_INPUT_JITCONFIG";

/// How often the pool is reconciled with compute and GitHub.
const RECONCILE_EVERY: Duration = Duration::from_secs(30);
/// How long a runner is left alone after its start before a check that
/// finds it missing somewhere ends it.
const SETTLE: Duration = Duration::from_secs(60);
/// How long a standby waits before asking for the session again.
pub const STANDBY_EVERY: Duration = Duration::from_secs(30);

/// How a pool runs.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The scale set's name, and the pool's.
    pub name: String,
    /// Idle runners kept beyond the jobs assigned.
    pub min_idle: u32,
    /// The most runners at once.
    pub max: u32,
    /// The longest a runner's sandbox lives, in seconds.
    pub timeout_s: u64,
    /// More environment for every runner (a cache's address, say).
    pub env: BTreeMap<String, String>,
    /// How long a standby waits before asking for the session again
    /// ([`STANDBY_EVERY`]).
    pub standby: Duration,
}

/// One runner, as the pool knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Runner {
    sandbox: String,
    id: u64,
    /// Seconds since the epoch it was started at.
    born: u64,
    busy: bool,
}

/// The pool.
#[derive(Debug)]
pub struct Pool {
    github: Arc<Github>,
    compute: Compute,
    set: u64,
    settings: Settings,
    /// The template new runners start from.
    template: watch::Receiver<String>,
    runners: BTreeMap<String, Runner>,
    /// The jobs GitHub has assigned the scale set, as it last said.
    assigned: u32,
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

impl Pool {
    #[must_use]
    pub fn new(
        github: Arc<Github>,
        compute: Compute,
        set: u64,
        settings: Settings,
        template: watch::Receiver<String>,
    ) -> Self {
        Self {
            github,
            compute,
            set,
            settings,
            template,
            runners: BTreeMap::new(),
            assigned: 0,
        }
    }

    /// How many runners the pool wants.
    fn target(&self) -> usize {
        let wanted = self.assigned.saturating_add(self.settings.min_idle);
        usize::try_from(wanted.min(self.settings.max)).unwrap_or(usize::MAX)
    }

    /// Handles a message: jobs started and completed, then the scale.
    pub async fn handle(&mut self, message: &Message) {
        for started in message.of("JobStarted") {
            if let Some(runner) = started
                .runner_name
                .as_ref()
                .and_then(|name| self.runners.get_mut(name))
            {
                runner.busy = true;
            }
        }
        for completed in message.of("JobCompleted") {
            if let Some(name) = &completed.runner_name {
                tracing::info!(
                    runner = %name,
                    result = completed.result.as_deref().unwrap_or("?"),
                    job = completed.job_display_name.as_deref().unwrap_or("?"),
                    "a job ended; its sandbox goes"
                );
                self.end(name).await;
            }
        }
        if let Some(statistics) = message.statistics {
            self.assigned = statistics.total_assigned_jobs;
        }
        self.scale().await;
    }

    /// Starts or removes runners until the pool has as many as it wants;
    /// the runners missing start at once, side by side.
    pub async fn scale(&mut self) {
        let target = self.target();
        let missing = target.saturating_sub(self.runners.len());
        if missing > 0 {
            let started = futures::future::join_all((0..missing).map(|_| self.start())).await;
            for result in started {
                match result {
                    Ok((name, runner)) => {
                        self.runners.insert(name, runner);
                    }
                    Err(error) => {
                        tracing::warn!(
                            error = format!("{error:#}"),
                            "starting a runner failed; the next scale tries again"
                        );
                    }
                }
            }
        }
        let settled = now_s().saturating_sub(SETTLE.as_secs());
        let idle: Vec<(String, u64)> = self
            .runners
            .iter()
            .filter(|(_, runner)| !runner.busy && runner.born <= settled)
            .map(|(name, runner)| (name.clone(), runner.id))
            .collect();
        for (name, id) in idle {
            if self.runners.len() <= target {
                break;
            }
            match self.github.remove_runner(id).await {
                Ok(Removed::Removed | Removed::Gone) => {
                    tracing::info!(runner = %name, "an unneeded runner goes");
                    self.end(&name).await;
                }
                Ok(Removed::Busy) => {
                    if let Some(runner) = self.runners.get_mut(&name) {
                        runner.busy = true;
                    }
                }
                Err(error) => {
                    tracing::warn!(runner = %name, error = format!("{error:#}"), "removing a runner failed");
                }
            }
        }
    }

    /// Registers a runner and starts its sandbox.
    async fn start(&self) -> Result<(String, Runner)> {
        let mut suffix = [0u8; 6];
        getrandom::fill(&mut suffix)?;
        let name = suffix
            .iter()
            .fold(self.settings.name.clone() + "-", |mut name, byte| {
                let _ = write!(name, "{byte:02x}");
                name
            });
        let jit = self.github.jit_config(self.set, &name).await?;
        let born = now_s();
        let mut env = self.settings.env.clone();
        env.insert(JIT_ENV.into(), jit.encoded_jit_config);
        let new = NewSandbox {
            template: self.template.borrow().clone(),
            timeout_s: self.settings.timeout_s,
            metadata: BTreeMap::from([
                (POOL_KEY.into(), self.settings.name.clone()),
                (NAME_KEY.into(), name.clone()),
                (ID_KEY.into(), jit.runner.id.to_string()),
                (BORN_KEY.into(), born.to_string()),
            ]),
            env,
        };
        let sandbox = match self.compute.create(&new).await {
            Ok(created) => created.id,
            Err(error) => {
                if let Err(removing) = self.github.remove_runner(jit.runner.id).await {
                    tracing::warn!(runner = %name, error = format!("{removing:#}"), "removing a runner whose sandbox failed");
                }
                return Err(error);
            }
        };
        tracing::info!(runner = %name, %sandbox, template = %new.template, "a runner starts");
        Ok((
            name,
            Runner {
                sandbox,
                id: jit.runner.id,
                born,
                busy: false,
            },
        ))
    }

    /// Ends runner `name`'s sandbox and forgets it.
    async fn end(&mut self, name: &str) {
        let Some(runner) = self.runners.get(name) else {
            return;
        };
        match self.compute.kill(&runner.sandbox).await {
            Ok(()) => {
                self.runners.remove(name);
            }
            Err(error) => {
                tracing::warn!(runner = %name, error = format!("{error:#}"), "killing a runner's sandbox failed; the next check tries again");
            }
        }
    }

    /// Reads back what runs, ends what is no longer needed, and scales.
    pub async fn reconcile(&mut self) -> Result<()> {
        let listed = self
            .compute
            .list(&[(POOL_KEY, &self.settings.name)])
            .await?;
        let mut seen = BTreeSet::new();
        for sandbox in &listed {
            let name = sandbox.metadata.get(NAME_KEY);
            let id = sandbox.metadata.get(ID_KEY).and_then(|id| id.parse().ok());
            let (Some(name), Some(id)) = (name, id) else {
                tracing::warn!(sandbox = %sandbox.id, "a pool sandbox names no runner; it goes");
                self.compute.kill(&sandbox.id).await?;
                continue;
            };
            seen.insert(sandbox.id.clone());
            match self.runners.get(name) {
                Some(known) if known.sandbox == sandbox.id => {}
                Some(_) => {
                    tracing::warn!(sandbox = %sandbox.id, runner = %name, "a second sandbox for one runner; it goes");
                    self.compute.kill(&sandbox.id).await?;
                }
                None => {
                    let born = sandbox
                        .metadata
                        .get(BORN_KEY)
                        .and_then(|born| born.parse().ok())
                        .unwrap_or(0);
                    tracing::info!(runner = %name, sandbox = %sandbox.id, "a running runner is taken on");
                    self.runners.insert(
                        name.clone(),
                        Runner {
                            sandbox: sandbox.id.clone(),
                            id,
                            born,
                            busy: false,
                        },
                    );
                }
            }
        }
        let settled = now_s().saturating_sub(SETTLE.as_secs());
        let known: Vec<(String, Runner)> = self
            .runners
            .iter()
            .map(|(name, runner)| (name.clone(), runner.clone()))
            .collect();
        for (name, runner) in known {
            if runner.born > settled {
                continue;
            }
            if !seen.contains(&runner.sandbox) {
                tracing::info!(runner = %name, sandbox = %runner.sandbox, "a runner's sandbox is gone; so goes its registration");
                if !matches!(self.github.remove_runner(runner.id).await?, Removed::Busy) {
                    self.runners.remove(&name);
                }
                continue;
            }
            if self.github.runner(&name).await?.is_none() {
                tracing::info!(runner = %name, "GitHub no longer has a runner; its sandbox goes");
                self.end(&name).await;
            }
        }
        self.scale().await;
        Ok(())
    }
}

/// Listens to the scale set and keeps the pool, until `stop` is cancelled.
/// A standby while another listener holds the session; `leading` says
/// whether this one holds it, for the work only one replica does.
pub async fn listen(
    mut pool: Pool,
    owner: &str,
    leading: &watch::Sender<bool>,
    stop: &CancellationToken,
) -> Result<()> {
    let set = pool.set;
    let github = Arc::clone(&pool.github);
    loop {
        let mut session = match github.open_session(set, owner).await {
            Ok(session) => session,
            Err(SessionError::Taken) => {
                tracing::info!("another listener holds the scale set; standing by");
                if wait_or_stop(stop, pool.settings.standby).await {
                    return Ok(());
                }
                continue;
            }
            Err(SessionError::Other(error)) => {
                tracing::warn!(
                    error = format!("{error:#}"),
                    "opening the message session failed"
                );
                if wait_or_stop(stop, Duration::from_secs(10)).await {
                    return Ok(());
                }
                continue;
            }
        };
        tracing::info!(session = %session.session_id, "listening");
        leading.send_replace(true);
        pool.assigned = session.statistics.unwrap_or_default().total_assigned_jobs;
        let stopped = pool.hold(&mut session, stop).await;
        leading.send_replace(false);
        if let Err(error) = github.close_session(set, &session).await {
            tracing::warn!(
                error = format!("{error:#}"),
                "closing the message session failed"
            );
        }
        if stopped {
            return Ok(());
        }
        if wait_or_stop(stop, Duration::from_secs(5)).await {
            return Ok(());
        }
    }
}

impl Pool {
    /// Polls the session and handles its messages until `stop` (then
    /// true) or until the session is lost (false).
    async fn hold(&mut self, session: &mut Session, stop: &CancellationToken) -> bool {
        let github = Arc::clone(&self.github);
        let mut reconciled: Option<Instant> = None;
        let mut last: Option<u64> = None;
        let mut failures = 0u32;
        loop {
            if reconciled.is_none_or(|at| at.elapsed() >= RECONCILE_EVERY) {
                if let Err(error) = self.reconcile().await {
                    tracing::warn!(error = format!("{error:#}"), "reconciling the pool failed");
                }
                reconciled = Some(Instant::now());
            }
            let polled = tokio::select! {
                polled = github.poll(session, last, self.settings.max) => polled,
                () = stop.cancelled() => return true,
            };
            let message = match polled {
                Ok(Some(Polled::Nothing)) => {
                    failures = 0;
                    continue;
                }
                Ok(Some(Polled::Message(message))) => message,
                Ok(None) => match github.refresh_session(self.set, session).await {
                    Ok(fresh) => {
                        *session = fresh;
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!(
                            error = format!("{error:#}"),
                            "refreshing the session failed"
                        );
                        return false;
                    }
                },
                Err(error) => {
                    failures += 1;
                    tracing::warn!(
                        error = format!("{error:#}"),
                        failures,
                        "polling for messages failed"
                    );
                    if failures >= 5 {
                        return false;
                    }
                    if wait_or_stop(stop, Duration::from_secs(5)).await {
                        return true;
                    }
                    continue;
                }
            };
            failures = 0;
            self.take(session, &message).await;
            last = Some(message.id);
        }
    }

    /// Acquires the jobs `message` offers, handles it, and deletes it.
    async fn take(&mut self, session: &mut Session, message: &Message) {
        let github = Arc::clone(&self.github);
        let offered = message.available();
        if !offered.is_empty() {
            match github.acquire(self.set, session, &offered).await {
                Ok(Some(acquired)) => {
                    tracing::info!(
                        offered = offered.len(),
                        acquired = acquired.len(),
                        "jobs acquired"
                    );
                }
                Ok(None) => {
                    tracing::info!(
                        "the session's token expired while acquiring; GitHub offers the jobs again"
                    );
                }
                Err(error) => {
                    tracing::warn!(error = format!("{error:#}"), "acquiring jobs failed");
                }
            }
        }
        self.handle(message).await;
        match github.delete_message(session, message.id).await {
            Ok(true) => {}
            Ok(false) => {
                if let Ok(fresh) = github.refresh_session(self.set, session).await {
                    *session = fresh;
                    let _ = github.delete_message(session, message.id).await;
                }
            }
            Err(error) => {
                tracing::warn!(error = format!("{error:#}"), "deleting a message failed");
            }
        }
    }
}

/// Waits `period`, or less if `stop` is notified: then true.
async fn wait_or_stop(stop: &CancellationToken, period: Duration) -> bool {
    tokio::select! {
        () = tokio::time::sleep(period) => false,
        () = stop.cancelled() => true,
    }
}
