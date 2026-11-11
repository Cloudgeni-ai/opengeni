//! The processor time a host can guarantee its sandboxes, from the cgroup
//! hierarchy its VMs run in.
//!
//! With every processor busy the kernel shares processor time between the
//! busy groups beside each other by their `cpu.weight`, level by level
//! from the root down, no group gets more than its `cpu.max`, and the VMs
//! run only on the processors their group's `cpuset.cpus.effective`
//! lists. So the VMs' group gets, of what its parent gets, its weight's
//! share against the busy groups beside it; its parent likewise of what
//! its own parent gets; and so on up to the root, which holds all those
//! processors. Inside, each VM's own weight, 1 per 10 millicores
//! requested, gives it at least its request of what the group gets, as
//! long as the requests booked add up to no more than that.
//!
//! The host sets the VMs' group's weight to what covers its budget,
//! leaving the groups beside it what it keeps back, and guarantees no more
//! than that weight then gives. Groups beside it come and go (someone
//! logs in, a service starts), so it reads the hierarchy again every few
//! seconds and sets the weight, and what it guarantees, anew. A group
//! that holds no process takes no processor time; it is counted once it
//! does.

use std::fs;
use std::io;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};

/// The processor time the VMs' group `cgroup` gets, and the host
/// guarantees of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessorShare {
    cgroup: PathBuf,
    budget: u64,
    stated: bool,
}

/// What [`ProcessorShare::apply`] found and set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    /// The VMs' group's `cpu.weight`.
    pub weight: u16,
    /// Millicores the host guarantees its sandboxes at once: its budget,
    /// or what the VMs' group gets with every group beside it and above
    /// it busy, when that is less, rounded down to a multiple of 10: 0
    /// when it gets less than the 10 the smallest request is, and then
    /// no wake is admitted. A budget given outright
    /// ([`ProcessorShare::stated`]) is kept.
    pub capacity: u64,
    /// Millicores the VMs' group gets with every group beside it and
    /// above it busy.
    pub gets: u64,
    /// Millicores of the processors the VMs may run on.
    pub processors: u64,
}

impl Share {
    /// Whether the VMs' group gets all of `budget`.
    #[must_use]
    pub const fn whole(&self, budget: u64) -> bool {
        self.gets >= budget
    }
}

impl ProcessorShare {
    /// The share of the VMs' group `cgroup`, for a host that would
    /// guarantee its sandboxes `budget` millicores.
    #[must_use]
    pub const fn new(cgroup: PathBuf, budget: u64) -> Self {
        Self {
            cgroup,
            budget,
            stated: false,
        }
    }

    /// Keeps the budget as the capacity whatever the VMs' group gets, as
    /// for one an operator gave outright, which may overcommit the
    /// processors on purpose: requests then hold only in proportion.
    #[must_use]
    pub fn stated(mut self) -> Self {
        self.stated = true;
        self
    }

    /// The millicores the host would guarantee, before the hierarchy says
    /// what it can.
    #[must_use]
    pub const fn budget(&self) -> u64 {
        self.budget
    }

    /// The VMs' group.
    #[must_use]
    pub fn cgroup(&self) -> &Path {
        &self.cgroup
    }

    /// Reads the hierarchy, sets the VMs' group's weight to what covers
    /// the budget and returns what the host can guarantee with it. Blocks.
    pub fn apply(&self) -> io::Result<Share> {
        let levels = levels(&self.cgroup)?;
        let mut share =
            share(&levels, processor_millis(&self.cgroup), self.budget).ok_or_else(|| {
                io::Error::other(format!(
                    "the processor controller does not reach {}",
                    self.cgroup.display()
                ))
            })?;
        if self.stated {
            share.capacity = self.budget;
        }
        compute_engine::cgroup::Cgroup::at(&self.cgroup).set_cpu_weight(share.weight)?;
        Ok(share)
    }
}

/// The processors VMs in `cgroup` may run on: those its nearest group, or
/// the nearest above it, lists in `cpuset.cpus.effective`, otherwise those
/// this process may use. Blocks.
#[must_use]
pub fn processors(cgroup: &Path) -> usize {
    cgroup
        .ancestors()
        .find_map(|dir| {
            let text = fs::read_to_string(dir.join("cpuset.cpus.effective")).ok()?;
            count_cpus(&text).filter(|count| *count > 0)
        })
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, NonZeroUsize::get))
}

fn processor_millis(cgroup: &Path) -> u64 {
    u64::try_from(processors(cgroup))
        .unwrap_or(u64::MAX)
        .saturating_mul(1000)
}

/// How many processors a cpu list such as `0-3,6,8-9` names.
fn count_cpus(list: &str) -> Option<usize> {
    let mut count = 0;
    for range in list.trim().split(',').filter(|range| !range.is_empty()) {
        let (start, end) = range.split_once('-').unwrap_or((range, range));
        let (start, end) = (start.parse::<usize>().ok()?, end.parse::<usize>().ok()?);
        count += end.checked_sub(start)? + 1;
    }
    Some(count)
}

/// One group on the way from the root down to the VMs' group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Level {
    /// Its `cpu.weight`.
    weight: u64,
    /// The sum of the `cpu.weight`s of the groups beside it that hold
    /// processes, in them or below.
    siblings: u64,
    /// Millicores its `cpu.max` allows, if it caps them.
    quota: Option<u64>,
}

/// The groups from the one below the root down to `cgroup`. The root has
/// no `cpu.weight`: it shares with no group beside it. Blocks.
fn levels(cgroup: &Path) -> io::Result<Vec<Level>> {
    let mut levels = Vec::new();
    for dir in cgroup.ancestors() {
        let weight = match fs::read_to_string(dir.join("cpu.weight")) {
            Ok(text) => text.trim().parse().unwrap_or(100),
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        };
        levels.push(Level {
            weight,
            siblings: sibling_weights(dir)?,
            quota: quota(dir)?,
        });
    }
    levels.reverse();
    Ok(levels)
}

/// The sum of the `cpu.weight` of every group beside `cgroup` that holds
/// processes, in it or below it.
fn sibling_weights(cgroup: &Path) -> io::Result<u64> {
    let (Some(parent), Some(own)) = (cgroup.parent(), cgroup.file_name()) else {
        return Ok(0);
    };
    let mut sum = 0;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        if entry.file_name() == own || !entry.file_type()?.is_dir() {
            continue;
        }
        // Gone since it was listed, like one that never held a process.
        let events = match fs::read_to_string(entry.path().join("cgroup.events")) {
            Ok(events) => events,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !events.lines().any(|line| line.trim() == "populated 1") {
            continue;
        }
        match fs::read_to_string(entry.path().join("cpu.weight")) {
            Ok(text) => sum += text.trim().parse::<u64>().unwrap_or(100),
            // Not a group the processor controller reaches.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(sum)
}

/// The millicores the `cpu.max` of `cgroup` allows, if it caps them.
fn quota(cgroup: &Path) -> io::Result<Option<u64>> {
    let text = match fs::read_to_string(cgroup.join("cpu.max")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut fields = text.split_whitespace();
    let quota = fields.next().and_then(|quota| quota.parse::<u64>().ok());
    let period = fields
        .next()
        .and_then(|period| period.parse::<u64>().ok())
        .filter(|period| *period > 0);
    Ok(quota
        .zip(period)
        .map(|(quota, period)| quota.saturating_mul(1000) / period))
}

/// What `levels`, the last the VMs' group, give the VMs of `processors`
/// millicores, with the VMs' group weighing enough for `budget` if any
/// weight is; `None` without levels.
fn share(levels: &[Level], processors: u64, budget: u64) -> Option<Share> {
    let (vms, above) = levels.split_last()?;
    let parent = above.iter().fold(processors, |capacity, level| {
        capped(part(capacity, level.weight, level.siblings), level.quota)
    });
    let reachable = capped(parent, vms.quota);
    let weight = weight_for(vms.siblings, parent, budget.min(reachable));
    let gets = capped(part(parent, u64::from(weight), vms.siblings), vms.quota);
    Some(Share {
        weight,
        capacity: budget.min(gets) / 10 * 10,
        gets,
        processors,
    })
}

fn capped(millis: u64, quota: Option<u64>) -> u64 {
    quota.map_or(millis, |quota| millis.min(quota))
}

/// What a group weighing `weight` gets of `capacity` against busy groups
/// beside it weighing `siblings`.
fn part(capacity: u64, weight: u64, siblings: u64) -> u64 {
    if siblings == 0 {
        return capacity;
    }
    let part =
        u128::from(capacity) * u128::from(weight) / (u128::from(weight) + u128::from(siblings));
    u64::try_from(part).unwrap_or(u64::MAX)
}

/// The least `cpu.weight` that gets a group `wanted` millicores of
/// `capacity` against busy groups beside it weighing `siblings`, or the
/// most there is, 10000, when none does.
fn weight_for(siblings: u64, capacity: u64, wanted: u64) -> u16 {
    if siblings == 0 {
        return 100;
    }
    let Some(left) = capacity.checked_sub(wanted).filter(|left| *left > 0) else {
        return 10_000;
    };
    // weight / (weight + siblings) >= wanted / capacity
    let needed = (u128::from(siblings) * u128::from(wanted)).div_ceil(u128::from(left));
    u16::try_from(needed.clamp(1, 10_000)).unwrap_or(10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(weight: u64, siblings: u64) -> Level {
        Level {
            weight,
            siblings,
            quota: None,
        }
    }

    /// The VMs' group, at the root's level, outweighs every busy group
    /// beside it by what it was promised against what is kept back.
    #[test]
    fn the_vm_group_weighs_enough_to_get_its_budget() {
        // 8 processors, 7.5 promised: 0.5 kept back. Beside three groups
        // of 100: 300 * 7500 / 500.
        let share = share(&[level(100, 300)], 8000, 7500).unwrap();
        assert_eq!(share.weight, 4500);
        assert_eq!(share.capacity, 7500);
        assert!(share.whole(7500));
        for (siblings, processors, budget) in [(100, 8, 7360), (300, 16, 15_000), (250, 3, 2100)] {
            let share = share_of(&[level(100, siblings)], processors * 1000, budget);
            assert_eq!(share.capacity, budget, "{siblings} {processors} {budget}");
            let gets = part(processors * 1000, u64::from(share.weight), siblings);
            assert!(gets >= budget, "{gets} < {budget}");
        }
        // Nothing beside it: any weight is enough.
        assert_eq!(share_of(&[level(100, 0)], 8000, 7500).weight, 100);
    }

    fn share_of(levels: &[Level], processors: u64, budget: u64) -> Share {
        share(levels, processors, budget).unwrap()
    }

    /// When no weight covers the budget, the host guarantees what the
    /// most weight gets.
    #[test]
    fn a_budget_no_weight_covers_is_lowered_to_what_the_most_gets() {
        // A group of 10000 beside it: the most it gets is half.
        let share = share_of(&[level(100, 10_000)], 8000, 7500);
        assert_eq!(share.weight, 10_000);
        assert_eq!(share.capacity, 4000);
        assert!(!share.whole(7500));
        // Promised every processor: something beside it always takes some.
        let share = share_of(&[level(100, 100)], 8000, 8000);
        assert_eq!((share.weight, share.capacity), (10_000, 7920));
    }

    /// A group above the VMs' shares too, with its own weight, which the
    /// host leaves alone, and what it gets is all the VMs' group can.
    #[test]
    fn a_group_above_the_vms_lowers_what_they_get() {
        // Below a group of 100 beside two of 100, which gets a third.
        let levels = [level(100, 200), level(100, 0)];
        let share = share_of(&levels, 9000, 7500);
        assert_eq!(share.capacity, 3000);
        // With a group beside the VMs' inside it too.
        let levels = [level(100, 200), level(100, 100)];
        let share = share_of(&levels, 9000, 7500);
        assert_eq!(share.weight, 10_000);
        assert_eq!(share.capacity, 2970);
        // Above alone in its level, it changes nothing.
        let levels = [level(100, 0), level(100, 300)];
        assert_eq!(share_of(&levels, 8000, 7500).capacity, 7500);
    }

    /// A `cpu.max` on the VMs' group or above caps what they get.
    #[test]
    fn a_quota_caps_what_the_vms_get() {
        let capped_vms = Level {
            quota: Some(4000),
            ..level(100, 300)
        };
        let share = share_of(&[capped_vms], 8000, 7500);
        assert_eq!(share.capacity, 4000);
        // The weight covers what it can get.
        assert_eq!(share.weight, weight_for(300, 8000, 4000));
        let capped_above = Level {
            quota: Some(2500),
            ..level(100, 0)
        };
        assert_eq!(
            share_of(&[capped_above, level(100, 0)], 8000, 7500).capacity,
            2500
        );
    }

    /// Less than the smallest request guarantees nothing: no minimum is
    /// made up.
    #[test]
    fn less_than_the_smallest_request_guarantees_none() {
        let starved = Level {
            quota: Some(1),
            ..level(100, 300)
        };
        let share = share_of(&[starved], 8000, 7500);
        assert_eq!((share.gets, share.capacity), (1, 0));
        let starved = Level {
            quota: Some(19),
            ..level(100, 0)
        };
        assert_eq!(share_of(&[starved], 8000, 7500).capacity, 10);
    }

    #[test]
    fn cpu_lists_are_counted() {
        assert_eq!(count_cpus("0-7\n"), Some(8));
        assert_eq!(count_cpus("0-3,6,8-9"), Some(7));
        assert_eq!(count_cpus("5"), Some(1));
        assert_eq!(count_cpus(""), Some(0));
        assert_eq!(count_cpus("3-1"), None);
        assert_eq!(count_cpus("x"), None);
    }

    /// A tree of groups as the kernel shows them.
    struct Tree(tempfile::TempDir);

    impl Tree {
        fn new() -> Self {
            let tree = Self(tempfile::tempdir().unwrap());
            fs::write(tree.0.path().join("cpuset.cpus.effective"), "0-7\n").unwrap();
            tree
        }

        fn group(&self, path: &str, weight: u64, populated: bool) -> PathBuf {
            let dir = self.0.path().join(path);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("cpu.weight"), format!("{weight}\n")).unwrap();
            fs::write(dir.join("cpu.max"), "max 100000\n").unwrap();
            fs::write(
                dir.join("cgroup.events"),
                format!("populated {}\nfrozen 0\n", u8::from(populated)),
            )
            .unwrap();
            dir
        }
    }

    /// Read from the files, sibling groups that hold processes count,
    /// empty ones do not, and the weight is set.
    #[test]
    fn the_hierarchy_is_read_from_its_files_and_the_weight_set() {
        let tree = Tree::new();
        let vms = tree.group("compute", 100, true);
        tree.group("system.slice", 100, true);
        tree.group("user.slice", 100, true);
        tree.group("init.scope", 100, true);
        tree.group("dev-hugepages.mount", 100, false);
        let share = ProcessorShare::new(vms.clone(), 7500);
        assert_eq!(share.apply().unwrap().weight, 4500);
        assert_eq!(fs::read_to_string(vms.join("cpu.weight")).unwrap(), "4500");
        // Someone starts a group of 10000 beside it: the most it gets is
        // 8000 * 10000 / (10000 + 10300).
        tree.group("greedy.slice", 10_000, true);
        let lowered = share.apply().unwrap();
        assert_eq!((lowered.weight, lowered.capacity), (10_000, 3940));
        // Gone again: all of it.
        fs::write(
            tree.0.path().join("greedy.slice/cgroup.events"),
            "populated 0\n",
        )
        .unwrap();
        assert_eq!(share.apply().unwrap().capacity, 7500);
        // A quota above the VMs, nested one level down.
        let nested = tree.group("compute/vms", 100, true);
        fs::write(tree.0.path().join("compute/cpu.max"), "300000 100000\n").unwrap();
        let share = ProcessorShare::new(nested, 7500).apply().unwrap();
        assert_eq!(share.capacity, 3000);
        assert_eq!(share.processors, 8000);
    }

    /// A group the processor controller does not reach has no share.
    #[test]
    fn no_share_without_the_processor_controller() {
        let tree = Tree::new();
        let dir = tree.0.path().join("plain");
        fs::create_dir_all(&dir).unwrap();
        assert!(ProcessorShare::new(dir, 1000).apply().is_err());
    }

    /// A budget given outright is kept, even above what the group gets.
    #[test]
    fn a_stated_budget_is_kept() {
        let tree = Tree::new();
        let vms = tree.group("compute", 100, true);
        tree.group("system.slice", 100, true);
        let share = ProcessorShare::new(vms, 32_000).stated().apply().unwrap();
        assert_eq!(share.capacity, 32_000);
        assert_eq!(share.weight, 10_000);
        assert!(!share.whole(32_000));
    }

    #[test]
    fn processors_come_from_the_nearest_cpuset() {
        let tree = Tree::new();
        let vms = tree.group("compute", 100, true);
        assert_eq!(processors(&vms), 8);
        fs::write(vms.join("cpuset.cpus.effective"), "2-3\n").unwrap();
        assert_eq!(processors(&vms), 2);
    }
}
