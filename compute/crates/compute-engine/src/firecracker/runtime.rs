//! Which Firecracker binary restores which memory image, and what makes
//! an image unreadable here.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use super::BINARY_NAME;
use super::jail::Jail;
use crate::Readable;

/// A Firecracker binary and the runtime the images it makes belong to.
#[derive(Clone, Debug)]
pub(super) struct Binary {
    pub(super) path: PathBuf,
    /// See [`crate::Engine::runtime`].
    pub(super) runtime: String,
    /// The snapshot format it writes, if it names one.
    pub(super) format: Option<Format>,
}

impl Binary {
    /// Checks `path`'s name, which the jailer names every jail after, and
    /// asks the binary what its images depend on.
    pub(super) fn new(path: &Path) -> io::Result<Self> {
        // The jailer resolves links in the binary's path and names every
        // jail after the file it finds, so the name is checked there.
        let binary = fs::canonicalize(path)?;
        if binary.file_name().is_none_or(|name| name != BINARY_NAME) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "a Firecracker binary must be named {BINARY_NAME}, not {} (from {})",
                    binary.display(),
                    path.display()
                ),
            ));
        }
        let (runtime, format) = runtime_of(&binary)?;
        Ok(Self {
            path: binary,
            runtime,
            format,
        })
    }
}

/// A Firecracker snapshot format version. Firecracker loads a snapshot
/// only in a format of its own major version and at most its own minor
/// one; see Firecracker's `docs/snapshotting/versioning.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Format {
    major: u64,
    minor: u64,
    patch: u64,
}

impl Format {
    /// Parses a version as `--snapshot-version` prints it, `v1.2.3`.
    pub(super) fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let mut parts = text.strip_prefix('v').unwrap_or(text).split('.');
        let mut number = || parts.next()?.parse().ok();
        let format = Self {
            major: number()?,
            minor: number()?,
            patch: number()?,
        };
        parts.next().is_none().then_some(format)
    }

    /// The format of images made under `runtime`, if it names one.
    pub(super) fn of_runtime(runtime: &str) -> Option<Self> {
        let named = runtime.strip_prefix(FORMAT_LABEL)?;
        Self::parse(named.split_once(" on ").map_or(named, |(format, _)| format))
    }

    /// Whether a binary writing this format loads snapshots in `image`.
    pub(super) fn reads(self, image: Self) -> bool {
        self.major == image.major && self.minor >= image.minor
    }
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// How a runtime label names the snapshot format.
const FORMAT_LABEL: &str = "Firecracker snapshot format ";

/// Of `binaries`, the one to restore an image made under `made_under`
/// with: the one that made it if it is there, else the first that reads
/// its snapshot format. With none, the current binary tries it.
pub(super) fn chosen<'a>(binaries: &[&'a Binary], made_under: &str) -> Option<&'a Binary> {
    let image = Format::of_runtime(made_under);
    let reads = |binary: &&&Binary| {
        binary
            .format
            .zip(image)
            .is_some_and(|(writes, image)| writes.reads(image))
    };
    binaries
        .iter()
        .find(|binary| binary.runtime == made_under)
        .or_else(|| binaries.iter().find(reads))
        .copied()
}

/// Whether any of `binaries` loads an image made under `made_under`; see
/// [`crate::Engine::reads`]. Only a known snapshot format that every binary
/// names, and none reads, is a no.
pub(super) fn readable(binaries: &[&Binary], made_under: &str) -> Readable {
    if chosen(binaries, made_under).is_some() {
        return Readable::Yes;
    }
    let Some(image) = Format::of_runtime(made_under) else {
        return Readable::Unknown;
    };
    let mut read = Vec::new();
    for binary in binaries {
        let Some(format) = binary.format else {
            return Readable::Unknown;
        };
        read.push(format.to_string());
    }
    Readable::No(format!(
        "it is in Firecracker snapshot format {image}, and this host's Firecracker binaries \
         read only their own major version, up to their own minor one: {}",
        read.join(", ")
    ))
}

/// What a memory image made here depends on, and the snapshot format
/// `binary` writes if it names one: the format and the processor model.
/// Firecracker refuses snapshots in formats it does not read, and a
/// guest's saved processor state belongs to its model. Releases that write
/// the same format make interchangeable images, so an upgrade that keeps
/// the format keeps every image. A binary too old to name its format is
/// known by its release.
pub(super) fn runtime_of(binary: &Path) -> io::Result<(String, Option<Format>)> {
    let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let processor = cpu_model(&cpuinfo);
    if let Some(format) = first_line(binary, "--snapshot-version")? {
        return Ok((
            format!("{FORMAT_LABEL}{format} on {processor}"),
            Format::parse(&format),
        ));
    }
    match first_line(binary, "--version")? {
        Some(release) => Ok((format!("{release} on {processor}"), None)),
        None => Err(io::Error::other(format!(
            "{} --version reported no version",
            binary.display()
        ))),
    }
}

/// The first line `binary` prints when run with `flag`, if it succeeds.
pub(super) fn first_line(binary: &Path, flag: &str) -> io::Result<Option<String>> {
    let output = std::process::Command::new(binary)
        .arg(flag)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    let reported = String::from_utf8_lossy(&output.stdout);
    let line = reported
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty());
    Ok(line.filter(|_| output.status.success()).map(str::to_owned))
}

/// Where a launch records the runtime its VMM runs under: beside the jail,
/// where only the host reaches.
pub(super) fn runtime_record(jail: &Jail) -> PathBuf {
    jail.root()
        .parent()
        .unwrap_or_else(|| jail.root())
        .join("vmm.runtime")
}

/// Records `runtime` for the VMM about to launch in `jail`, replacing what
/// an earlier launch recorded. The VMM outlives the agent, so this is how
/// a later agent learns which runtime its snapshots belong to.
pub(super) fn record_runtime(jail: &Jail, runtime: &str) -> io::Result<()> {
    let path = runtime_record(jail);
    let staged = path.with_extension("runtime.new");
    fs::write(&staged, runtime)?;
    fs::rename(&staged, &path)
}

/// The runtime recorded for `jail`'s VMM, or empty if none was.
pub(super) fn recorded_runtime(jail: &Jail) -> String {
    fs::read_to_string(runtime_record(jail))
        .map(|runtime| runtime.trim().to_owned())
        .unwrap_or_default()
}

/// The processor's model name as `/proc/cpuinfo` gives it.
pub(super) fn cpu_model(cpuinfo: &str) -> &str {
    cpuinfo
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == "model name").then(|| value.trim())
        })
        .unwrap_or("an unknown processor")
}
