//! How many hosts a host group should have.
//!
//! A group is hosts of one kind (one machine type and memory profile),
//! which a cloud scale set or instance group grows and shrinks. The
//! service keeps spare memory in each group: enough that the next burst of
//! creates and wakes lands at once, because a new host takes minutes to
//! boot. It grows as soon as spare memory, counting hosts already booting,
//! falls below the target, and shrinks one host at a time, by draining the
//! emptiest, only when it has more than two hosts' worth beyond it.

/// What a group should keep spare and how far it may grow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScalePolicy {
    /// Spare memory to keep, in thousandths of the group's memory.
    pub spare_per_mille: u32,
    /// And at least room for this many of the largest sandboxes.
    pub spare_largest: u32,
    /// The largest sandbox's guaranteed memory in MiB.
    pub largest_mib: u64,
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
    /// Memory in MiB the live hosts have for sandboxes.
    pub memory_mib: u64,
    /// Memory in MiB the live hosts can still promise.
    pub free_memory_mib: u64,
}

/// What to do with a group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaleDecision {
    /// Leave it as it is.
    Hold,
    /// Ask the cloud for this many hosts in all, counting live and booting
    /// ones.
    Grow {
        /// The group's new size.
        to: u32,
    },
    /// Drain the emptiest live host, then remove it.
    Shrink,
}

impl ScalePolicy {
    /// The spare memory in MiB `view` should keep.
    #[must_use]
    pub fn target_mib(&self, view: &GroupView) -> u64 {
        let share = view.memory_mib * u64::from(self.spare_per_mille) / 1_000;
        share.max(u64::from(self.spare_largest) * self.largest_mib)
    }

    /// What to do with the group `view` describes.
    #[must_use]
    pub fn decide(&self, view: &GroupView) -> ScaleDecision {
        let target = self.target_mib(view);
        let size = view.hosts + view.booting;
        let coming = u64::from(view.booting) * self.host_memory_mib;
        let spare = view.free_memory_mib + coming;
        let mut wanted = size.max(self.min_hosts);
        if spare < target && self.host_memory_mib > 0 {
            let short = (target - spare).div_ceil(self.host_memory_mib);
            wanted = wanted.max(size.saturating_add(u32::try_from(short).unwrap_or(u32::MAX)));
        }
        let wanted = wanted.min(self.max_hosts);
        if wanted > size {
            return ScaleDecision::Grow { to: wanted };
        }
        let settled = view.booting == 0 && view.draining == 0;
        let plenty = view.free_memory_mib >= target + 2 * self.host_memory_mib;
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
        host_memory_mib: 100 * 1024,
        min_hosts: 2,
        max_hosts: 50,
    };

    fn view(hosts: u32, free_gib: u64) -> GroupView {
        GroupView {
            hosts,
            booting: 0,
            draining: 0,
            memory_mib: u64::from(hosts) * 100 * 1024,
            free_memory_mib: free_gib * 1024,
        }
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
        assert_eq!(POLICY.decide(&view(2, 200)), ScaleDecision::Hold);
    }

    #[test]
    fn it_never_passes_the_maximum() {
        assert_eq!(POLICY.decide(&view(49, 0)), ScaleDecision::Grow { to: 50 });
        assert_eq!(POLICY.decide(&view(50, 0)), ScaleDecision::Hold);
    }
}
