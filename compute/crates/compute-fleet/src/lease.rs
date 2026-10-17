//! Host leases: how long a host may run its sandboxes without hearing
//! from the service, and when the service may give up on it.
//!
//! The two sides measure on their own clocks, which need not agree, only
//! run at about the same rate. A host stamps each renewal with its clock
//! when it sends it, and may run its VMs until that time plus the term T.
//! The service accepts the renewal later than it was sent, and treats the
//! host as lost only once T plus a margin has passed since the last renewal
//! it accepted. So the host stops at least the margin before the service
//! hands its sandboxes to others, whatever the network delays, as long as
//! the clocks' rates differ by less than margin / (T + margin).
//!
//! Renewals also bound how long a request from the service stays good. The
//! host numbers its renewals under each registration, and the service
//! stamps each request with the highest number it accepted. A host refuses
//! a request more than [`LeaseTerms::request_window`] renewals old, so an
//! answer that a host holds nothing of a sandbox is final for every
//! earlier request once [`LeaseTerms::settles`] says so: a create or adopt
//! held up on the way can no longer land after it.

use core::fmt;
use core::time::Duration;
use std::collections::BTreeMap;

use compute_core::At;

use crate::ids::{HostEpoch, HostId};

/// How long a lease lasts and how often it is renewed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeaseTerms {
    /// How long after sending a renewal a host may run its VMs: T.
    pub term: Duration,
    /// How much longer than the term the service waits after the last
    /// renewal it accepted before it hands a host's sandboxes to others.
    pub margin: Duration,
    /// How often a registered host sends a renewal.
    pub renew_every: Duration,
    /// How often a host without a lease tries to register.
    pub register_every: Duration,
    /// For how many renewals after it was stamped a host still takes a
    /// request.
    pub request_window: u64,
}

/// Why [`LeaseTerms`] are refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseError {
    /// The term, margin, an interval or the request window is zero.
    Zero,
    /// Fewer than two renewals fit in a term, so one lost renewal would
    /// stop every VM on the host.
    RenewTooRare,
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Zero => "the lease term, margin, intervals and request window must not be zero",
            Self::RenewTooRare => "a host must renew at least twice per lease term",
        })
    }
}

impl LeaseTerms {
    /// A ten-second term, renewed every third of it, with a five-second
    /// margin; requests stay good for two renewals, about seven seconds.
    pub const RECOMMENDED: Self = Self {
        term: Duration::from_secs(10),
        margin: Duration::from_secs(5),
        renew_every: Duration::from_millis(3_333),
        register_every: Duration::from_secs(1),
        request_window: 2,
    };

    /// These terms, if they are safe to run with.
    pub fn validate(self) -> Result<Self, LeaseError> {
        if self.term.is_zero()
            || self.margin.is_zero()
            || self.renew_every.is_zero()
            || self.register_every.is_zero()
            || self.request_window == 0
        {
            return Err(LeaseError::Zero);
        }
        if self.renew_every.saturating_mul(2) > self.term {
            return Err(LeaseError::RenewTooRare);
        }
        Ok(self)
    }

    /// When, on the service's clock, a host whose last accepted renewal
    /// was at `renewed` becomes lost.
    #[must_use]
    pub fn lost_at(self, renewed: At) -> At {
        renewed + self.term + self.margin
    }

    /// Whether, on the service's clock, a host whose last accepted renewal
    /// was at `renewed` is lost at `now`.
    #[must_use]
    pub fn is_lost(self, renewed: At, now: At) -> bool {
        now >= self.lost_at(renewed)
    }

    /// Whether an answer a host gave after its renewal `answered` is final
    /// for every request stamped `stamp` or earlier under the same
    /// registration: the host refuses any of them that reaches it later.
    #[must_use]
    pub fn settles(self, stamp: u64, answered: u64) -> bool {
        stamp.saturating_add(self.request_window) < answered
    }
}

/// A renewal or registration a host sent: when, on its own clock, under
/// which registration, and its number there. Kept until its answer
/// arrives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Renewal {
    /// When the host sent it.
    pub sent: At,
    /// The registration it renews; `None` for a registration.
    pub epoch: Option<HostEpoch>,
    /// Its number under that registration, from 1; 0 for a registration.
    /// The service keeps the highest it accepted and stamps requests
    /// with it.
    pub seq: u64,
}

/// What a host keeps of its lease where a restarted agent and the guard
/// find it (a file in `/run`, which a reboot empties).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeaseRecord {
    /// The registration held, if any.
    pub epoch: Option<HostEpoch>,
    /// VMs may run strictly before this.
    pub deadline: At,
    /// The number of the last renewal sent under the registration.
    pub seq: u64,
}

impl LeaseRecord {
    /// What a host that never registered keeps.
    pub const NONE: Self = Self {
        epoch: None,
        deadline: At::ZERO,
        seq: 0,
    };
}

/// A host's side of its lease, on the host's own monotonic clock (one that
/// keeps counting while the machine is suspended, such as the boot clock).
///
/// The caller sends what [`Self::send`] returns when [`Self::due`] says,
/// hands each answer back, and runs its VMs only while [`Self::may_run`].
/// Answers may arrive late, out of order or not at all. Whenever
/// [`Self::record`] changes the caller stores it before it sends anything
/// or answers any request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostLease {
    terms: LeaseTerms,
    epoch: Option<HostEpoch>,
    /// VMs may run strictly before this.
    deadline: At,
    /// The number of the last renewal sent under `epoch`.
    seq: u64,
    last_sent: Option<At>,
}

impl HostLease {
    /// A host that has not registered: it may run nothing.
    #[must_use]
    pub fn new(terms: LeaseTerms) -> Self {
        Self::resume(terms, LeaseRecord::NONE)
    }

    /// Takes over the lease a previous run of the agent held, as it left it
    /// on disk, so a restarted agent keeps renewing the same registration.
    #[must_use]
    pub fn resume(terms: LeaseTerms, record: LeaseRecord) -> Self {
        Self {
            terms,
            epoch: record.epoch,
            deadline: record.deadline,
            seq: record.seq,
            last_sent: None,
        }
    }

    /// What to keep where a restarted agent and the guard find it.
    #[must_use]
    pub fn record(&self) -> LeaseRecord {
        LeaseRecord {
            epoch: self.epoch,
            deadline: self.deadline,
            seq: self.seq,
        }
    }

    /// The terms it runs under.
    #[must_use]
    pub fn terms(&self) -> LeaseTerms {
        self.terms
    }

    /// The registration it holds, if any.
    #[must_use]
    pub fn epoch(&self) -> Option<HostEpoch> {
        self.epoch
    }

    /// VMs may run strictly before this.
    #[must_use]
    pub fn deadline(&self) -> At {
        self.deadline
    }

    /// Whether VMs may run, and archives start, at `now`.
    #[must_use]
    pub fn may_run(&self, now: At) -> bool {
        now < self.deadline
    }

    /// The number of the last renewal sent under the registration held;
    /// answers to the service carry it.
    #[must_use]
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Whether a request stamped `stamp` under the registration held is
    /// still good: no more than the request window of renewals old.
    #[must_use]
    pub fn admits(&self, stamp: u64) -> bool {
        stamp.saturating_add(self.terms.request_window) >= self.seq
    }

    /// When the next renewal or registration should be sent.
    #[must_use]
    pub fn due(&self) -> At {
        let every = if self.epoch.is_some() {
            self.terms.renew_every
        } else {
            self.terms.register_every
        };
        self.last_sent.map_or(At::ZERO, |sent| sent + every)
    }

    /// Notes that a renewal, or a registration when it holds none, is sent
    /// at `now`, and returns what to keep until its answer. A renewal
    /// raises [`Self::record`]'s number, to be stored before it is sent.
    pub fn send(&mut self, now: At) -> Renewal {
        self.last_sent = Some(now);
        if self.epoch.is_some() {
            self.seq += 1;
        }
        Renewal {
            sent: now,
            epoch: self.epoch,
            seq: self.seq,
        }
    }

    /// The service accepted `renewal`. Returns whether the deadline moved.
    /// An answer for another registration than the one held changes
    /// nothing.
    pub fn renewed(&mut self, renewal: Renewal) -> bool {
        if renewal.epoch.is_none() || renewal.epoch != self.epoch {
            return false;
        }
        self.extend(renewal.sent)
    }

    /// Whether `renewal` is the registration this host sent last and still
    /// waits on. Only its answer counts: an earlier registration's answer
    /// listed what the host had then, not now, so the caller ignores the
    /// whole answer, and the service refuses a second registration until
    /// the first lapses.
    #[must_use]
    pub fn awaits(&self, renewal: Renewal) -> bool {
        self.epoch.is_none() && renewal.epoch.is_none() && self.last_sent == Some(renewal.sent)
    }

    /// The service registered the host under `epoch` in answer to
    /// `renewal`, which [`Self::awaits`]. The caller must first drop every
    /// sandbox the answer does not keep: the new deadline lets the rest run
    /// again. Returns whether the registration was taken.
    pub fn registered(&mut self, renewal: Renewal, epoch: HostEpoch) -> bool {
        if !self.awaits(renewal) {
            return false;
        }
        self.epoch = Some(epoch);
        self.seq = 0;
        self.extend(renewal.sent);
        true
    }

    /// The service no longer knows the registration `renewal` renewed: the
    /// host was given up on, and must register again. VMs stop at the
    /// deadline already held, if the new registration has not extended it.
    pub fn refused(&mut self, renewal: Renewal) {
        if renewal.epoch.is_some() && renewal.epoch == self.epoch {
            self.epoch = None;
            self.seq = 0;
            self.last_sent = None;
        }
    }

    fn extend(&mut self, sent: At) -> bool {
        let deadline = sent + self.terms.term;
        if deadline > self.deadline {
            self.deadline = deadline;
            true
        } else {
            false
        }
    }
}

/// The service's side: which hosts have stopped renewing, measured on one
/// clock only, the monotonic clock of the replica that watches.
///
/// Each accepted renewal raises a host's renewal count in the store. The
/// watcher reads the counts and notes, on its own clock, when it first saw
/// each value; a host is lost once its count has stayed the same for the
/// term plus the margin. The watcher can only see a renewal after the host
/// sent it, so it never counts from earlier than the host does, and no two
/// clocks are ever compared. A new watcher, after a failover, starts with
/// nothing seen and so waits a full term and margin before it gives up on
/// anyone.
#[derive(Clone, Debug)]
pub struct Expiry {
    terms: LeaseTerms,
    seen: BTreeMap<HostId, (u64, At)>,
}

impl Expiry {
    /// A watcher that has seen nothing yet.
    #[must_use]
    pub fn new(terms: LeaseTerms) -> Self {
        Self {
            terms,
            seen: BTreeMap::new(),
        }
    }

    /// Notes that `host` had `renewals` accepted renewals when read at `now`.
    pub fn observe(&mut self, host: HostId, renewals: u64, now: At) {
        match self.seen.get_mut(&host) {
            Some((count, _)) if *count == renewals => {}
            Some(entry) => *entry = (renewals, now),
            None => {
                self.seen.insert(host, (renewals, now));
            }
        }
    }

    /// Stops watching `host`, once it is lost or gone.
    pub fn forget(&mut self, host: HostId) {
        self.seen.remove(&host);
    }

    /// Hosts lost at `now`, each with the renewal count to make marking it
    /// lost conditional on: a renewal accepted meanwhile saves it.
    pub fn expired(&self, now: At) -> impl Iterator<Item = (HostId, u64)> + '_ {
        self.seen
            .iter()
            .filter(move |(_, (_, since))| self.terms.is_lost(*since, now))
            .map(|(host, (count, _))| (*host, *count))
    }
}

#[cfg(test)]
mod tests {
    use core::time::Duration;

    use super::{At, Expiry, HostEpoch, HostId, HostLease, LeaseError, LeaseRecord, LeaseTerms};

    const T: LeaseTerms = LeaseTerms::RECOMMENDED;

    fn at(ms: u64) -> At {
        At::from_millis(ms)
    }

    #[test]
    fn recommended_terms_are_valid_and_rare_renewals_are_refused() {
        assert_eq!(T.validate(), Ok(T));
        let rare = LeaseTerms {
            renew_every: Duration::from_secs(6),
            ..T
        };
        assert_eq!(rare.validate(), Err(LeaseError::RenewTooRare));
        let zero = LeaseTerms {
            margin: Duration::ZERO,
            ..T
        };
        assert_eq!(zero.validate(), Err(LeaseError::Zero));
    }

    #[test]
    fn a_host_runs_until_term_after_it_sent_the_renewal_not_after_the_answer() {
        let mut lease = HostLease::new(T);
        assert!(!lease.may_run(at(0)), "an unregistered host runs nothing");
        let register = lease.send(at(1_000));
        // The answer arrives four seconds later.
        assert!(lease.awaits(register));
        assert!(lease.registered(register, HostEpoch(1)));
        assert_eq!(lease.deadline(), at(11_000));
        assert!(lease.may_run(at(10_999)));
        assert!(!lease.may_run(at(11_000)));
    }

    #[test]
    fn answers_out_of_order_never_shorten_the_deadline() {
        let mut lease = HostLease::new(T);
        let register = lease.send(at(0));
        lease.registered(register, HostEpoch(3));
        let first = lease.send(at(3_333));
        let second = lease.send(at(6_666));
        assert!(lease.renewed(second));
        assert!(
            !lease.renewed(first),
            "a late answer moved the deadline back"
        );
        assert_eq!(lease.deadline(), at(16_666));
    }

    #[test]
    fn answers_for_another_registration_change_nothing() {
        let mut lease = HostLease::new(T);
        let old = lease.send(at(0));
        lease.registered(old, HostEpoch(1));
        let renewal = lease.send(at(1_000));
        lease.refused(renewal);
        assert_eq!(lease.epoch(), None);
        assert_eq!(lease.due(), At::ZERO, "a refused host registers at once");
        // The renewal of the lost registration is answered late.
        assert!(!lease.renewed(renewal));
        assert_eq!(lease.deadline(), at(10_000));
        let earlier = lease.send(at(2_000));
        let register = lease.send(at(3_000));
        assert!(
            !lease.awaits(earlier),
            "an earlier registration's answer counts"
        );
        assert!(!lease.registered(earlier, HostEpoch(2)));
        assert!(lease.registered(register, HostEpoch(3)));
        assert!(
            !lease.registered(old, HostEpoch(1)),
            "an older registration came back"
        );
        assert_eq!(lease.epoch(), Some(HostEpoch(3)));
    }

    #[test]
    fn renewals_are_due_every_third_of_the_term_and_registrations_every_second() {
        let mut lease = HostLease::new(T);
        lease.send(at(500));
        assert_eq!(lease.due(), at(1_500));
        let register = lease.send(at(1_500));
        lease.registered(register, HostEpoch(1));
        lease.send(at(2_000));
        assert_eq!(lease.due(), at(5_333));
    }

    #[test]
    fn renewals_are_numbered_per_registration_and_bound_requests() {
        let mut lease = HostLease::new(T);
        let register = lease.send(at(0));
        assert_eq!(register.seq, 0);
        lease.registered(register, HostEpoch(1));
        assert!(lease.admits(0));
        let first = lease.send(at(3_333));
        let second = lease.send(at(6_666));
        assert_eq!((first.seq, second.seq), (1, 2));
        assert!(lease.admits(0), "a request two renewals old is still good");
        lease.send(at(9_999));
        assert!(!lease.admits(0), "a request three renewals old was taken");
        assert!(lease.admits(1));
        // An answer after renewal 3 settles requests stamped 0, not 1.
        assert!(T.settles(0, lease.seq()));
        assert!(!T.settles(1, lease.seq()));
        // A restarted agent goes on from what it stored.
        let resumed = HostLease::resume(T, lease.record());
        assert_eq!(resumed.record(), lease.record());
        assert!(!resumed.admits(0));
        // A new registration counts from 0 again.
        lease.refused(second);
        assert_eq!(
            lease.record(),
            LeaseRecord {
                seq: 0,
                epoch: None,
                ..lease.record()
            }
        );
    }

    #[test]
    fn the_service_gives_up_only_after_term_and_margin() {
        assert!(!T.is_lost(at(1_000), at(15_999)));
        assert!(T.is_lost(at(1_000), at(16_000)));
    }

    #[test]
    fn a_watcher_counts_only_from_when_it_saw_a_renewal() {
        let mut expiry = Expiry::new(T);
        let (a, b) = (HostId(1), HostId(2));
        expiry.observe(a, 7, at(0));
        expiry.observe(b, 3, at(0));
        // b renews at 10 s; a does not.
        expiry.observe(a, 7, at(10_000));
        expiry.observe(b, 4, at(10_000));
        assert_eq!(expiry.expired(at(14_999)).count(), 0);
        assert_eq!(expiry.expired(at(15_000)).collect::<Vec<_>>(), vec![(a, 7)]);
        assert_eq!(expiry.expired(at(25_000)).count(), 2);
        expiry.forget(a);
        assert_eq!(expiry.expired(at(25_000)).collect::<Vec<_>>(), vec![(b, 4)]);
        // A new watcher waits a whole term and margin.
        let mut fresh = Expiry::new(T);
        fresh.observe(b, 4, at(25_000));
        assert_eq!(fresh.expired(at(39_999)).count(), 0);
    }
}
