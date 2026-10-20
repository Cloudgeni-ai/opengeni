//! How many hosts a host group should have.
//!
//! A group is hosts of one kind (one machine type and memory profile),
//! which a cloud scale set or instance group grows and shrinks. The
//! service keeps spare memory in each group: enough that the next burst of
//! creates and wakes lands at once, because a new host takes minutes to
//! boot. It grows as soon as spare memory, counting hosts already booting,
//! falls below the target, and shrinks one host at a time, by draining the
//! emptiest, only when it has more than two hosts' worth beyond it.
//!
//! Hosts that guarantee processor time keep spare processor time the same
//! way, to the same share: the group grows for whichever runs short first
//! and shrinks only with plenty of both. What a host guarantees falls
//! while something beside its sandboxes takes more of its processors than
//! it keeps back, down to none, so the group counts what hosts guarantee
//! now, and a host guaranteeing none still counts as reporting: it has no
//! processor time to spare, which is no reason to shrink. What a new host
//! brings is what the live hosts guaranteed when they registered, since
//! they are all of one kind and a new one starts as they did.
//!
//! A sandbox lands whole on one host, its memory and processor time both,
//! so spare scattered in slivers across hosts holds none of the largest.
//! Beside the shares, the group keeps rooms for the largest sandboxes:
//! how many of it each live host can still take, counted host by host
//! and summed. Rooms run short, and the group grows, even while the sums
//! of spare look plenty.

/// What a group should keep spare and how far it may grow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScalePolicy {
    /// Spare memory and processor time to keep, in thousandths of the
    /// group's.
    pub spare_per_mille: u32,
    /// And rooms for this many of the largest sandboxes, each on one host
    /// (see [`ScalePolicy::rooms`]).
    pub spare_largest: u32,
    /// The largest sandbox's guaranteed memory in MiB.
    pub largest_mib: u64,
    /// The largest sandbox's guaranteed processor time in millicores.
    pub largest_cpu_millis: u64,
    /// Memory in MiB a new host brings for sandboxes.
    pub host_memory_mib: u64,
    /// Fewest hosts the group keeps.
    pub min_hosts: u32,
    /// Most hosts the group may have.
    pub max_hosts: u32,
}

/// A group as the service sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct GroupView {
    /// Live hosts.
    pub hosts: u32,
    /// Hosts asked for that have not registered yet.
    pub booting: u32,
    /// Hosts draining ahead of removal.
    pub draining: u32,
    /// Places in the group held by hosts that have not registered in
    /// time: they bring nothing, and the group is not settled while one
    /// stands.
    pub stalled: u32,
    /// Memory in MiB the live hosts have for sandboxes.
    pub memory_mib: u64,
    /// Memory in MiB the live hosts can still promise.
    pub free_memory_mib: u64,
    /// Processor time in millicores the live hosts guarantee sandboxes
    /// now.
    pub cpu_millis: u64,
    /// Processor time in millicores the live hosts can still promise.
    pub free_cpu_millis: u64,
    /// The most processor time in millicores one live host guaranteed
    /// when it registered: what a new host of the group brings.
    pub host_cpu_millis: u64,
    /// The most processor time in millicores one live host guarantees
    /// now: the most removing one takes away.
    pub most_cpu_millis: u64,
    /// Live hosts that do not say what processor time they guarantee:
    /// while one does, processor time does not decide the group's size.
    pub cpu_unreported: u32,
    /// Rooms on the live hosts for the largest sandbox by memory alone:
    /// [`ScalePolicy::rooms`] of each host's free memory, summed.
    pub memory_rooms: u64,
    /// Rooms on the live hosts for the largest sandbox by memory and
    /// processor time both, on the same host: [`ScalePolicy::rooms`] of
    /// each host's free memory and processor time, summed. A host that
    /// does not say what processor time it guarantees counts by memory.
    pub rooms: u64,
}

/// What to do with a group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaleDecision {
    /// Leave it as it is.
    Hold,
    /// Have this many usable hosts in all, counting live and booting ones.
    /// The group's size is larger by the places draining and stalled
    /// hosts hold.
    Grow {
        /// How many usable hosts.
        to: u32,
    },
    /// Drain the emptiest live host, then remove it.
    Shrink,
}

impl ScalePolicy {
    /// The spare memory in MiB `view` should keep: its share of the
    /// group's, and at least what the rooms for the largest sandboxes
    /// take.
    #[must_use]
    pub fn target_mib(&self, view: &GroupView) -> u64 {
        let share = view.memory_mib * u64::from(self.spare_per_mille) / 1_000;
        share.max(u64::from(self.spare_largest) * self.largest_mib)
    }

    /// The spare processor time in millicores `view` should keep, when
    /// processor time decides the group's size, which it does once there
    /// are live hosts and every one says what it guarantees, even none:
    /// likewise.
    #[must_use]
    pub fn target_cpu_millis(&self, view: &GroupView) -> Option<u64> {
        if view.cpu_unreported > 0 || view.hosts == 0 {
            return None;
        }
        let share = view.cpu_millis * u64::from(self.spare_per_mille) / 1_000;
        Some(share.max(u64::from(self.spare_largest) * self.largest_cpu_millis))
    }

    /// How many of the largest sandbox a host with `free_mib` of memory,
    /// and `free_cpu_millis` of processor time when it guarantees any, can
    /// still take at once.
    #[must_use]
    pub fn rooms(&self, free_mib: u64, free_cpu_millis: Option<u64>) -> u64 {
        let memory = free_mib.checked_div(self.largest_mib).unwrap_or(u64::MAX);
        let cpu = free_cpu_millis
            .and_then(|free| free.checked_div(self.largest_cpu_millis))
            .unwrap_or(u64::MAX);
        memory.min(cpu)
    }

    /// What to do with the group `view` describes.
    #[must_use]
    pub fn decide(&self, view: &GroupView) -> ScaleDecision {
        let target = self.target_mib(view);
        let cpu_target = self.target_cpu_millis(view);
        let size = view.hosts + view.booting;
        let mut wanted = size.max(self.min_hosts);
        let mut short_of = |free: u64, target: u64, per_host: u64| {
            let spare = free.saturating_add(u64::from(view.booting).saturating_mul(per_host));
            if spare < target && per_host > 0 {
                let short = (target - spare).div_ceil(per_host);
                wanted = wanted.max(size.saturating_add(u32::try_from(short).unwrap_or(u32::MAX)));
            }
        };
        short_of(view.free_memory_mib, target, self.host_memory_mib);
        if let Some(cpu_target) = cpu_target {
            short_of(view.free_cpu_millis, cpu_target, view.host_cpu_millis);
        }
        // What a new host brings of rooms, those removing one may take
        // away, and those the live hosts have, by processor time too while
        // it decides. A group whose hosts guaranteed no processor time
        // when they registered cannot tell what a new one would bring,
        // and does not grow for it.
        let (rooms, host_rooms, removed_rooms) = if cpu_target.is_some() {
            (
                view.rooms,
                self.rooms(self.host_memory_mib, Some(view.host_cpu_millis)),
                self.rooms(self.host_memory_mib, Some(view.most_cpu_millis)),
            )
        } else {
            let rooms = self.rooms(self.host_memory_mib, None);
            (view.memory_rooms, rooms, rooms)
        };
        let rooms_target = u64::from(self.spare_largest);
        short_of(rooms, rooms_target, host_rooms);
        let wanted = wanted.min(self.max_hosts);
        if wanted > size {
            return ScaleDecision::Grow { to: wanted };
        }
        let settled = view.booting == 0 && view.draining == 0 && view.stalled == 0;
        // With one host gone, still a new host's worth beyond the target.
        let plenty = view.free_memory_mib >= target + 2 * self.host_memory_mib
            && cpu_target.is_none_or(|cpu_target| {
                view.free_cpu_millis >= cpu_target + view.most_cpu_millis + view.host_cpu_millis
            })
            // A host too small for the largest sandbox has no rooms to lose.
            && (host_rooms.max(removed_rooms) == 0
                || rooms >= rooms_target.saturating_add(host_rooms).saturating_add(removed_rooms));
        if settled && plenty && view.hosts > self.min_hosts {
            return ScaleDecision::Shrink;
        }
        ScaleDecision::Hold
    }
}

#[cfg(test)]
mod tests {
    use super::{GroupView, ScaleDecision, ScalePolicy};

    const POLICY: ScalePolicy = ScalePolicy {
        spare_per_mille: 200,
        spare_largest: 4,
        largest_mib: 8 * 1024,
        largest_cpu_millis: 4000,
        host_memory_mib: 100 * 1024,
        min_hosts: 2,
        max_hosts: 50,
    };

    /// Hosts that do not guarantee processor time.
    fn view(hosts: u32, free_gib: u64) -> GroupView {
        let free_memory_mib = free_gib * 1024;
        let rooms = POLICY.rooms(free_memory_mib, None);
        GroupView {
            hosts,
            booting: 0,
            draining: 0,
            stalled: 0,
            memory_mib: u64::from(hosts) * 100 * 1024,
            free_memory_mib,
            cpu_unreported: hosts,
            memory_rooms: rooms,
            rooms,
            ..GroupView::default()
        }
    }

    /// `view` with hosts of 30 guaranteed processors each, `free` of them
    /// left in all.
    fn with_cpu(mut view: GroupView, free: u64) -> GroupView {
        view.cpu_millis = u64::from(view.hosts) * 30_000;
        view.free_cpu_millis = free * 1000;
        view.host_cpu_millis = 30_000;
        view.most_cpu_millis = 30_000;
        view.cpu_unreported = 0;
        view.rooms = POLICY.rooms(view.free_memory_mib, Some(view.free_cpu_millis));
        view
    }

    /// Hosts that guarantee no processor time now, though they did when
    /// they registered, still decide by it: nothing is spare, so the
    /// group grows by what a new host brings and never shrinks.
    #[test]
    fn hosts_guaranteeing_none_now_grow_the_group_and_never_shrink_it() {
        let mut none = with_cpu(view(4, 400), 0);
        none.cpu_millis = 0;
        none.most_cpu_millis = 0;
        none.rooms = 0;
        // Four of the largest, 16 processors, at 30 a new host: one more.
        assert_eq!(POLICY.decide(&none), ScaleDecision::Grow { to: 5 });
        // At the most hosts it may have, it holds.
        let most = ScalePolicy {
            max_hosts: 4,
            min_hosts: 1,
            ..POLICY
        };
        assert_eq!(most.decide(&none), ScaleDecision::Hold);
        // Hosts that guaranteed none when they registered either: no new
        // host's worth is known, so it neither grows nor shrinks.
        none.host_cpu_millis = 0;
        assert_eq!(most.decide(&none), ScaleDecision::Hold);
        assert_eq!(POLICY.decide(&none), ScaleDecision::Hold);
    }

    /// What hosts guarantee now sets the share to keep, and what removing
    /// the largest of them takes away, beside a new host's worth.
    #[test]
    fn it_shrinks_by_what_hosts_guarantee_now() {
        // Four hosts that registered with 7.5 processors and guarantee 4
        // now, all of them free: 16 is the 4 to keep, 4 that removing one
        // takes away and 7.5 a new host brings.
        let policy = ScalePolicy {
            largest_cpu_millis: 1000,
            spare_largest: 4,
            min_hosts: 1,
            ..POLICY
        };
        let mut lowered = view(4, 400);
        lowered.cpu_unreported = 0;
        lowered.cpu_millis = 16_000;
        lowered.free_cpu_millis = 16_000;
        lowered.host_cpu_millis = 7500;
        lowered.most_cpu_millis = 4000;
        lowered.rooms = 16;
        assert_eq!(policy.decide(&lowered), ScaleDecision::Shrink);
        // Counted at what they registered with, it would not.
        lowered.cpu_millis = 30_000;
        lowered.most_cpu_millis = 7500;
        assert_eq!(policy.decide(&lowered), ScaleDecision::Hold);
    }

    #[test]
    fn it_grows_when_no_host_has_room_for_the_largest_sandbox_though_the_sums_do() {
        // Sandboxes of up to 8 processors; four hosts of 30 with 7 free
        // each: 28 in all, above the 24 to keep and two of the largest,
        // but no host has room for one.
        let policy = ScalePolicy {
            largest_cpu_millis: 8000,
            spare_largest: 2,
            ..POLICY
        };
        let mut view = with_cpu(view(4, 250), 28);
        view.rooms = 4 * policy.rooms(62 * 1024, Some(7000));
        assert_eq!(view.rooms, 0);
        // Two rooms short, at three a new host: one more.
        assert_eq!(policy.decide(&view), ScaleDecision::Grow { to: 5 });
        // With 8 free on one of them, it has room for one of the two.
        view.free_cpu_millis = 29_000;
        view.rooms = 1;
        assert_eq!(policy.decide(&view), ScaleDecision::Grow { to: 5 });
        view.rooms = 2;
        assert_eq!(policy.decide(&view), ScaleDecision::Hold);
        // By memory alone while a host does not report processor time.
        view.rooms = 0;
        view.cpu_unreported = 1;
        assert_eq!(policy.decide(&view), ScaleDecision::Hold);
        view.memory_rooms = 1;
        assert_eq!(policy.decide(&view), ScaleDecision::Grow { to: 5 });
    }

    #[test]
    fn a_host_too_small_for_the_largest_sandbox_lets_rooms_decide_nothing() {
        let policy = ScalePolicy {
            largest_mib: 200 * 1024,
            ..POLICY
        };
        let mut view = view(10, 1000);
        view.memory_rooms = 0;
        view.rooms = 0;
        // Its share and the largest's memory decide: 1000 GiB is the
        // 800 to keep and two hosts' more.
        assert_eq!(policy.decide(&view), ScaleDecision::Shrink);
    }

    #[test]
    fn it_grows_when_processor_time_runs_short_first() {
        // Plenty of memory, but of 300 processors only 20 are left, below
        // the 60 to keep: two more hosts.
        assert_eq!(
            POLICY.decide(&with_cpu(view(10, 250), 20)),
            ScaleDecision::Grow { to: 12 }
        );
        assert_eq!(
            POLICY.decide(&with_cpu(view(10, 250), 70)),
            ScaleDecision::Hold
        );
        // A booting host brings what a live one guarantees.
        let mut booting = with_cpu(view(10, 250), 40);
        booting.booting = 1;
        assert_eq!(POLICY.decide(&booting), ScaleDecision::Hold);
        // Memory short by more: memory decides.
        assert_eq!(
            POLICY.decide(&with_cpu(view(10, 10), 50)),
            ScaleDecision::Grow { to: 12 }
        );
    }

    #[test]
    fn processor_time_counts_only_when_every_live_host_reports_it() {
        let mut unreported = with_cpu(view(10, 250), 0);
        unreported.cpu_unreported = 1;
        assert_eq!(POLICY.decide(&unreported), ScaleDecision::Hold);
        assert_eq!(POLICY.decide(&view(10, 250)), ScaleDecision::Hold);
    }

    #[test]
    fn it_shrinks_only_with_plenty_of_memory_and_processor_time() {
        // Plenty of memory; 120 processors left is not 60 + two hosts' 60.
        assert_eq!(
            POLICY.decide(&with_cpu(view(10, 500), 110)),
            ScaleDecision::Hold
        );
        assert_eq!(
            POLICY.decide(&with_cpu(view(10, 500), 130)),
            ScaleDecision::Shrink
        );
    }

    #[test]
    fn it_grows_before_spare_memory_runs_out() {
        // Ten hosts, 1000 GiB, target 200 GiB spare; 150 GiB left.
        assert_eq!(
            POLICY.decide(&view(10, 150)),
            ScaleDecision::Grow { to: 11 }
        );
        // 10 GiB left: three more hosts.
        assert_eq!(POLICY.decide(&view(10, 10)), ScaleDecision::Grow { to: 12 });
        assert_eq!(POLICY.decide(&view(10, 250)), ScaleDecision::Hold);
    }

    #[test]
    fn hosts_already_booting_count_towards_the_spare() {
        let mut booting = view(10, 150);
        booting.booting = 1;
        assert_eq!(POLICY.decide(&booting), ScaleDecision::Hold);
    }

    #[test]
    fn a_small_group_keeps_room_for_the_largest_sandboxes_and_its_minimum() {
        // One host: 20 GiB is 20 % but below four 8 GiB sandboxes.
        assert_eq!(POLICY.decide(&view(1, 30)), ScaleDecision::Grow { to: 2 });
        assert_eq!(POLICY.decide(&view(0, 0)), ScaleDecision::Grow { to: 2 });
    }

    #[test]
    fn it_shrinks_one_host_at_a_time_and_only_with_plenty_to_spare() {
        assert_eq!(POLICY.decide(&view(10, 500)), ScaleDecision::Shrink);
        assert_eq!(POLICY.decide(&view(10, 380)), ScaleDecision::Hold);
        let mut draining = view(10, 500);
        draining.draining = 1;
        assert_eq!(POLICY.decide(&draining), ScaleDecision::Hold);
        let mut stalled = view(10, 500);
        stalled.stalled = 1;
        assert_eq!(POLICY.decide(&stalled), ScaleDecision::Hold);
        assert_eq!(POLICY.decide(&view(2, 200)), ScaleDecision::Hold);
    }

    #[test]
    fn it_never_passes_the_maximum() {
        assert_eq!(POLICY.decide(&view(49, 0)), ScaleDecision::Grow { to: 50 });
        assert_eq!(POLICY.decide(&view(50, 0)), ScaleDecision::Hold);
    }
}
