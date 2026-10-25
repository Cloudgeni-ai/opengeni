//! Talking to the agent: handles, leases and the requests they send.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use compute_core::{HoldId, Level, OpId, Priority, Step};
use compute_engine::vsock;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep};

use compute_protocol::fleet::Ruling;

use super::{Command, Handle, HostError, Lease, Origin, ReleaseOnDrop};
use crate::fleet::{Admission, LeaseGate};
use crate::observe::{Observer, TraceContext};
use crate::protocol::{HostStatus, Id, SandboxConfig};
use crate::store::OwnerEpoch;

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.commands.send(Command::Release {
                id: self.id,
                hold: self.hold,
            });
        }
    }
}

impl Handle {
    pub(super) fn new(
        commands: mpsc::UnboundedSender<Command>,
        stream_idle: Duration,
        lease: Option<LeaseGate>,
        observer: Observer,
        preparer: Option<Arc<crate::rootfs::Preparer>>,
    ) -> Self {
        Self {
            commands,
            holds: Arc::new(AtomicU64::new(1)),
            stream_idle,
            origin: Origin::Local,
            lease,
            observer,
            trace: None,
            preparer,
        }
    }

    async fn ask<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        let command = match self.origin {
            Origin::Fleet(owner, admission) => Command::Owned {
                owner,
                admission,
                command: Box::new(make(reply)),
            },
            Origin::Local | Origin::LocalToFleet => make(reply),
        };
        // The host's own tools on a host in a fleet get only its status
        // while its lease has run out: anything else could start a VM the
        // guard keeps frozen.
        if self.origin == Origin::LocalToFleet
            && self.lease.as_ref().is_some_and(|lease| !lease.is_open())
            && !matches!(command, Command::Status { .. } | Command::Release { .. })
        {
            command.refuse(HostError::LeaseLapsed);
            return answer.await.map_err(|_| HostError::Stopped);
        }
        self.send(command)?;
        answer.await.map_err(|_| HostError::Stopped)
    }

    /// Sends `command`, carrying the handle's trace if it has one.
    fn send(&self, command: Command) -> Result<(), HostError> {
        let command = match self.trace {
            Some(trace) => Command::Traced(trace, Box::new(command)),
            None => command,
        };
        self.commands.send(command).map_err(|_| HostError::Stopped)
    }

    /// A handle for the control service's requests about the ownership of a
    /// sandbox under `owner`: the agent carries each out only while this
    /// host holds that ownership (see [`crate::protocol::Request::Adopt`]).
    #[must_use]
    pub fn owned(&self, owner: OwnerEpoch) -> Self {
        Self {
            origin: Origin::Fleet(owner, None),
            ..self.clone()
        }
    }

    /// Like [`Handle::owned`], for a request the fleet listener admitted
    /// under `admission`: the agent carries it out only while the lease
    /// would still admit it ([`LeaseGate::admits`]).
    #[must_use]
    pub fn admitted(&self, owner: OwnerEpoch, admission: Admission) -> Self {
        Self {
            origin: Origin::Fleet(owner, Some(admission)),
            ..self.clone()
        }
    }

    /// What the host holds, for the renewer's registration. `Err` counts
    /// the creates, adopts and changes of owner still under way.
    pub async fn inventory(&self) -> Result<Result<HostStatus, usize>, HostError> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Inventory { reply })
            .map_err(|_| HostError::Stopped)?;
        answer.await.map_err(|_| HostError::Stopped)
    }

    /// A handle for the host's own tools on a host in a fleet, which
    /// create, adopt and hand off nothing: only the control service knows
    /// which sandboxes a fleet has, and where.
    #[must_use]
    pub fn local_to_fleet(&self) -> Self {
        Self {
            origin: Origin::LocalToFleet,
            ..self.clone()
        }
    }

    /// Refuses what only the control service asks of a host in a fleet.
    fn fleet_only(&self, what: &str) -> Result<(), HostError> {
        if self.origin == Origin::LocalToFleet {
            return Err(HostError::Invalid(format!(
                "this host is in a fleet: only the control service may {what} sandboxes"
            )));
        }
        Ok(())
    }

    /// Creates a sandbox. It costs only disk until first needed.
    pub async fn create(&self, id: Id, config: SandboxConfig) -> Result<(), HostError> {
        self.fleet_only("create")?;
        let owner = match self.origin {
            Origin::Fleet(owner, _) => owner,
            Origin::Local | Origin::LocalToFleet => OwnerEpoch::FIRST,
        };
        self.ask(|reply| Command::Create {
            id,
            config,
            owner,
            reply,
        })
        .await?
    }

    /// Takes a sandbox over from the store's latest copy as its owner under
    /// `owner`, from its files alone with `from_files`; see
    /// [`crate::protocol::Request::Adopt`].
    pub async fn adopt(
        &self,
        id: Id,
        config: SandboxConfig,
        owner: OwnerEpoch,
        from_files: bool,
    ) -> Result<(), HostError> {
        self.fleet_only("adopt")?;
        self.send_naming_owner(|reply| Command::Adopt {
            id,
            config,
            owner,
            from_files,
            reply,
        })
        .await?
    }

    /// Hands a sandbox held under `owner` off, even while it is awake with
    /// `awake`, and returns once this host no longer has it; see
    /// [`crate::protocol::Request::HandOff`].
    pub async fn hand_off(&self, id: Id, owner: OwnerEpoch, awake: bool) -> Result<(), HostError> {
        self.fleet_only("hand off")?;
        self.send_naming_owner(|reply| Command::HandOff {
            id,
            owner,
            awake,
            reply,
        })
        .await?
    }

    /// Takes in the control service's rulings on the sandboxes the host
    /// listed when it registered, and returns once every sandbox the
    /// rulings do not keep is gone (see [`compute_protocol::fleet::Registered`]).
    /// The renewer sends these itself, under the registration they answer,
    /// so they carry no admission.
    pub async fn reconcile(&self, rulings: Vec<Ruling>) -> Result<(), HostError> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::Reconcile { rulings, reply })?;
        answer.await.map_err(|_| HostError::Stopped)?
    }

    /// Sends a request that names its owner epoch itself. One the fleet
    /// listener admitted still carries its admission, and the agent carries
    /// it out only while the lease would still admit it, as for every other
    /// request the listener admits ([`Handle::admitted`]): an adopt or
    /// hand-off that waited past a renewal window, or across a new
    /// registration, does nothing.
    async fn send_naming_owner<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        let command = match self.origin {
            Origin::Fleet(owner, Some(admission)) => Command::Owned {
                owner,
                admission: Some(admission),
                command: Box::new(make(reply)),
            },
            Origin::Fleet(_, None) | Origin::Local | Origin::LocalToFleet => make(reply),
        };
        self.send(command)?;
        answer.await.map_err(|_| HostError::Stopped)
    }

    /// The same handle, its requests carrying `trace`: the steps they
    /// cause name the caller's trace on their events.
    #[must_use]
    pub fn traced(&self, trace: Option<TraceContext>) -> Self {
        Self {
            trace,
            ..self.clone()
        }
    }

    /// Where the host's events and metrics go.
    #[must_use]
    pub fn observer(&self) -> &Observer {
        &self.observer
    }

    /// How the sandbox image of the OCI image `image` stands on this host,
    /// starting its build if nothing has (see
    /// [`crate::protocol::Request::Prepare`]).
    pub fn prepare(
        &self,
        image: &str,
    ) -> Result<crate::rootfs::Progress, crate::rootfs::PrepareError> {
        match &self.preparer {
            Some(preparer) => preparer.prepare(image),
            None => Err(crate::rootfs::PrepareError::Unavailable(
                "it has no guest programs to build with, or no store to keep images in",
            )),
        }
    }

    /// Deletes a sandbox and everything it stores, waiting until it is gone.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn remove(&self, id: Id, generation: Option<u64>) -> Result<(), HostError> {
        self.fleet_only("remove")?;
        self.ask(|reply| Command::Remove {
            id,
            generation,
            reply,
        })
        .await?
    }

    /// Starts waking a sandbox without waiting, for example when a turn
    /// starts and a command will probably follow. With a `generation`,
    /// only while the sandbox is still at it. Returns once the request is
    /// accepted, not once the sandbox runs.
    pub async fn touch(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Touch {
            id,
            generation,
            priority,
            by: super::observe::By::Fleet,
            reply: Some(reply),
        })
        .await?
    }

    /// How long a stream may stay silent and still keep its sandbox awake
    /// (see [`super::HostConfig::stream_idle`]).
    #[must_use]
    pub fn stream_idle(&self) -> Duration {
        self.stream_idle
    }

    /// Wakes a sandbox and keeps it awake until the lease is dropped.
    /// Dropping the returned future early releases the sandbox too. With a
    /// `generation`, only while the sandbox is still at it, so a caller
    /// that relies on programs it started can tell they are gone.
    pub async fn acquire(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<Lease, HostError> {
        let hold = HoldId(self.holds.fetch_add(1, Ordering::Relaxed));
        let started = Instant::now();
        let mut guard = ReleaseOnDrop {
            id,
            hold,
            commands: self.commands.clone(),
            armed: true,
        };
        let woke = self
            .ask(|reply| Command::Acquire {
                id,
                generation,
                hold,
                priority,
                reply,
            })
            .await??;
        guard.armed = false;
        Ok(Lease {
            id,
            hold,
            vsock: woke.vsock,
            waited: started.elapsed(),
            during: woke.during,
            op: woke.op,
            generation: woke.generation,
            pinned: generation.is_some(),
            commands: self.commands.clone(),
        })
    }

    /// Every sandbox and the host's counters.
    pub async fn status(&self) -> Result<HostStatus, HostError> {
        self.ask(|reply| Command::Status { reply }).await
    }

    /// Puts a sandbox at least as deep as `level` now, whatever its sleep
    /// settings say. Returns once the request is accepted, not once the
    /// sandbox is there; a later wake cancels it. With a `generation`, only
    /// while the sandbox is still at it.
    pub async fn sleep(
        &self,
        id: Id,
        generation: Option<u64>,
        level: Level,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Sleep {
            id,
            generation,
            level,
            reply,
        })
        .await?
    }

    /// Keeps a sandbox awake for a named reason, such as an agent turn in
    /// progress, waking it if it sleeps. Holding again under the same name
    /// refreshes the hold; with a `ttl` it lapses on its own unless
    /// refreshed, so a caller that dies cannot keep a sandbox awake forever.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn hold(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.hold_renewing(id, generation, name, ttl, priority)
            .await
            .map(|_| ())
    }

    /// Like [`Self::hold`], telling whether the hold was already there.
    pub(crate) async fn hold_renewing(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<bool, HostError> {
        self.ask(|reply| Command::Hold {
            id,
            generation,
            name: name.to_owned(),
            ttl,
            priority,
            reply,
        })
        .await?
    }

    /// One sandbox's level and the step under way, if the host has it.
    pub(crate) async fn inspect(&self, id: Id) -> Result<Option<(Level, Option<Step>)>, HostError> {
        self.ask(|reply| Command::Inspect { id, reply }).await
    }

    /// Ends a named hold. Ending one that does not exist does nothing. With
    /// a `generation`, only while the sandbox is still at it.
    pub async fn release(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Unhold {
            id,
            generation,
            name: name.to_owned(),
            reply,
        })
        .await?
    }
}

impl Lease {
    /// How long waking took.
    #[must_use]
    pub fn waited(&self) -> Duration {
        self.waited
    }

    /// The step under way when the wake arrived, if any: a wake during a
    /// sleep step cancels it or waits for it to finish.
    #[must_use]
    pub fn during(&self) -> Option<Step> {
        self.during
    }

    /// The wake step the request waited for, if one ran: its events carry
    /// the same operation id.
    #[must_use]
    pub fn op(&self) -> Option<OpId> {
        self.op
    }

    /// The execution the lease reaches. It changes only when the sandbox
    /// boots afresh, which ends whatever programs ran in it; a caller that
    /// started some can pass it to later requests to make sure they reach
    /// the same ones.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Host side of the sandbox's vsock device.
    #[must_use]
    pub fn vsock(&self) -> &Path {
        &self.vsock
    }

    /// Connects to `port` inside the sandbox. Right after a fresh boot the
    /// guest may not listen yet, so this retries until `timeout`. Should the
    /// sandbox boot afresh meanwhile, a lease asked for a generation drops
    /// the connection and returns [`HostError::Stale`]; any other follows
    /// the sandbox to its new execution. Either way, once this succeeds,
    /// [`Lease::generation`] names the execution the stream reached.
    pub async fn connect(&mut self, port: u32, timeout: Duration) -> Result<UnixStream, HostError> {
        let deadline = Instant::now() + timeout;
        loop {
            let stream = self.reach(port, deadline).await?;
            // A replacement raises the generation before its VM starts, so
            // a generation unchanged after connecting proves the connection
            // reached the lease's execution.
            let (reply, answer) = oneshot::channel();
            self.commands
                .send(Command::Check {
                    id: self.id,
                    generation: self.generation,
                    reply,
                })
                .map_err(|_| HostError::Stopped)?;
            match answer.await.map_err(|_| HostError::Stopped)? {
                Ok(()) => return Ok(stream),
                Err(HostError::Stale { found, .. })
                    if !self.pinned && Instant::now() < deadline =>
                {
                    self.generation = found;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// A connection to `port` in whichever VM the sandbox has, retried
    /// until `deadline`.
    async fn reach(&self, port: u32, deadline: Instant) -> Result<UnixStream, HostError> {
        let mut delay = Duration::from_millis(2);
        loop {
            match vsock::connect(&self.vsock, port).await {
                Ok(stream) => return Ok(stream),
                Err(error) if Instant::now() + delay >= deadline => {
                    return Err(HostError::Unreachable {
                        port,
                        message: error.to_string(),
                    });
                }
                Err(_) => {
                    sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Release {
            id: self.id,
            hold: self.hold,
        });
    }
}
