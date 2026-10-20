//! The lease file: where the agent keeps its lease for the guard, and for
//! the agent's next run.
//!
//! It lives in `/run`, which a reboot empties: a rebooted host has no VMs
//! left and starts without a registration. It is replaced whole by a
//! rename, so a reader sees one version or the next, never a mix.

use std::io::{self, Write as _};
use std::path::Path;
use std::time::Duration;

use compute_core::At;
use compute_fleet::{HostEpoch, LeaseRecord};
use serde::{Deserialize, Serialize};

use super::gate::nanos;

/// What the file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseFile {
    /// The host id the service gave it, if it registered before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<u64>,
    /// The registration held.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// VMs may run strictly before this, in nanoseconds on the boot clock.
    pub deadline_ns: u64,
    /// The number of the last renewal sent under the registration.
    pub seq: u64,
}

impl LeaseFile {
    /// What a host that never registered keeps.
    pub const NONE: Self = Self {
        host: None,
        epoch: None,
        deadline_ns: 0,
        seq: 0,
    };

    /// The file for `record`, of host `host`.
    #[must_use]
    pub fn of(host: Option<u64>, record: LeaseRecord) -> Self {
        Self {
            host,
            epoch: record.epoch.map(|epoch| epoch.0),
            deadline_ns: nanos(record.deadline),
            seq: record.seq,
        }
    }

    /// The lease as the agent's [`compute_fleet::HostLease`] takes it.
    #[must_use]
    pub fn record(self) -> LeaseRecord {
        LeaseRecord {
            epoch: self.epoch.map(HostEpoch),
            deadline: self.deadline(),
            seq: self.seq,
        }
    }

    /// VMs may run strictly before this.
    #[must_use]
    pub fn deadline(self) -> At {
        At::from_duration(Duration::from_nanos(self.deadline_ns))
    }

    /// Reads the file at `path`: [`Self::NONE`] when there is none. One that
    /// cannot be read or parsed is an error, so the agent does not start
    /// over a registration it may still hold; the guard treats it as no
    /// lease.
    pub fn read(path: &Path) -> io::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::NONE),
            Err(error) => Err(error),
        }
    }

    /// Replaces the file at `path` with this, whole.
    pub fn write(self, path: &Path) -> io::Result<()> {
        let mut temporary = path.as_os_str().to_owned();
        temporary.push(".new");
        let temporary = Path::new(&temporary);
        let bytes = serde_json::to_vec(&self).map_err(io::Error::other)?;
        let mut file = std::fs::File::create(temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_round_trips_and_a_missing_one_holds_no_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.json");
        assert_eq!(LeaseFile::read(&path).unwrap(), LeaseFile::NONE);
        let record = LeaseRecord {
            epoch: Some(HostEpoch(4)),
            deadline: At::from_millis(12_345),
            seq: 7,
        };
        LeaseFile::of(Some(2), record).write(&path).unwrap();
        let read = LeaseFile::read(&path).unwrap();
        assert_eq!((read.host, read.record()), (Some(2), record));
        std::fs::write(&path, b"{").unwrap();
        assert!(
            LeaseFile::read(&path).is_err(),
            "a damaged file is no lease"
        );
    }
}
