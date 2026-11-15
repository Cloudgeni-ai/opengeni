//! Registering with the control service and renewing the lease, as
//! [`compute_fleet::HostLease`] decides.
//!
//! One task owns the lease. It sends what is due, each request on a task
//! of its own so a slow answer holds up nothing, and takes the answers in
//! as they come. Every change of the lease is written to the lease file
//! before anything is sent or answered under it, and only then to the
//! gate, so the guard never runs VMs past a deadline the agent no longer
//! holds. A registration's rulings are carried out before the deadline it
//! brings is written: until then the guard keeps the VMs frozen.
//!
//! The renewer runs on a thread of its own, with a runtime of its own:
//! nothing else the agent does, such as a write its threads wait on while
//! the disk or the journal stalls, holds up a renewal or the taking in of
//! its answer.
//!
//! Renewals never wait on the agent: what the host can take on is read
//! from the agent's status on a task of its own, once a second, and each
//! renewal carries the latest reading. An agent busy for seconds, as one
//! whose disk stalls can be, would otherwise hold up the renewals and let
//! the guard freeze every VM on the host.
//!
//! Renewals that go unanswered for two in a row are logged as a warning
//! once, with how long the lease has left and the last error, and the
//! answer that ends the gap is logged with how long it lasted.
//! A reading of the agent's status that takes longer than two renewal
//! intervals is warned of too, and logged with how long it took once the
//! agent answers: renewals meanwhile carry the reading before it.
//! An agent that has not answered one for [`STUCK_AFTER`] is stuck, not
//! busy: the process asks itself to stop, as systemd would, and the agent
//! that systemd starts again takes back the VMs, which run on meanwhile.
//! The lease is renewed all along, as in any restart. A stop that has not
//! ended [`STUCK_AFTER`] later (a stop waits on writes a stuck disk may
//! never finish) ends the process at once, as systemd's stop timeout
//! would. Renewing on for a stuck agent alone would keep every sandbox on
//! the host out of reach without the service ever moving one.
//!
//! It runs from the moment the agent process starts until it exits. A
//! restarted agent takes back what the previous run left before it
//! answers anything, which on a host with many sandboxes can take longer
//! than the lease's term, and a stopping one still has work to finish;
//! while the agent does not serve, the lease held is renewed without a
//! capacity (the service keeps the one it last heard), and a registration,
//! which must list everything the host holds, waits.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::Context as _;
use compute_core::At;
use compute_fleet::{Guard, HostEpoch, HostLease, LeaseTerms, Renewal};
use compute_protocol::fleet::{
    Answered, Boot, Capacity, Held, HostInfo, REGISTER_PATH, RENEW_PATH, REPORT_PATH, ReadyClones,
    Register, Registered, Renew, Renewed, Report, Terms,
};
use compute_protocol::host::HostStatus;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;

use super::Agent;
use super::gate::{LeaseGate, boot_now};
use super::record::LeaseFile;
use crate::agent::HostError;

/// How long an agent that serves may take to answer a reading of its
/// status before it counts as stuck and its process stops to be started
/// again: far longer than a disk stall keeps it busy, and short enough
/// that a stuck agent is started again within a minute or two.
const STUCK_AFTER: Duration = Duration::from_secs(60);

/// A reading of the agent's status, or `None` for one that ended without
/// an answer (its task panicked or was dropped).
type Reading = Option<Result<HostStatus, HostError>>;

/// Sends a reading's answer, or `None` if it ends without one, so a
/// reading never stays under way for good.
struct Answering {
    readings: mpsc::UnboundedSender<Reading>,
    sent: bool,
}

impl Answering {
    fn send(mut self, status: Result<HostStatus, HostError>) {
        self.sent = true;
        let _ = self.readings.send(Some(status));
    }
}

impl Drop for Answering {
    fn drop(&mut self) {
        if !self.sent {
            let _ = self.readings.send(None);
        }
    }
}

/// The service's answer to one request, or why there is none.
enum Answer {
    Registered(Registered),
    Renewed(Renewed),
    Failed(String),
}

/// What the renewer needs.
pub(crate) struct Renewer {
    pub(crate) http: reqwest::Client,
    /// The service's base URL, such as `https://control:8443`.
    pub(crate) control: String,
    pub(crate) lease: HostLease,
    pub(crate) host: Option<u64>,
    pub(crate) file: PathBuf,
    pub(crate) gate: LeaseGate,
    pub(crate) agent: Agent,
    pub(crate) info: HostInfo,
    /// The boot of its machine its cloud took, once telling it ended: a
    /// registration names it, and none is sent before then.
    pub(crate) told: Arc<OnceLock<Option<Boot>>>,
    /// The name the fleet gives the image this host's sandboxes start
    /// from.
    pub(crate) image: String,
    /// The digest of the guest programs the host builds images with.
    pub(crate) guest: Option<String>,
}

/// The renewer's state while it runs.
struct Running {
    renewer: Renewer,
    answers: mpsc::UnboundedSender<(Renewal, Answer)>,
    /// Where readings of the agent's status come back.
    readings: mpsc::UnboundedSender<Reading>,
    /// Since when a reading is under way, if one is.
    reading: Option<At>,
    /// Whether the reading under way was warned of as slow.
    slow: bool,
    /// When the process asked itself to stop for a stuck agent, if it did.
    restart_asked: Option<At>,
    /// What the host can take on, as the agent's latest status said;
    /// renewals carry it while the agent serves.
    capacity: Option<Capacity>,
    /// The registration attempt under way, sent unchanged until answered.
    attempt: Option<Register>,
    /// No registration is sent before this: the service said the previous
    /// one may still run VMs.
    not_before: At,
    /// The capacity last sent.
    reported: Option<Capacity>,
    /// Why the last renewal that failed got no answer.
    last_error: Option<String>,
    /// Since when renewals have gone unanswered, once that was warned of.
    warned: Option<Duration>,
}

impl Renewer {
    /// Renews as [`Self::run`] does, on a thread of its own with a runtime
    /// of its own ([`apart`]).
    pub(crate) async fn run_apart(self) -> anyhow::Result<()> {
        apart("lease", self.run()).await
    }

    /// Renews until the agent stops; fails if the lease file cannot be
    /// written, since then the guard would act on a stale lease, and if the
    /// agent serves but is gone.
    pub(crate) async fn run(self) -> anyhow::Result<()> {
        let _writing = hold_lease_file(&self.file, self.lease.terms().term).await?;
        let (answers, mut answered) = mpsc::unbounded_channel();
        let (readings, mut read) = mpsc::unbounded_channel();
        let mut running = Running {
            renewer: self,
            answers,
            readings,
            reading: None,
            slow: false,
            restart_asked: None,
            capacity: None,
            attempt: None,
            not_before: At::ZERO,
            reported: None,
            last_error: None,
            warned: None,
        };
        let mut report = tokio::time::interval(Duration::from_secs(1));
        report.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let due = running.renewer.lease.due().max(running.not_before);
            let wait = due.saturating_since(boot_now());
            tokio::select! {
                () = tokio::time::sleep(wait) => running.send().await?,
                Some((renewal, answer)) = answered.recv() => running.take(renewal, answer).await?,
                _ = report.tick() => running.read(),
                Some(reading) = read.recv() => running.report(reading)?,
            }
        }
    }
}

impl Running {
    /// Sends the renewal or registration due now.
    async fn send(&mut self) -> anyhow::Result<()> {
        let renewer = &mut self.renewer;
        let handle = renewer.agent.handle();
        let now = boot_now();
        let renewal = renewer.lease.send(now);
        let timeout = renewer.lease.terms().term;
        if let Some(epoch) = renewal.epoch {
            self.unanswered(now);
            // The renewal's number rose: the file says so before it goes.
            self.store()?;
            let renewer = &self.renewer;
            let body = Renew {
                host: renewer.host.unwrap_or_default(),
                epoch: epoch.0,
                seq: renewal.seq,
                capacity: handle.as_ref().and(self.capacity.clone()),
            };
            self.post(RENEW_PATH, &body, timeout, renewal, Answer::Renewed);
            return Ok(());
        }
        let Some(handle) = handle else {
            // What the host holds is known once the agent has taken it
            // back, and a stopping agent leaves registering to the next.
            tracing::debug!("registering only while the agent serves");
            self.attempt = None;
            return Ok(());
        };
        if renewer.lease.attempt_started(renewal) || self.attempt.is_none() {
            // A registration names the machine's boot only once the cloud
            // took it, so that a restart since is seen as one; telling it
            // ends within seconds of the agent starting.
            let Some(boot) = renewer.told.get() else {
                tracing::debug!("registering once the cloud is told of this boot");
                self.attempt = None;
                return Ok(());
            };
            let info = HostInfo {
                boot: boot.clone(),
                ..renewer.info.clone()
            };
            // What the host lists must be all it holds: a create, adopt or
            // change of owner still under way could land after the list
            // and run unruled. None can start now, with no registration
            // held, so the list waits for those under way to end.
            let status = match handle.inventory().await {
                Ok(Ok(status)) => status,
                Ok(Err(unsettled)) => {
                    tracing::info!(unsettled, "registering once requests under way end");
                    self.attempt = None;
                    return Ok(());
                }
                Err(_) => anyhow::bail!("the agent stopped"),
            };
            // A sandbox whose VM the guard holds frozen is listed under the
            // owner epoch its record names: the service rules on it, and
            // the deadline that would thaw it is written only once a drop
            // has ended its VM (see `registered`). Waiting for it to
            // answer instead would wait for good, since only that
            // deadline thaws it.
            let unruled = status
                .blocked
                .iter()
                .filter(|blocked| blocked.frozen_owner_epoch.is_none())
                .count();
            if unruled > 0 {
                // It cannot rule on what it cannot manage: wait until they
                // can be read again, or someone removes them.
                tracing::warn!(
                    blocked = unruled,
                    "not registering while sandboxes are blocked"
                );
                self.attempt = None;
                return Ok(());
            }
            let frozen = status.blocked.iter().filter_map(|blocked| {
                Some(Held {
                    id: blocked.id,
                    owner_epoch: blocked.frozen_owner_epoch?,
                })
            });
            self.attempt = Some(Register {
                host: renewer.host,
                attempt: renewal.attempt,
                info,
                capacity: capacity(
                    &status,
                    &renewer.info,
                    &renewer.image,
                    renewer.guest.as_deref(),
                ),
                held: status
                    .sandboxes
                    .iter()
                    .map(|sandbox| Held {
                        id: sandbox.id,
                        owner_epoch: sandbox.owner_epoch,
                    })
                    .chain(frozen)
                    .collect(),
            });
        }
        let Some(mut body) = self.attempt.clone() else {
            return Ok(());
        };
        body.attempt = renewal.attempt;
        self.post(REGISTER_PATH, &body, timeout, renewal, Answer::Registered);
        Ok(())
    }

    /// Posts `body` on a task of its own; the answer comes back with
    /// `renewal`.
    fn post<B, A>(
        &self,
        path: &str,
        body: &B,
        timeout: Duration,
        renewal: Renewal,
        answer: fn(A) -> Answer,
    ) where
        B: Serialize,
        A: DeserializeOwned + Send + 'static,
    {
        let request = self
            .renewer
            .http
            .post(format!("{}{path}", self.renewer.control))
            .timeout(timeout)
            .json(body);
        let answers = self.answers.clone();
        tokio::spawn(async move {
            let result = async {
                let response = request.send().await?.error_for_status()?;
                response.json::<A>().await
            }
            .await;
            let answered = match result {
                Ok(answered) => answer(answered),
                Err(error) => Answer::Failed(error.to_string()),
            };
            let _ = answers.send((renewal, answered));
        });
    }

    /// Takes in the answer to `renewal`.
    async fn take(&mut self, renewal: Renewal, answer: Answer) -> anyhow::Result<()> {
        match answer {
            Answer::Failed(error) => {
                tracing::debug!(%error, seq = renewal.seq, "no answer from the control service");
                if renewal.epoch.is_some() {
                    self.last_error = Some(error);
                }
            }
            Answer::Renewed(Renewed::Renewed { epoch, seq }) => {
                let same = renewal.epoch == Some(HostEpoch(epoch)) && renewal.seq == seq;
                if same && self.renewer.lease.renewed(renewal) {
                    self.store()?;
                    self.answered(renewal);
                }
            }
            Answer::Renewed(Renewed::Unknown) => {
                tracing::warn!("the control service gave this host up: registering again");
                self.renewer.lease.refused(renewal);
                self.store()?;
            }
            Answer::Registered(Registered::StillLive { retry_after_ms }) => {
                if self.renewer.lease.awaits(renewal) {
                    self.not_before = boot_now() + Duration::from_millis(retry_after_ms);
                }
            }
            Answer::Registered(Registered::Registered {
                host,
                epoch,
                terms,
                rulings,
            }) => {
                self.registered(renewal, host, epoch, terms, rulings)
                    .await?;
            }
        }
        Ok(())
    }

    async fn registered(
        &mut self,
        renewal: Renewal,
        host: u64,
        epoch: u64,
        terms: Terms,
        rulings: Vec<compute_protocol::fleet::Ruling>,
    ) -> anyhow::Result<()> {
        let renewer = &mut self.renewer;
        if !renewer.lease.awaits(renewal) {
            return Ok(());
        }
        let ours = renewer.lease.terms();
        if terms_of(terms) != ours {
            tracing::error!(
                ?terms,
                ?ours,
                "the control service's lease terms differ from this host's guard: not registering"
            );
            return Ok(());
        }
        let count = rulings.len();
        // A registration is sent only while the agent serves; one answered
        // as it stops is left to the next agent.
        let Some(handle) = renewer.agent.handle() else {
            return Ok(());
        };
        // Everything not kept goes first: the deadline that lets the rest
        // run again is written only after.
        if let Err(error) = handle.reconcile(rulings).await {
            tracing::warn!(%error, "could not carry out the control service's rulings yet");
            return Ok(());
        }
        if renewer.lease.registered(renewal, HostEpoch(epoch)) {
            renewer.host = Some(host);
            self.attempt = None;
            self.reported = None;
            self.warned = None;
            self.last_error = None;
            self.store()?;
            tracing::info!(
                host,
                epoch,
                rulings = count,
                "registered with the control service"
            );
        }
        Ok(())
    }

    /// Writes the lease to its file, then lets the listener and the gate
    /// see it.
    fn store(&self) -> anyhow::Result<()> {
        let renewer = &self.renewer;
        let record = renewer.lease.record();
        LeaseFile::of(renewer.host, record)
            .write(&renewer.file)
            .map_err(|error| {
                anyhow::anyhow!("writing the lease file {}: {error}", renewer.file.display())
            })?;
        renewer.gate.hold(
            Answered {
                host_epoch: record.epoch.map(|epoch| epoch.0),
                seq: record.seq,
            },
            record.deadline,
        );
        Ok(())
    }

    /// Warns, once per gap, when renewals sent `now` have gone unanswered
    /// for two in a row: the guard freezes the VMs once the lease is
    /// within [`Guard::LEAD`] of its deadline.
    fn unanswered(&mut self, now: At) {
        let terms = self.renewer.lease.terms();
        let deadline = self.renewer.lease.deadline().since_origin();
        // The last renewal answered was sent a term before the deadline.
        let since = deadline.saturating_sub(terms.term);
        let silent = now.since_origin().saturating_sub(since);
        if self.warned.is_some() || deadline.is_zero() || silent < terms.renew_every * 5 / 2 {
            return;
        }
        self.warned = Some(since);
        let left = deadline.saturating_sub(now.since_origin());
        tracing::warn!(
            unanswered_for_ms = ms(silent),
            lease_left_ms = ms(left),
            freezes_in_ms = ms(left.saturating_sub(Guard::LEAD)),
            last_error = self
                .last_error
                .as_deref()
                .unwrap_or("none yet: no answer arrived"),
            "renewals to the control service go unanswered: this host's VMs freeze if none is answered before the lease runs out"
        );
    }

    /// Notes that the service accepted `renewal`, which moved the deadline;
    /// one that ends a gap warned of is logged.
    fn answered(&mut self, renewal: Renewal) {
        let now = boot_now().since_origin();
        if let Some(since) = self.warned.take() {
            tracing::info!(
                unanswered_for_ms = ms(now.saturating_sub(since)),
                round_trip_ms = ms(now.saturating_sub(renewal.sent.since_origin())),
                last_error = self
                    .last_error
                    .as_deref()
                    .unwrap_or("none: answers were late"),
                "the control service answers renewals again"
            );
        }
        self.last_error = None;
    }

    /// Asks the agent for its status on a task of its own, unless a
    /// reading is under way (warned of once it takes long) or the agent
    /// does not serve. Once a reading of an agent that serves has been
    /// under way for [`STUCK_AFTER`], asks the process to stop, for systemd
    /// to start it again.
    fn read(&mut self) {
        let now = boot_now();
        // Asked to stop, the process has not in a minute: nothing else would
        // end it, since systemd did not ask. Whether the stuck reading has
        // answered since does not matter; the stop is what hangs.
        if let Some(asked) = self.restart_asked {
            let stopping = now.since_origin().saturating_sub(asked.since_origin());
            if stopping > STUCK_AFTER {
                tracing::error!(
                    waited_ms = ms(stopping),
                    "the stuck agent's process has not stopped in a minute: it ends now, for systemd to start it again"
                );
                std::process::exit(1);
            }
        }
        if let Some(since) = self.reading {
            let taken = now.since_origin().saturating_sub(since.since_origin());
            if taken > STUCK_AFTER
                && self.restart_asked.is_none()
                && self.renewer.agent.handle().is_some()
            {
                self.restart_asked = Some(now);
                tracing::error!(
                    waited_ms = ms(taken),
                    "the agent has not said what the host can take on for a minute: it is stuck, so its process stops for systemd to start it again; the VMs run on and the lease is renewed meanwhile"
                );
                if let Err(error) = rustix::process::kill_process(
                    rustix::process::getpid(),
                    rustix::process::Signal::TERM,
                ) {
                    tracing::error!(%error, "the agent's process could not ask itself to stop");
                }
            }
            if !self.slow && taken > self.renewer.lease.terms().renew_every * 2 {
                self.slow = true;
                tracing::warn!(
                    waited_ms = ms(taken),
                    "the agent is slow to say what the host can take on: renewals go on carrying what it said before"
                );
            }
            return;
        }
        let Some(handle) = self.renewer.agent.handle() else {
            self.capacity = None;
            return;
        };
        self.reading = Some(now);
        let answering = Answering {
            readings: self.readings.clone(),
            sent: false,
        };
        tokio::spawn(async move {
            answering.send(handle.status().await);
        });
    }

    /// Takes in a reading of the agent's status, for the next renewals,
    /// and sends the service what the host can take on when it changed
    /// since last sent. Fails if the agent serves but no longer answers.
    fn report(&mut self, reading: Reading) -> anyhow::Result<()> {
        if let Some(since) = self.reading.take()
            && std::mem::take(&mut self.slow)
        {
            let taken = boot_now()
                .since_origin()
                .saturating_sub(since.since_origin());
            tracing::info!(took_ms = ms(taken), "the agent answers again");
        }
        // A reading that ended without an answer: the next tick reads again.
        let Some(reading) = reading else {
            return Ok(());
        };
        let renewer = &self.renewer;
        if renewer.agent.handle().is_none() {
            self.capacity = None;
            return Ok(());
        }
        let Ok(status) = reading else {
            anyhow::bail!("the agent stopped");
        };
        let capacity = capacity(
            &status,
            &renewer.info,
            &renewer.image,
            renewer.guest.as_deref(),
        );
        self.capacity = Some(capacity.clone());
        let (Some(host), Some(epoch)) = (renewer.host, renewer.lease.epoch()) else {
            return Ok(());
        };
        if self.reported.as_ref() == Some(&capacity) {
            return Ok(());
        }
        self.reported = Some(capacity.clone());
        let request = renewer
            .http
            .post(format!("{}{REPORT_PATH}", renewer.control))
            .timeout(Duration::from_secs(5))
            .json(&Report {
                host,
                epoch: epoch.0,
                capacity,
            });
        tokio::spawn(async move {
            if let Err(error) = request
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            {
                tracing::debug!(%error, "reporting capacity failed");
            }
        });
        Ok(())
    }
}

/// Takes the lock beside the lease file `file`, which lets one renewer at a
/// time write it, waiting up to `wait` for one still letting go: a renewer
/// whose future was dropped ends on its own thread at that thread's next
/// turn, and may write the file once more meanwhile. Both writing through
/// the one staging name, the later rename would fail; the earlier
/// renewer's last record could also land after the next one's. Held for
/// as long as the file is open.
async fn hold_lease_file(file: &Path, wait: Duration) -> anyhow::Result<std::fs::File> {
    use rustix::fs::{FlockOperation, flock};

    let path = file.with_extension("lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match flock(&lock, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => return Ok(lock),
            Err(rustix::io::Errno::WOULDBLOCK) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(rustix::io::Errno::WOULDBLOCK) => {
                anyhow::bail!(
                    "another renewer still writes the lease file, {}",
                    path.display()
                )
            }
            Err(error) => {
                return Err(std::io::Error::from(error))
                    .with_context(|| format!("locking {}", path.display()));
            }
        }
    }
}

/// Runs `work` to its end on a thread named `name` with a runtime of its
/// own, so that nothing the caller's runtime runs holds it up, until it
/// ends or the future returned is dropped, which drops `work` too.
pub(crate) async fn apart(
    name: &str,
    work: impl Future<Output = anyhow::Result<()>> + Send + 'static,
) -> anyhow::Result<()> {
    let (ended, end) = tokio::sync::oneshot::channel();
    // Dropped with the future returned, which ends the work.
    let (_stop, stopped) = tokio::sync::oneshot::channel::<()>();
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(anyhow::Error::from)
                .and_then(|runtime| {
                    runtime.block_on(async move {
                        tokio::select! {
                            result = work => result,
                            _ = stopped => Ok(()),
                        }
                    })
                });
            let _ = ended.send(result);
        })?;
    end.await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("the {name} thread ended")))
}

/// Whole milliseconds, for logs.
fn ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// When this run of the agent started, in milliseconds since the Unix
/// epoch: read once, the first time the agent says what it can take on.
fn run() -> u64 {
    static STARTED: OnceLock<u64> = OnceLock::new();
    *STARTED.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, ms)
    })
}

/// What the host can take on, from its status and configured image and
/// guest programs. The host description is refreshed when the agent starts.
fn capacity(status: &HostStatus, info: &HostInfo, image: &str, guest: Option<&str>) -> Capacity {
    let mib = |bytes: u64| bytes >> 20;
    Capacity {
        memory_free_mib: status.capacity.as_ref().map_or(0, |held| mib(held.free)),
        memory_reclaimable_mib: status
            .capacity
            .as_ref()
            .map_or(0, |_| mib(status.reclaimable_memory)),
        cpu_millis: status.cpu.as_ref().map_or(0, |cpu| cpu.total),
        cpu_free_millis: status.cpu.as_ref().map_or(0, |cpu| cpu.free),
        disk_free_mib: status.disk.as_ref().map_or(0, |disk| mib(disk.free)),
        disk_available_mib: status.disk.as_ref().map(|disk| mib(disk.available)),
        disk_reclaimable_mib: status.disk.as_ref().map_or(0, |disk| mib(disk.reclaimable)),
        ready: status
            .templates
            .iter()
            .filter(|template| template.ready > 0)
            .map(|template| ReadyClones {
                image: image.to_owned(),
                vcpus: u32::from(template.vcpus),
                memory_mib: template.memory_mib,
                count: template.ready,
            })
            .collect(),
        awake: status.capacity.as_ref().map_or(0, |held| held.awake),
        sandboxes: u32::try_from(status.sandboxes.len()).unwrap_or(u32::MAX),
        guest: guest.map(str::to_owned),
        // A host of this release keeps its pointers in the service.
        pointers_in_service: true,
        // And it reads copies whose chunks are in packs (ADR 31).
        reads_packs: true,
        // And it sets aside a copy the service will not let it keep but
        // that may be newer than any other.
        sets_aside: true,
        // Which run of the agent this is: the service counts a later one
        // as the agent starting again.
        run: Some(run()),
        // Whether the run before it was asked to stop: the service counts
        // only the restarts that were not asked for.
        after_asked_stop: super::stopped::after_asked_stop(),
        // What it is configured with now, which a restart in place may
        // have changed under the registration it kept.
        info: Some(info.clone()),
    }
}

/// Lease terms as the service sends them.
#[must_use]
pub fn terms_of(terms: Terms) -> LeaseTerms {
    let ms = Duration::from_millis;
    LeaseTerms {
        term: ms(terms.term_ms),
        margin: ms(terms.margin_ms),
        renew_every: ms(terms.renew_every_ms),
        register_every: ms(terms.register_every_ms),
        request_window: terms.request_window,
        watchdog: ms(terms.watchdog_ms),
        stop: ms(terms.stop_ms),
        rate_error_ppm: terms.rate_error_ppm,
    }
}

/// Lease terms as the service sends them to hosts.
#[must_use]
pub fn wire_terms(terms: LeaseTerms) -> Terms {
    let ms = |duration: Duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
    Terms {
        term_ms: ms(terms.term),
        margin_ms: ms(terms.margin),
        renew_every_ms: ms(terms.renew_every),
        register_every_ms: ms(terms.register_every),
        request_window: terms.request_window,
        watchdog_ms: ms(terms.watchdog),
        stop_ms: ms(terms.stop),
        rate_error_ppm: terms.rate_error_ppm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_disk_readings_are_not_booking_headroom() {
        use compute_protocol::host::{About, DiskStatus};
        let info: HostInfo = serde_json::from_str(r#"{"name":"h","address":"h:1","zone":"z","profile":"nested","cpu_template":"","memory_mib":1000,"cpu_millis":1000,"disk_mib":100000}"#).unwrap();
        let mut status = HostStatus {
            sandboxes: Vec::new(),
            steps: Vec::new(),
            available_memory: None,
            reclaimable_memory: 0,
            blocked: Vec::new(),
            capacity: None,
            cpu: None,
            disk: None,
            templates: Vec::new(),
            store_stalled_ms: None,
            unseen_activity: 0,
            about: About::default(),
        };
        assert_eq!(
            capacity(&status, &info, "image", None).disk_available_mib,
            None
        );
        for available_mib in [0, 95_000] {
            status.disk = Some(DiskStatus {
                available: available_mib << 20,
                booked: 90_000 << 20,
                reserve: 1000 << 20,
                free: 1 << 20,
                reclaimable: 2000 << 20,
                inodes_available: 10,
                inodes_booked: 5,
                inodes_free: 5,
            });
            let capacity = capacity(&status, &info, "image", None);
            assert_eq!(capacity.disk_available_mib, Some(available_mib));
            assert_eq!(capacity.disk_free_mib, 1);
            assert_eq!(capacity.disk_reclaimable_mib, 2000);
        }
        // Every reading names the same run of the agent, so the service
        // counts this run once.
        let run = capacity(&status, &info, "image", None).run;
        assert!(run.is_some_and(|started| started > 0));
        assert_eq!(capacity(&status, &info, "image", None).run, run);
    }

    #[test]
    fn terms_survive_the_wire() {
        let terms = LeaseTerms::RECOMMENDED;
        assert_eq!(terms_of(wire_terms(terms)), terms);
    }

    /// Work run apart goes on while every thread of the caller's runtime
    /// is held up, as an agent's are by writes to a stalled journal or
    /// disk; on the caller's runtime it would not run at all meanwhile.
    #[tokio::test(flavor = "current_thread")]
    async fn work_run_apart_goes_on_while_the_callers_runtime_is_held_up() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let ticks = Arc::new(AtomicU32::new(0));
        let counting = Arc::clone(&ticks);
        let running = tokio::spawn(apart("ticking", async move {
            loop {
                counting.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }));
        // Let it start, then hold up this runtime's only thread.
        while ticks.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let before = ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
        let during = ticks.load(Ordering::SeqCst) - before;
        assert!(during >= 10, "ticked {during} times while held up");
        // Dropped, it ends.
        running.abort();
        let _ = running.await;
        let stopped = ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert!(ticks.load(Ordering::SeqCst) <= stopped + 1, "it ended");
    }

    /// One renewer at a time writes the lease file: the next waits for the
    /// one before to let go, and says so when it never does.
    #[tokio::test]
    async fn one_renewer_at_a_time_holds_the_lease_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lease");
        let first = hold_lease_file(&file, Duration::ZERO).await.unwrap();
        let refused = hold_lease_file(&file, Duration::from_millis(50)).await;
        assert!(
            refused
                .unwrap_err()
                .to_string()
                .contains("another renewer still writes"),
        );
        let waiting = tokio::spawn({
            let file = file.clone();
            async move { hold_lease_file(&file, Duration::from_secs(10)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "it waits while the first holds it");
        drop(first);
        waiting.await.unwrap().unwrap();
    }

    /// Work run apart that fails fails the caller.
    #[tokio::test]
    async fn work_run_apart_says_how_it_ended() {
        let failed = apart("failing", async { anyhow::bail!("broken") }).await;
        assert_eq!(failed.unwrap_err().to_string(), "broken");
        apart("ending", async { Ok(()) }).await.unwrap();
    }

    /// A reading whose task ends without an answer still says so, so the
    /// renewer reads again instead of waiting on it for good.
    #[test]
    fn a_reading_that_ends_unanswered_says_so() {
        let (readings, mut read) = mpsc::unbounded_channel();
        drop(Answering {
            readings: readings.clone(),
            sent: false,
        });
        assert!(matches!(read.try_recv(), Ok(None)));
        Answering {
            readings,
            sent: false,
        }
        .send(Err(HostError::Stopped));
        assert!(matches!(read.try_recv(), Ok(Some(Err(_)))));
        assert!(read.try_recv().is_err(), "one answer each");
    }
}
