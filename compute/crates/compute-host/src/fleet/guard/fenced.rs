//! The VMs the guard ended because they had not frozen by the time the
//! lease ran out, kept beside its lock so the agent says why they ended.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use compute_core::At;

use super::super::gate::{boot_now, nanos};

/// The VMs a guard ended because they had not frozen by the time the
/// lease ran out, kept beside its lock (see [`super::Freezes::fenced`]) so that
/// the agent can tell a VM the guard ended from one that ended on its own.
/// One line per VM: the name of its group and when the guard ended it, in
/// nanoseconds on the boot clock, newest last; `*` names every VM, as when
/// the guard could not tell them apart. The guard writes it before it
/// kills, so the agent never sees a VM end before it is recorded, and
/// keeps the latest [`Fenced::KEPT`].
#[derive(Clone, Debug)]
pub struct Fenced {
    path: PathBuf,
}

impl Fenced {
    /// How many of the latest VMs ended the record keeps.
    pub const KEPT: usize = 32;

    /// The record kept at `path`.
    pub(super) fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// Every VM recorded, with when the guard ended it, oldest first;
    /// nothing when there is no record or it cannot be read.
    #[must_use]
    pub fn read(&self) -> Vec<(String, At)> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let (name, at) = line.split_once(' ')?;
                let at = at.trim().parse::<u64>().ok()?;
                Some((name.to_owned(), At::from_duration(Duration::from_nanos(at))))
            })
            .collect()
    }

    /// Whether the guard recorded ending the VM whose group is `name` at
    /// `since` or later.
    #[must_use]
    pub fn ended(&self, name: &str, since: At) -> bool {
        self.read()
            .iter()
            .any(|(ended, at)| (ended == name || ended == "*") && *at >= since)
    }

    /// Records that the guard ends the VMs `names` now.
    pub(super) fn record(&self, names: &[String]) -> io::Result<()> {
        let now = boot_now();
        let mut kept = self.read();
        kept.extend(names.iter().map(|name| (name.clone(), now)));
        let skip = kept.len().saturating_sub(Self::KEPT);
        let mut text = String::new();
        for (name, at) in &kept[skip..] {
            text.push_str(name);
            text.push(' ');
            text.push_str(&nanos(*at).to_string());
            text.push('\n');
        }
        let staging = self.path.with_extension("fenced.staging");
        std::fs::write(&staging, text)?;
        std::fs::rename(&staging, &self.path)
    }
}

/// The guard's side of [`Fenced`]: the VMs it ended since the lease was
/// last valid, so each is recorded and logged once however many steps its
/// kill takes.
#[derive(Debug)]
pub(super) struct Fencing {
    fenced: Fenced,
    ended: std::collections::BTreeSet<String>,
}

impl Fencing {
    pub(super) fn new(fenced: Fenced) -> Self {
        Self {
            fenced,
            ended: std::collections::BTreeSet::new(),
        }
    }

    /// Records and logs the VMs of `names` it has not ended yet, `overdue`
    /// past the deadline: a loud, rare event, since it costs each its
    /// running programs.
    pub(super) fn ending(&mut self, names: Vec<String>, overdue: Duration) {
        let new: Vec<String> = names
            .into_iter()
            .filter(|name| !self.ended.contains(name))
            .collect();
        if new.is_empty() {
            return;
        }
        if let Err(error) = self.fenced.record(&new) {
            tracing::error!(%error, "the guard could not record the VMs it ends");
        }
        for name in new {
            tracing::error!(
                vm = %name,
                overdue_ms = u64::try_from(overdue.as_millis()).unwrap_or(u64::MAX),
                "the guard ends a VM that had not frozen by the time the host's lease ran out: its running programs are lost"
            );
            self.ended.insert(name);
        }
    }

    /// The lease is valid again: the kill episode is over, and a VM ended
    /// in the next is recorded again.
    pub(super) fn lease_valid(&mut self) {
        self.ended.clear();
    }
}
