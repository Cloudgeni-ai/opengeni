//! Applying an image's layers to a directory, lowest first.
//!
//! A layer is a tar of changes. A file named `.wh.<name>` (a whiteout)
//! deletes `<name>` from the layers below; `.wh..wh..opq` in a directory
//! (an opaque marker) hides everything the layers below had in it. Both
//! touch only lower layers, so each layer is read twice: once to apply its
//! deletions (and check its contents against the config's `diff_id`), and
//! once to add its entries. Anything a layer adds replaces what was at
//! its path, except that a directory over a directory keeps the contents.
//!
//! Owners, modes, extended attributes, times, hard links, symlinks and
//! device nodes are kept. Owners, device nodes and attributes outside the
//! `user.` namespace need root; without it they are skipped, which only
//! tests do.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;

use anyhow::{Context as _, Result, bail, ensure};
use rustix::fs::{AtFlags, CWD, Timespec, Timestamps};
use sha2::{Digest as _, Sha256};
use tar::{Archive, EntryType};

use crate::registry::{Compression, Layer};
use crate::rootpath::{self, clean, resolve};

const WHITEOUT: &str = ".wh.";
const OPAQUE: &str = ".wh..wh..opq";

/// What applying layers did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Applied {
    pub entries: u64,
    pub file_bytes: u64,
    pub deleted: u64,
    /// Owners, nodes or attributes skipped for want of root.
    pub skipped: u64,
}

/// A layer's contents, decompressed, from a file on disk or from memory.
pub trait Source {
    fn open(&self) -> io::Result<Box<dyn Read + '_>>;
    /// The digest its decompressed contents must have, if checked.
    fn diff_id(&self) -> Option<&str>;
}

impl Source for Layer {
    fn open(&self) -> io::Result<Box<dyn Read + '_>> {
        let file = io::BufReader::new(File::open(&self.path)?);
        Ok(match self.compression {
            Compression::None => Box::new(file),
            Compression::Gzip => Box::new(flate2::read::MultiGzDecoder::new(file)),
            Compression::Zstd => Box::new(zstd::Decoder::with_buffer(file)?),
        })
    }

    fn diff_id(&self) -> Option<&str> {
        Some(&self.diff_id)
    }
}

/// A plain tar in memory, unchecked: for tests.
impl Source for Vec<u8> {
    fn open(&self) -> io::Result<Box<dyn Read + '_>> {
        Ok(Box::new(self.as_slice()))
    }

    fn diff_id(&self) -> Option<&str> {
        None
    }
}

/// Applies `layers`, lowest first, to `root`.
pub fn apply_all<S: Source>(root: &Path, layers: &[S]) -> Result<Applied> {
    let privileged = rustix::process::geteuid().is_root();
    let mut applied = Applied::default();
    for (n, layer) in layers.iter().enumerate() {
        apply(root, layer, privileged, &mut applied).with_context(|| format!("layer {n}"))?;
    }
    Ok(applied)
}

/// Reads `reader` to its end through a SHA-256.
struct Hashing<R> {
    inner: R,
    hasher: Sha256,
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

/// A deletion a layer makes in the layers below.
enum Deletion {
    /// `.wh.<name>`: the path itself.
    Path(Vec<OsString>),
    /// `.wh..wh..opq`: everything in the directory.
    Contents(Vec<OsString>),
}

/// The deletion an entry at `parts` makes, if it is a whiteout.
///
/// # Errors
///
/// For a whiteout that names no entry: `.wh.`, `.wh..` or `.wh...`.
fn deletion(parts: &[OsString]) -> Result<Option<Deletion>> {
    let Some((name, parent)) = parts.split_last() else {
        return Ok(None);
    };
    let name = name.as_bytes();
    if name == OPAQUE.as_bytes() {
        return Ok(Some(Deletion::Contents(parent.to_vec())));
    }
    let Some(hidden) = name.strip_prefix(WHITEOUT.as_bytes()) else {
        return Ok(None);
    };
    ensure!(
        !hidden.is_empty() && hidden != b"." && hidden != b"..",
        "{}: a whiteout that names no entry",
        parts_display(parts)
    );
    let mut path = parent.to_vec();
    path.push(OsStr::from_bytes(hidden).to_owned());
    Ok(Some(Deletion::Path(path)))
}

fn apply(root: &Path, layer: &impl Source, privileged: bool, applied: &mut Applied) -> Result<()> {
    // Pass one: the deletions, and the digest of the whole stream.
    let mut hashing = Hashing {
        inner: layer.open()?,
        hasher: Sha256::new(),
    };
    let mut deletions = Vec::new();
    {
        let mut archive = Archive::new(&mut hashing);
        for entry in archive.entries()? {
            let entry = entry?;
            if let Some(deletion) = deletion(&clean(&entry.path()?)?)? {
                deletions.push(deletion);
            }
        }
    }
    io::copy(&mut hashing, &mut io::sink())?;
    if let Some(expected) = layer.diff_id() {
        let digest = format!("sha256:{:x}", hashing.hasher.finalize());
        ensure!(
            digest == expected,
            "contents are {digest}, the config says {expected}"
        );
    }
    for deletion in deletions {
        applied.deleted += delete(root, &deletion)?;
    }
    // Pass two: the entries.
    let mut dirs = Vec::new();
    let mut archive = Archive::new(layer.open()?);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let parts = clean(&entry.path()?)?;
        if parts.is_empty() {
            continue;
        }
        if deletion(&parts)?.is_some() {
            // The marker's directory exists in this layer.
            fs::create_dir_all(resolve(root, &parts[..parts.len() - 1])?)?;
            continue;
        }
        applied.entries += 1;
        if let Some(dir) = add(root, &parts, &mut entry, privileged, applied)? {
            dirs.push(dir);
        }
    }
    // Directories last, deepest first: adding into them changed their
    // times. Each is found again from the root and changed only if it is
    // still a directory: a later entry may have replaced it, with a
    // symlink to anywhere, say.
    for (parts, mode, mtime) in dirs.into_iter().rev() {
        rootpath::set_dir(&resolve(root, &parts)?, mode, Some(mtime), None)?;
    }
    Ok(())
}

/// Applies one deletion; returns how many top-level entries went.
fn delete(root: &Path, deletion: &Deletion) -> Result<u64> {
    match deletion {
        Deletion::Path(parts) => Ok(u64::from(rootpath::remove(root, &resolve(root, parts)?)?)),
        Deletion::Contents(parts) => {
            let dir = resolve(root, parts)?;
            let Ok(meta) = fs::symlink_metadata(&dir) else {
                return Ok(0);
            };
            if !meta.is_dir() {
                return Ok(0);
            }
            let mut count = 0;
            for child in fs::read_dir(&dir)? {
                count += u64::from(rootpath::remove(root, &child?.path())?);
            }
            Ok(count)
        }
    }
}

/// Adds one entry. Returns a directory whose mode and time are set at the
/// end of the layer.
fn add<R: Read>(
    root: &Path,
    parts: &[OsString],
    entry: &mut tar::Entry<'_, R>,
    privileged: bool,
    applied: &mut Applied,
) -> Result<Option<(Vec<OsString>, u32, i64)>> {
    let target = resolve(root, parts)?;
    let header = entry.header().clone();
    let kind = header.entry_type();
    let pax = Pax::read(entry)?;
    let mode = header.mode()? & 0o7777;
    let uid = pax.uid.map_or_else(|| header.uid(), Ok)?;
    let gid = pax.gid.map_or_else(|| header.gid(), Ok)?;
    let mtime = pax
        .mtime
        .map_or_else(|| header.mtime().map(|t| i64::try_from(t).unwrap_or(0)), Ok)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("parent of {}", parts_display(parts)))?;
    }
    let existing = fs::symlink_metadata(&target).ok();
    if !(kind == EntryType::Directory && existing.as_ref().is_some_and(fs::Metadata::is_dir)) {
        rootpath::remove(root, &target)?;
    }
    let mut deferred = None;
    match kind {
        EntryType::Regular | EntryType::Continuous => {
            let mut file = rootpath::create(root, &target, 0o600)?;
            applied.file_bytes += io::copy(entry, &mut file)?;
        }
        EntryType::Directory => {
            if existing.as_ref().is_none_or(|meta| !meta.is_dir()) {
                fs::create_dir(&target)?;
            }
            deferred = Some((parts.to_vec(), mode, mtime));
        }
        EntryType::Symlink => {
            let link = entry.link_name()?.context("symlink without a target")?;
            std::os::unix::fs::symlink(&link, &target)?;
        }
        EntryType::Link => {
            let link = entry.link_name()?.context("hard link without a target")?;
            let source = resolve(root, &clean(&link)?)?;
            fs::hard_link(&source, &target).with_context(|| {
                format!("hard link {} to {}", parts_display(parts), link.display())
            })?;
            // A hard link shares its source's owner, mode and times.
            return Ok(None);
        }
        EntryType::Char | EntryType::Block | EntryType::Fifo => {
            if !make_node(&target, kind, mode, &header, privileged)? {
                applied.skipped += 1;
                return Ok(None);
            }
        }
        EntryType::XGlobalHeader
        | EntryType::XHeader
        | EntryType::GNULongName
        | EntryType::GNULongLink => {
            return Ok(None);
        }
        other => bail!("{}: unsupported entry type {other:?}", parts_display(parts)),
    }
    if privileged {
        rustix::fs::chownat(
            CWD,
            &target,
            Some(rustix::fs::Uid::from_raw(
                u32::try_from(uid).unwrap_or(u32::MAX),
            )),
            Some(rustix::fs::Gid::from_raw(
                u32::try_from(gid).unwrap_or(u32::MAX),
            )),
            AtFlags::SYMLINK_NOFOLLOW,
        )?;
    } else if uid != 0 || gid != 0 {
        applied.skipped += 1;
    }
    for (name, value) in &pax.xattrs {
        if privileged || name.starts_with("user.") {
            rustix::fs::lsetxattr(
                &target,
                name.as_str(),
                value,
                rustix::fs::XattrFlags::empty(),
            )
            .with_context(|| format!("{}: attribute {name}", parts_display(parts)))?;
        } else {
            applied.skipped += 1;
        }
    }
    if kind != EntryType::Symlink && kind != EntryType::Directory {
        // After the owner: changing it clears set-id bits.
        fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
    }
    if kind != EntryType::Directory {
        set_mtime(&target, mtime)?;
    }
    Ok(deferred)
}

fn parts_display(parts: &[OsString]) -> String {
    parts
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn set_mtime(path: &Path, mtime: i64) -> io::Result<()> {
    let time = Timespec {
        tv_sec: mtime,
        tv_nsec: 0,
    };
    let times = Timestamps {
        last_access: time,
        last_modification: time,
    };
    rustix::fs::utimensat(CWD, path, &times, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)
}

/// Makes a device node or FIFO; false if that needs root and it has none.
#[cfg(target_os = "linux")]
fn make_node(
    path: &Path,
    kind: EntryType,
    mode: u32,
    header: &tar::Header,
    privileged: bool,
) -> Result<bool> {
    use rustix::fs::{FileType, Mode};
    let file_type = match kind {
        EntryType::Char => FileType::CharacterDevice,
        EntryType::Block => FileType::BlockDevice,
        _ => FileType::Fifo,
    };
    if file_type != FileType::Fifo && !privileged {
        return Ok(false);
    }
    let major = header.device_major()?.unwrap_or(0);
    let minor = header.device_minor()?.unwrap_or(0);
    rustix::fs::mknodat(
        CWD,
        path,
        file_type,
        Mode::from_raw_mode(mode),
        rustix::fs::makedev(major, minor),
    )?;
    Ok(true)
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::unnecessary_wraps)] // Same signature as the Linux one.
fn make_node(_: &Path, _: EntryType, _: u32, _: &tar::Header, _: bool) -> Result<bool> {
    Ok(false)
}

/// What a PAX header adds to an entry: large owners, precise times and
/// extended attributes.
#[derive(Debug, Default)]
struct Pax {
    uid: Option<u64>,
    gid: Option<u64>,
    mtime: Option<i64>,
    xattrs: Vec<(String, Vec<u8>)>,
}

impl Pax {
    fn read<R: Read>(entry: &mut tar::Entry<'_, R>) -> Result<Self> {
        let mut pax = Self::default();
        let Some(extensions) = entry.pax_extensions()? else {
            return Ok(pax);
        };
        for extension in extensions {
            let extension = extension?;
            let Ok(key) = extension.key() else {
                continue;
            };
            let value = extension.value_bytes();
            let text = std::str::from_utf8(value).unwrap_or_default();
            match key {
                "uid" => pax.uid = text.parse().ok(),
                "gid" => pax.gid = text.parse().ok(),
                // Seconds, maybe with a fraction; whole seconds are kept.
                "mtime" => pax.mtime = text.split('.').next().and_then(|s| s.parse().ok()),
                _ => {
                    if let Some(name) = key.strip_prefix("SCHILY.xattr.") {
                        pax.xattrs.push((name.to_owned(), value.to_vec()));
                    }
                }
            }
        }
        Ok(pax)
    }
}

#[cfg(test)]
mod tests;
