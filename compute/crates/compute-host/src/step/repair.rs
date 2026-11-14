//! Repairing a sandbox's file system before it boots fresh (ADR 43).
//!
//! A fresh boot is the moment no VM has the disk open and no memory image
//! depends on it, so it is when the host can safely repair what the
//! guest's kernel recorded as damaged. The superblock is read on every
//! fresh boot, which costs one kilobyte; `e2fsck` runs only when it
//! records errors (see [`compute_engine::repair`]). Whatever the repair
//! does, the boot goes on: a guest runs on with errors, and the next fresh
//! boot tries again.

use compute_engine::repair::{self, Recorded, Repair};

use crate::layout::Paths;
use crate::observe::notes;
use crate::observe::{Event, Severity};

/// Repairs the disk at `paths` if its superblock records errors, running
/// `e2fsck` as `uid`/`gid`, the VM's user, and notes what it did as a
/// `compute.disk.repair` event of the step.
pub(super) async fn repair_disk(paths: &Paths, uid: u32, gid: u32) {
    let disk = paths.disk.clone();
    let checked = super::blocking(move || repair::check(&disk, uid, gid))
        .await
        .and_then(|checked| checked);
    match checked {
        Ok(None) => {}
        Ok(Some(repair)) => {
            notes::phase("repair");
            if repair.repaired() {
                tracing::warn!(
                    errors = repair.before.error_count,
                    fixes = repair.fixes,
                    "repaired the file system of a sandbox's disk"
                );
            } else {
                tracing::error!(
                    errors = repair.before.error_count,
                    exit = ?repair.exit,
                    "a sandbox's file system still has errors after e2fsck"
                );
            }
            notes::event(repaired(&repair));
        }
        Err(error) => {
            notes::phase("repair");
            tracing::error!(%error, "could not check or repair a sandbox's file system");
            notes::event(
                Event::new("compute.disk.repair", Severity::Warn)
                    .with("compute.disk.repair", "failed")
                    .with("compute.error", error.to_string()),
            );
        }
    }
}

/// The event of a repair that ran: what the superblock recorded, what
/// `e2fsck` fixed and said, and what is left.
fn repaired(repair: &Repair) -> Event {
    let before = &repair.before;
    let mut event = Event::new("compute.disk.repair", Severity::Warn)
        .with(
            "compute.disk.repair",
            if repair.repaired() {
                "repaired"
            } else {
                "unrepaired"
            },
        )
        .with("compute.disk.errors", before.error_count)
        .with("compute.disk.marked_errors", before.has_errors)
        .with("compute.disk.bad_checksum", before.bad_checksum)
        .with("compute.disk.fixes", repair.fixes)
        .with("compute.disk.fsck_output", repair.output.clone())
        .with("compute.duration_us", repair.took)
        .with_some(
            "compute.disk.fsck_exit",
            repair
                .exit
                .map(|code| u32::try_from(code).unwrap_or(u32::MAX)),
        )
        .with_some(
            "compute.disk.errors_after",
            repair.after.as_ref().map(|after| after.error_count),
        );
    for (which, recorded) in [("first", &before.first), ("last", &before.last)] {
        if let Some(recorded) = recorded {
            event = with_error(event, which, recorded);
        }
    }
    event
}

fn with_error(event: Event, which: &str, recorded: &Recorded) -> Event {
    event
        .with(
            format!("compute.disk.{which}_error_unix_s"),
            recorded.unix_seconds,
        )
        .with(
            format!("compute.disk.{which}_error_function"),
            format!("{}:{}", recorded.function, recorded.line),
        )
        .with(format!("compute.disk.{which}_error_code"), recorded.code)
        .with(format!("compute.disk.{which}_error_inode"), recorded.inode)
}
