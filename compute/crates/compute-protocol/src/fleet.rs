//! The fleet service's host API, and the envelope on the service's
//! requests to hosts
//! ([ADR 18](../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
//!
//! A host sends JSON over HTTPS to the service: it registers
//! ([`Register`]), renews its lease ([`Renew`]) and, between renewals,
//! reports what it can take on ([`Report`]). The service sends the host
//! agent's own requests ([`crate::host::Request`]) over mutual TLS, each
//! wrapped in an [`Envelope`] naming the registration, the latest renewal
//! and the owner epoch it was sent under, so a host refuses one that is
//! too old or meant for an earlier registration or owner. The host answers
//! each with an [`Answer`] saying when it answered, so the service can
//! order two answers about one sandbox that arrive out of order.

use serde::{Deserialize, Serialize};

use crate::host::{Id, Reply, Request};

/// Where the service's host API lives: registrations, renewals and reports
/// are posted under it.
pub const REGISTER_PATH: &str = "/v1/hosts/register";
/// See [`REGISTER_PATH`].
pub const RENEW_PATH: &str = "/v1/hosts/renew";
/// See [`REGISTER_PATH`].
pub const REPORT_PATH: &str = "/v1/hosts/report";

/// How long a lease lasts and how often it is renewed, as the service
/// tells a host when it registers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    /// How long VMs may run after the host sent a renewal the service
    /// accepted.
    pub term_ms: u64,
    /// How much longer than the term the service waits before it gives up
    /// on a host.
    pub margin_ms: u64,
    /// How often the host renews.
    pub renew_every_ms: u64,
    /// How often a host without a registration tries to register.
    pub register_every_ms: u64,
    /// How many renewals old a request may be before the host refuses it.
    pub request_window: u64,
    /// How long after the guard last fed it the kernel watchdog stops the
    /// machine, on the host's clock: whole seconds.
    pub watchdog_ms: u64,
    /// How long the machine takes, at most, from the watchdog firing to no
    /// VM running.
    pub stop_ms: u64,
    /// How far, in parts per million, the host's clock may run fast or
    /// slow: the margin covers this much on both ends.
    pub rate_error_ppm: u32,
}

/// What a host is, fixed while it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostInfo {
    /// Its name, unique in the fleet, such as its instance name: the
    /// service finds a host that comes back by it.
    pub name: String,
    /// Where the service reaches its API (`host:port`, mutual TLS).
    pub address: String,
    /// Its failure zone; placement spreads sandboxes over zones.
    pub zone: String,
    /// How it backs guest memory (`bare_metal` or `nested`): a memory
    /// image restores only on a host with the same profile and CPU
    /// template.
    pub profile: String,
    /// The CPU model its guests see.
    pub cpu_template: String,
    /// Memory it gives sandboxes, in MiB.
    pub memory_mib: u64,
    /// Disk it gives sandboxes, in MiB.
    pub disk_mib: u64,
}

/// Ready clones a host holds of one shape (see the host's ready pool).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyClones {
    pub vcpus: u32,
    pub memory_mib: u32,
    pub count: u32,
}

/// What a host can take on now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capacity {
    /// Memory free for sandboxes above the host's buffer, in MiB.
    pub memory_free_mib: u64,
    /// Disk free for sandboxes, in MiB.
    pub disk_free_mib: u64,
    /// Its ready clones, per shape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ready: Vec<ReadyClones>,
    /// Sandboxes whose VM runs.
    pub awake: u32,
    /// Sandboxes it holds.
    pub sandboxes: u32,
}

/// A sandbox a registering host still has, under the owner epoch its
/// record holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Held {
    pub id: Id,
    pub owner_epoch: u64,
}

/// A host registers: when it starts without a registration, and again
/// whenever the service no longer knows the one it held.
///
/// Every copy of one attempt is the same request: it is sent again,
/// unchanged, until it is answered, and the service answers every copy of
/// it with the answer it stored for the first, so a lost answer never
/// starts the registration over. Only what it lists may shrink between
/// attempts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    /// The host id it had, if it registered before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<u64>,
    /// The attempt's number, which no earlier run of the agent used (each
    /// run numbers its attempts on from a random start).
    pub attempt: u64,
    pub info: HostInfo,
    pub capacity: Capacity,
    /// Every sandbox it still has.
    pub held: Vec<Held>,
}

/// What a host does with a sandbox it listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case", deny_unknown_fields)]
pub enum Verdict {
    /// Keep the local copy and run it under `owner_epoch` from now on.
    Keep { owner_epoch: u64 },
    /// It is still this host's, but its copy is older than the latest
    /// archive: drop the copy and adopt the archive under `owner_epoch`.
    Refetch { owner_epoch: u64 },
    /// Drop the local copy: it belongs to someone else, or no longer
    /// exists.
    Drop,
}

/// The service's verdict on one listed sandbox. (Serde cannot refuse
/// unknown fields next to a flattened one; [`Verdict`] refuses its own.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ruling {
    pub id: Id,
    #[serde(flatten)]
    pub verdict: Verdict,
}

/// The answer to a [`Register`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Registered {
    /// Registered under `epoch`. The host drops, and confirms gone, every
    /// listed sandbox the rulings do not keep, records the new owner
    /// epochs of the rest, and only then lets them run again.
    Registered {
        host: u64,
        epoch: u64,
        terms: Terms,
        rulings: Vec<Ruling>,
    },
    /// The host's previous registration may still be running VMs: it
    /// registers again once that one lapses.
    StillLive { retry_after_ms: u64 },
}

/// A host renews the registration it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Renew {
    pub host: u64,
    pub epoch: u64,
    /// Its number under the registration, from 1. The service stamps its
    /// requests to the host with the highest it accepted.
    pub seq: u64,
    pub capacity: Capacity,
}

/// The answer to a [`Renew`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Renewed {
    /// Accepted: the host may run its VMs until the time it sent this
    /// renewal plus the term.
    Renewed { epoch: u64, seq: u64 },
    /// The service does not know this registration (the host was given up
    /// on): the host registers again.
    Unknown,
}

/// What a host can take on, reported between renewals when it changes (at
/// most once a second). It extends nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub host: u64,
    pub epoch: u64,
    pub capacity: Capacity,
}

/// What the service's request to a host was sent under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sent {
    /// The registration it is for.
    pub host_epoch: u64,
    /// The highest renewal number the service had accepted from the host.
    pub stamp: u64,
    /// The sandbox's owner epoch, for a request about one sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
}

/// One request from the service to a host: one JSON line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub sent: Sent,
    pub request: Request,
}

/// When a host answered: under which registration, and its latest renewal
/// the service had accepted then. Of two answers about one sandbox, one
/// under a later registration, or after a later renewal of the same one,
/// was given later; two between the same renewals do not order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answered {
    /// The registration, if the host held one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_epoch: Option<u64>,
    pub seq: u64,
}

impl Answered {
    /// Whether `self` was given after `than`.
    #[must_use]
    pub fn later_than(self, than: Self) -> bool {
        match (self.host_epoch, than.host_epoch) {
            (Some(epoch), Some(than_epoch)) if epoch != than_epoch => epoch > than_epoch,
            (Some(_), None) => true,
            (None, _) => false,
            _ => self.seq > than.seq,
        }
    }
}

/// A host's answer to one [`Envelope`]: one JSON line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub answered: Answered,
    pub reply: Reply,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_forms_are_stable() {
        let ruling: Ruling = serde_json::from_str(
            r#"{"id":"0193f3c27a1b7cde8f00112233445566","verdict":"keep","owner_epoch":4}"#,
        )
        .unwrap();
        assert_eq!(ruling.verdict, Verdict::Keep { owner_epoch: 4 });
        let renewed: Renewed = serde_json::from_str(r#"{"result":"unknown"}"#).unwrap();
        assert_eq!(renewed, Renewed::Unknown);
        let envelope: Envelope = serde_json::from_str(
            r#"{"sent":{"host_epoch":3,"stamp":9,"owner_epoch":2},"request":{"op":"status"}}"#,
        )
        .unwrap();
        assert_eq!(envelope.sent.owner_epoch, Some(2));
        assert!(matches!(envelope.request, Request::Status));
        assert!(
            serde_json::from_str::<Renew>(r#"{"host":1,"epoch":1,"seq":1}"#).is_err(),
            "a renewal says what the host can take on"
        );
        let register: Register = serde_json::from_str(
            r#"{"attempt":7,"info":{"name":"h","address":"h:1","zone":"z","profile":"nested","cpu_template":"t","memory_mib":1,"disk_mib":1},"capacity":{"memory_free_mib":1,"disk_free_mib":1,"awake":0,"sandboxes":0},"held":[]}"#,
        )
        .unwrap();
        assert_eq!((register.host, register.attempt), (None, 7));
    }

    #[test]
    fn answers_order_by_registration_then_renewal() {
        let at = |host_epoch, seq| Answered { host_epoch, seq };
        assert!(at(Some(2), 1).later_than(at(Some(1), 9)));
        assert!(!at(Some(1), 9).later_than(at(Some(2), 1)));
        assert!(at(Some(1), 4).later_than(at(Some(1), 3)));
        assert!(
            !at(Some(1), 3).later_than(at(Some(1), 3)),
            "between the same renewals"
        );
        assert!(at(Some(1), 0).later_than(at(None, 5)));
        assert!(
            !at(None, 5).later_than(at(None, 1)),
            "unregistered answers never order"
        );
        let answer: Answer = serde_json::from_str(
            r#"{"answered":{"host_epoch":3,"seq":4},"reply":{"result":"done"}}"#,
        )
        .unwrap();
        assert_eq!(answer.answered, at(Some(3), 4));
    }
}
