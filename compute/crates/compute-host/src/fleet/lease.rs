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

use std::path::PathBuf;
use std::time::Duration;

use compute_core::At;
use compute_fleet::{HostEpoch, HostLease, LeaseTerms, Renewal};
use compute_protocol::fleet::{
    Answered, Capacity, Held, HostInfo, REGISTER_PATH, RENEW_PATH, REPORT_PATH, ReadyClones,
    Register, Registered, Renew, Renewed, Report, Terms,
};
use compute_protocol::host::HostStatus;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;

use super::gate::{LeaseGate, boot_now};
use super::record::LeaseFile;
use crate::agent::Handle;

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
    pub(crate) handle: Handle,
    pub(crate) info: HostInfo,
    /// The name the fleet gives the image this host's sandboxes start
    /// from.
    pub(crate) image: String,
}

/// The renewer's state while it runs.
struct Running {
    renewer: Renewer,
    answers: mpsc::UnboundedSender<(Renewal, Answer)>,
    /// The registration attempt under way, sent unchanged until answered.
    attempt: Option<Register>,
    /// No registration is sent before this: the service said the previous
    /// one may still run VMs.
    not_before: At,
    /// The capacity last sent.
    reported: Option<Capacity>,
}

impl Renewer {
    /// Renews until the agent stops; fails only if the lease file cannot be
    /// written, since then the guard would act on a stale lease.
    pub(crate) async fn run(self) -> anyhow::Result<()> {
        let (answers, mut answered) = mpsc::unbounded_channel();
        let mut running = Running {
            renewer: self,
            answers,
            attempt: None,
            not_before: At::ZERO,
            reported: None,
        };
        let mut report = tokio::time::interval(Duration::from_secs(1));
        report.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let due = running.renewer.lease.due().max(running.not_before);
            let wait = due.saturating_since(boot_now());
            tokio::select! {
                () = tokio::time::sleep(wait) => running.send().await?,
                Some((renewal, answer)) = answered.recv() => running.take(renewal, answer).await?,
                _ = report.tick() => running.report().await,
            }
        }
    }
}

impl Running {
    /// Sends the renewal or registration due now.
    async fn send(&mut self) -> anyhow::Result<()> {
        let renewer = &mut self.renewer;
        let Ok(status) = renewer.handle.status().await else {
            anyhow::bail!("the agent stopped");
        };
        let renewal = renewer.lease.send(boot_now());
        let timeout = renewer.lease.terms().term;
        if let Some(epoch) = renewal.epoch {
            // The renewal's number rose: the file says so before it goes.
            self.store()?;
            let renewer = &self.renewer;
            let body = Renew {
                host: renewer.host.unwrap_or_default(),
                epoch: epoch.0,
                seq: renewal.seq,
                capacity: capacity(&status, &renewer.image),
            };
            self.post(RENEW_PATH, &body, timeout, renewal, Answer::Renewed);
            return Ok(());
        }
        if renewer.lease.attempt_started(renewal) || self.attempt.is_none() {
            // What the host lists must be all it holds: a create, adopt or
            // change of owner still under way could land after the list
            // and run unruled. None can start now, with no registration
            // held, so the list waits for those under way to end.
            let status = match renewer.handle.inventory().await {
                Ok(Ok(status)) => status,
                Ok(Err(unsettled)) => {
                    tracing::info!(unsettled, "registering once requests under way end");
                    self.attempt = None;
                    return Ok(());
                }
                Err(_) => anyhow::bail!("the agent stopped"),
            };
            if !status.blocked.is_empty() {
                // It cannot rule on what it cannot manage: wait until they
                // can be read again, or someone removes them.
                tracing::warn!(
                    blocked = status.blocked.len(),
                    "not registering while sandboxes are blocked"
                );
                self.attempt = None;
                return Ok(());
            }
            self.attempt = Some(Register {
                host: renewer.host,
                attempt: renewal.attempt,
                info: renewer.info.clone(),
                capacity: capacity(&status, &renewer.image),
                held: status
                    .sandboxes
                    .iter()
                    .map(|sandbox| Held {
                        id: sandbox.id,
                        owner_epoch: sandbox.owner_epoch,
                    })
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
            }
            Answer::Renewed(Renewed::Renewed { epoch, seq }) => {
                let same = renewal.epoch == Some(HostEpoch(epoch)) && renewal.seq == seq;
                if same && self.renewer.lease.renewed(renewal) {
                    self.store()?;
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
        // Everything not kept goes first: the deadline that lets the rest
        // run again is written only after.
        if let Err(error) = renewer.handle.reconcile(rulings).await {
            tracing::warn!(%error, "could not carry out the control service's rulings yet");
            return Ok(());
        }
        if renewer.lease.registered(renewal, HostEpoch(epoch)) {
            renewer.host = Some(host);
            self.attempt = None;
            self.reported = None;
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

    /// Sends what the host can take on, when it changed since last sent.
    async fn report(&mut self) {
        let renewer = &self.renewer;
        let (Some(host), Some(epoch)) = (renewer.host, renewer.lease.epoch()) else {
            return;
        };
        let Ok(status) = renewer.handle.status().await else {
            return;
        };
        let capacity = capacity(&status, &renewer.image);
        if self.reported.as_ref() == Some(&capacity) {
            return;
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
    }
}

/// What the host can take on, from its status; its ready clones all start
/// from `image`.
fn capacity(status: &HostStatus, image: &str) -> Capacity {
    let mib = |bytes: u64| bytes >> 20;
    Capacity {
        memory_free_mib: status.capacity.as_ref().map_or(0, |held| mib(held.free)),
        disk_free_mib: status.disk.as_ref().map_or(0, |disk| mib(disk.free)),
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
    fn terms_survive_the_wire() {
        let terms = LeaseTerms::RECOMMENDED;
        assert_eq!(terms_of(wire_terms(terms)), terms);
    }
}
