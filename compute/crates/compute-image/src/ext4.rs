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
}
