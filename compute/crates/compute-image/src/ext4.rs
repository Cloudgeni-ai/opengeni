//! Turning an assembled root into an ext4 file system image.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::process::Command;

use anyhow::{Context as _, Result, ensure};

const BLOCK: u64 = 4096;
const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;

/// Room an image leaves for what its sandboxes add, by default. Untouched
/// space costs nothing: the file is sparse and stored copies skip zeros.
pub const DEFAULT_FREE: u64 = 4 * GIB;
/// The smallest file system made, the lab image's size.
pub const MIN_SIZE: u64 = 6 * GIB;

/// What is in a root: the blocks its files take and how many inodes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Contents {
    pub bytes: u64,
    pub inodes: u64,
}

/// Measures `root`, counting each hard-linked file once.
pub fn measure(root: &Path) -> io::Result<Contents> {
    let mut seen = HashSet::new();
    let mut contents = Contents::default();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if !seen.insert((meta.dev(), meta.ino())) {
                continue;
            }
            contents.inodes += 1;
            contents.bytes += meta.len().div_ceil(BLOCK) * BLOCK;
            if meta.is_dir() {
                contents.bytes += BLOCK;
                pending.push(entry.path());
            }
        }
    }
    Ok(contents)
}

/// The size of file system that holds `contents` with `free` bytes to
/// spare: the contents and their inodes, an eighth more for the file
/// system's own metadata and journal, and `free`, in whole MiB.
#[must_use]
pub fn size_for(contents: Contents, free: u64) -> u64 {
    let used = contents.bytes + contents.inodes * 256;
    let size = (used + used / 8 + 256 * MIB + free).max(MIN_SIZE);
    size.div_ceil(MIB) * MIB
}

/// Inodes for `contents` in a file system of `size`: ext4's default of
/// one per 16 KiB, but never fewer than twice what the contents use.
#[must_use]
pub fn inodes_for(contents: Contents, size: u64) -> u64 {
    (size / (16 * 1024)).max(contents.inodes * 2)
}

/// Makes `output`, an ext4 image of `root` with `free` bytes to spare.
/// Returns its size. Each is a new file system, with a random UUID, so no
/// two images made are the same bytes: the control service relies on no
/// disk being captured with a build's bytes before that build is
/// recorded (ADR 22).
pub fn make(root: &Path, output: &Path, free: u64) -> Result<u64> {
    let contents = measure(root)?;
    let size = size_for(contents, free);
    let _ = fs::remove_file(output);
    fs::File::create(output)?.set_len(size)?;
    let status = Command::new("mkfs.ext4")
        .args(["-q", "-F", "-L", "opengeni", "-U", "random", "-N"])
        .arg(inodes_for(contents, size).to_string())
        .arg("-d")
        .arg(root)
        .arg(output)
        .status()
        .context("run mkfs.ext4 (e2fsprogs)")?;
    ensure!(status.success(), "mkfs.ext4 failed: {status}");
    Ok(size)
}

/// Makes `output` hold `root` by changing a copy of the image `before`
/// (one built earlier, usually from an earlier version of the same OCI
/// image) rather than writing a new file system: what did not change
/// keeps its place in the file, so the two images share every chunk but
/// those of what changed, and a host or store holding `before` needs only
/// those (ADR 40). A new file system lays every file out anew, so even a
/// release that changes a few files moves most of the rest.
///
/// The copy grows to at least what [`make`] would make, never shrinks,
/// and gets a new random UUID, so, as with [`make`], no two images are the
/// same bytes. The copy is mounted (loop, as root) under `work`, `root` is
/// copied over it with `rsync`, which leaves files whose contents match
/// alone, and what is freed is discarded, so the file keeps no deleted
/// bytes. Returns the image's size.
///
/// # Errors
///
/// When any step fails, including a copy that does not fit (too few
/// inodes): the caller then makes the image anew with [`make`].
pub fn update(before: &Path, root: &Path, output: &Path, free: u64, work: &Path) -> Result<u64> {
    let contents = measure(root)?;
    let _ = fs::remove_file(output);
    copy_sparse(before, output).context("copy the earlier image")?;
    let size = size_for(contents, free).max(fs::metadata(output)?.len());
    fs::File::options()
        .write(true)
        .open(output)?
        .set_len(size)?;
    run(Command::new("resize2fs").arg("-f").arg(output), "resize2fs")?;
    let mount = work.join("mnt");
    fs::create_dir_all(&mount)?;
    run(
        Command::new("mount")
            // Leaves inode tables never used unwritten, as `mkfs.ext4`
            // left them, rather than filling the file with their zeros.
            .args(["-t", "ext4", "-o", "loop,nosuid,nodev,noexec,noinit_itable"])
            .arg(output)
            .arg(&mount),
        "mount",
    )?;
    let mounted = Mounted(&mount);
    let mut source = root.as_os_str().to_owned();
    source.push("/");
    run(
        Command::new("rsync")
            .args([
                "--archive",
                "--hard-links",
                "--acls",
                "--xattrs",
                "--numeric-ids",
                "--checksum",
                "--delete",
                "--exclude=/lost+found",
            ])
            .arg(&source)
            .arg(&mount),
        "rsync",
    )?;
    run(Command::new("fstrim").arg(&mount), "fstrim")?;
    mounted.unmount()?;
    run(
        Command::new("e2fsck").args(["-f", "-n"]).arg(output),
        "e2fsck",
    )?;
    run(
        Command::new("tune2fs").args(["-U", "random"]).arg(output),
        "tune2fs",
    )?;
    Ok(size)
}

/// Copies `from` to a new file `to`: sharing its blocks where the file
/// system can (XFS, btrfs), otherwise only its data, so holes stay holes.
fn copy_sparse(from: &Path, to: &Path) -> io::Result<()> {
    use rustix::fs::SeekFrom;
    let source = fs::File::open(from)?;
    let target = fs::File::create(to)?;
    if rustix::fs::ioctl_ficlone(&target, &source).is_ok() {
        return Ok(());
    }
    let len = source.metadata()?.len();
    target.set_len(len)?;
    let mut at = 0;
    while at < len {
        let Ok(start) = rustix::fs::seek(&source, SeekFrom::Data(at)) else {
            break;
        };
        let end = rustix::fs::seek(&source, SeekFrom::Hole(start)).unwrap_or(len);
        let (mut from_at, mut to_at) = (start, start);
        while from_at < end {
            let left = usize::try_from(end - from_at).unwrap_or(usize::MAX);
            let copied = rustix::fs::copy_file_range(
                &source,
                Some(&mut from_at),
                &target,
                Some(&mut to_at),
                left,
            )?;
            if copied == 0 {
                return Err(io::Error::other("the earlier image ended early"));
            }
        }
        at = end;
    }
    target.sync_all()
}

/// Runs `command` quietly; fails, with what it wrote, unless it succeeds.
fn run(command: &mut Command, what: &str) -> Result<()> {
    let output = command.output().with_context(|| format!("run {what}"))?;
    ensure!(
        output.status.success(),
        "{what} failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

/// A mount point, unmounted when dropped unless [`Mounted::unmount`] did.
struct Mounted<'a>(&'a Path);

impl Mounted<'_> {
    fn unmount(self) -> Result<()> {
        let path = self.0;
        std::mem::forget(self);
        run(Command::new("umount").arg(path), "umount")
    }
}

impl Drop for Mounted<'_> {
    fn drop(&mut self) {
        let _ = Command::new("umount").arg(self.0).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_images_of_one_root_are_different_bytes() {
        use std::io::Read as _;

        // The superblock, which holds the UUID, is in the first block.
        let start = |path: &Path| {
            let mut block = vec![0; 4096];
            fs::File::open(path)
                .unwrap()
                .read_exact(&mut block)
                .unwrap();
            block
        };
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), "contents").unwrap();
        let (first, second) = (dir.path().join("first"), dir.path().join("second"));
        make(&root, &first, 0).unwrap();
        make(&root, &second, 0).unwrap();
        assert_ne!(start(&first), start(&second));
    }

    #[test]
    fn sizes_cover_contents_metadata_and_free_space() {
        let small = Contents {
            bytes: 10 * MIB,
            inodes: 100,
        };
        assert_eq!(size_for(small, DEFAULT_FREE), MIN_SIZE);
        let big = Contents {
            bytes: 8 * GIB,
            inodes: 200_000,
        };
        let size = size_for(big, DEFAULT_FREE);
        assert!(size >= 8 * GIB + GIB + DEFAULT_FREE, "{size}");
        assert_eq!(size % MIB, 0);
        assert_eq!(inodes_for(big, size), size / (16 * 1024));
        let many = Contents {
            bytes: GIB,
            inodes: 1_000_000,
        };
        assert_eq!(inodes_for(many, MIN_SIZE), 2_000_000);
    }

    #[test]
    fn measures_blocks_and_counts_links_once() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        fs::write(dir.path().join("d/f"), vec![1; 5000]).unwrap();
        fs::hard_link(dir.path().join("d/f"), dir.path().join("g")).unwrap();
        std::os::unix::fs::symlink("d/f", dir.path().join("s")).unwrap();
        let contents = measure(dir.path()).unwrap();
        assert_eq!(contents.inodes, 3);
        // The directory (its own block and one more), the file, the symlink.
        assert_eq!(contents.bytes, 2 * BLOCK + 2 * BLOCK + BLOCK);
    }

    /// Each 256 KiB chunk of `path`: a digest of it, and its first bytes,
    /// or nothing for a chunk with no data (a hole).
    fn chunks(path: &Path) -> Vec<Option<(Vec<u8>, Vec<u8>)>> {
        use rustix::fs::SeekFrom;
        use sha2::Digest as _;
        use std::os::unix::fs::FileExt as _;
        const CHUNK: u64 = 256 << 10;
        let file = fs::File::open(path).unwrap();
        let len = file.metadata().unwrap().len();
        let mut chunk = vec![0; usize::try_from(CHUNK).unwrap()];
        (0..len.div_ceil(CHUNK))
            .map(|index| {
                let start = index * CHUNK;
                let data = rustix::fs::seek(&file, SeekFrom::Data(start)).unwrap_or(len);
                if data >= start + CHUNK {
                    return None;
                }
                let end = (start + CHUNK).min(len);
                let read = &mut chunk[..usize::try_from(end - start).unwrap()];
                file.read_exact_at(read, start).unwrap();
                Some((sha2::Sha256::digest(&*read).to_vec(), read[..64].to_vec()))
            })
            .collect()
    }

    /// Whether this test may loop-mount: only as root, with the tools.
    fn can_mount() -> bool {
        rustix::process::geteuid().is_root()
            && ["rsync", "mount", "fstrim", "resize2fs"]
                .iter()
                .all(|tool| {
                    Command::new("sh")
                        .args(["-c", &format!("command -v {tool}")])
                        .output()
                        .is_ok_and(|output| output.status.success())
                })
    }

    #[test]
    fn an_update_leaves_what_did_not_change_where_it_was() {
        use std::os::unix::fs::MetadataExt as _;

        if !can_mount() {
            eprintln!("skipped: needs root, mount and rsync");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(root.join("usr/lib")).unwrap();
        fs::create_dir_all(root.join("opt/app")).unwrap();
        // Data no two chunks share: 8 MiB that stays, then a program that
        // changes and one that goes.
        let kept: Vec<u8> = (0..8u32 << 20)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13).to_le_bytes()[0])
            .collect();
        fs::write(root.join("usr/lib/kept.so"), &kept).unwrap();
        fs::write(root.join("opt/app/program"), vec![1; 3 << 20]).unwrap();
        fs::write(root.join("opt/app/gone"), vec![2; 1 << 20]).unwrap();
        let before = dir.path().join("before.ext4");
        make(&root, &before, 0).unwrap();

        // The next release: the program changed, one file gone, one new.
        fs::write(root.join("opt/app/program"), vec![3; 3 << 20]).unwrap();
        fs::remove_file(root.join("opt/app/gone")).unwrap();
        fs::write(root.join("opt/app/new"), vec![4; 1 << 20]).unwrap();
        let (updated, fresh) = (
            dir.path().join("updated.ext4"),
            dir.path().join("fresh.ext4"),
        );
        let work = dir.path().join("work");
        update(&before, &root, &updated, 0, &work).unwrap();
        make(&root, &fresh, 0).unwrap();

        let old = chunks(&before);
        // Chunks of the file that stayed: no two alike, none of zeros.
        let pieces: HashSet<&[u8]> = kept.chunks(4096).map(|block| &block[..64]).collect();
        let kept_at: Vec<usize> = old
            .iter()
            .enumerate()
            .filter(|(_, chunk)| {
                chunk
                    .as_ref()
                    .is_some_and(|(_, head)| pieces.contains(head.as_slice()))
            })
            .map(|(index, _)| index)
            .collect();
        assert!(kept_at.len() >= 31, "{}", kept_at.len());
        // Every one of them is where it was.
        let new = chunks(&updated);
        assert!(kept_at.iter().all(|index| new[*index] == old[*index]));
        // The new file system is a different file: a different UUID.
        assert_ne!(new[0], old[0]);

        // It holds the new tree, and nothing deleted.
        let mount = work.join("check");
        fs::create_dir_all(&mount).unwrap();
        run(
            Command::new("mount")
                .args(["-o", "loop,ro"])
                .arg(&updated)
                .arg(&mount),
            "mount",
        )
        .unwrap();
        let mounted = Mounted(&mount);
        assert_eq!(fs::read(mount.join("usr/lib/kept.so")).unwrap(), kept);
        assert_eq!(
            fs::read(mount.join("opt/app/program")).unwrap(),
            vec![3; 3 << 20]
        );
        assert_eq!(
            fs::read(mount.join("opt/app/new")).unwrap(),
            vec![4; 1 << 20]
        );
        assert!(!mount.join("opt/app/gone").exists());
        assert!(mount.join("lost+found").is_dir());
        mounted.unmount().unwrap();
        // What was deleted takes no room in the file.
        let allocated = |path: &Path| fs::metadata(path).unwrap().blocks() * 512;
        assert!(
            allocated(&updated) <= allocated(&fresh) + (2 << 20),
            "{} vs {}",
            allocated(&updated),
            allocated(&fresh)
        );
    }
}
