//! The wake order a VM's pager learned, taken into the sandbox's own files.
//!
//! A pager runs as its VM's user and writes in a directory of its own (see
//! [`compute_engine::PagerSpec::dir`]), so the agent trusts what it finds
//! there no more than what a VM wrote: it reads only a regular file of one
//! name, never through a link, of bounded size, and keeps a copy of its own
//! only of a profile that fits the memory it describes. Anything else is
//! dropped with a warning: a learned profile only makes wakes faster, and
//! never stops one or an archive.

use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::Path;

use crate::layout::{remove_if_present, write_atomic};
use crate::working_set::WakeProfile;

/// Largest learned profile read: several times the most pages a profile
/// keeps, written out as numbers.
const MOST: u64 = 4 << 20;

/// Makes the pager's directory `dir` if it is missing, open to its owner
/// alone; the engine gives it to the VM's user.
pub(super) fn make_dir(dir: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => Ok(()),
    }
}

/// Moves the profile a pager wrote at `learned` to `profile`, the copy the
/// agent keeps and archives, if it fits memory of `memory_len` bytes (none:
/// there is no memory image for it to describe); drops it either way. Best
/// effort: a profile is only a hint, so what goes wrong here is logged and
/// never fails the wake or archive taking it.
pub(super) fn take(learned: &Path, profile: &Path, memory_len: Option<u64>) {
    let bytes = match read_untrusted(learned) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(%error, path = %learned.display(), "learned profile ignored");
            discard(learned);
            return;
        }
    };
    let parsed = WakeProfile::parse(&bytes);
    if memory_len.is_some_and(|len| parsed.fits(len)) {
        let kept = serde_json::to_vec(&parsed)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomic(profile, &bytes));
        if let Err(error) = kept {
            tracing::warn!(%error, path = %profile.display(), "learned profile not kept");
        }
    } else {
        tracing::warn!(path = %learned.display(), "learned profile does not fit the memory; ignored");
    }
    discard(learned);
}

/// Removes whatever a pager left at `learned`, a file or not, without
/// following a link; a failure is only logged.
fn discard(learned: &Path) {
    let removed = match fs::symlink_metadata(learned) {
        // Removing a tree never follows a link inside it.
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(learned),
        _ => remove_if_present(learned),
    };
    if let Err(error) = removed {
        tracing::warn!(%error, path = %learned.display(), "could not remove a learned profile");
    }
}

/// Reads the regular file at `path`, if it has no other name and holds at
/// most [`MOST`] bytes, without following a link there or waiting on
/// anything that is not a file.
fn read_untrusted(path: &Path) -> io::Result<Vec<u8>> {
    use rustix::fs::{Mode, OFlags};

    let fd = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let file = File::from(fd);
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() != 1 || metadata.len() > MOST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular file of one name and bounded size",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MOST + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MOST {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too large"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEN: Option<u64> = Some(1 << 20);

    fn profile(offsets: Vec<u64>) -> WakeProfile {
        WakeProfile {
            version: 1,
            offsets,
            page_size: 4096,
        }
    }

    #[test]
    fn a_valid_profile_is_taken_and_anything_else_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (learned, kept) = (
            dir.path().join("learned.json"),
            dir.path().join("wake.json"),
        );
        take(&learned, &kept, LEN);
        assert!(!kept.exists(), "nothing learned, nothing kept");

        fs::write(
            &learned,
            serde_json::to_vec(&profile(vec![0, 4096])).unwrap(),
        )
        .unwrap();
        take(&learned, &kept, LEN);
        assert_eq!(WakeProfile::load(&kept), profile(vec![0, 4096]));
        assert!(!learned.exists());

        // Garbage, and pages the memory does not have, leave the kept
        // profile as it was.
        let outside = serde_json::to_vec(&profile(vec![u64::MAX])).unwrap();
        for (bytes, memory) in [
            (&b"{not json"[..], LEN),
            (&outside[..], LEN),
            (&serde_json::to_vec(&profile(vec![0])).unwrap()[..], None),
        ] {
            fs::write(&learned, bytes).unwrap();
            take(&learned, &kept, memory);
            assert_eq!(WakeProfile::load(&kept), profile(vec![0, 4096]));
            assert!(!learned.exists());
        }
    }

    #[test]
    fn links_and_other_names_are_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let (learned, kept) = (
            dir.path().join("learned.json"),
            dir.path().join("wake.json"),
        );
        let host = dir.path().join("host-file");
        fs::write(&host, serde_json::to_vec(&profile(vec![8192])).unwrap()).unwrap();

        std::os::unix::fs::symlink(&host, &learned).unwrap();
        take(&learned, &kept, LEN);
        assert!(!kept.exists(), "read through a link");
        assert!(!learned.exists() && host.exists());

        fs::hard_link(&host, &learned).unwrap();
        take(&learned, &kept, LEN);
        assert!(!kept.exists(), "read a host file's second name");
        assert!(host.exists());

        let large = File::create(&learned).unwrap();
        large.set_len(MOST + 1).unwrap();
        take(&learned, &kept, LEN);
        assert!(!kept.exists(), "read a file without bound");
        assert!(!learned.exists());

        // A directory in its place, with a link out of it, goes without
        // touching what the link names.
        fs::create_dir(&learned).unwrap();
        std::os::unix::fs::symlink(&host, learned.join("inner")).unwrap();
        take(&learned, &kept, LEN);
        assert!(!kept.exists() && !learned.exists() && host.exists());

        // A profile that cannot be kept is only logged.
        fs::write(&learned, serde_json::to_vec(&profile(vec![0])).unwrap()).unwrap();
        take(&learned, &dir.path().join("missing").join("wake.json"), LEN);
        assert!(!learned.exists());
    }
}
