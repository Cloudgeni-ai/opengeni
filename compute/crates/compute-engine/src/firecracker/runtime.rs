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

/// How a runtime label names the host kernel, after the processor.
const KERNEL_LABEL: &str = " under Linux ";

/// Splits a runtime label into what names the VMM and the processor, and
/// the host kernel, which labels made before they named it lack.
fn split_kernel(runtime: &str) -> (&str, Option<&str>) {
    match runtime.rsplit_once(KERNEL_LABEL) {
        Some((made_by, kernel)) => (made_by, Some(kernel)),
        None => (runtime, None),
    }
}

/// The processor model a runtime label names, if it names one.
fn processor_of(runtime: &str) -> Option<&str> {
    split_kernel(runtime)
        .0
        .split_once(" on ")
        .map(|(_, processor)| processor)
}

/// Of `binaries`, the one to restore an image made under `made_under`
/// with: the one that made it if it is there, else the first that reads
/// its snapshot format. With none, the current binary tries it. The host
/// kernel a label names says nothing about which binary made the image.
pub(super) fn chosen<'a>(binaries: &[&'a Binary], made_under: &str) -> Option<&'a Binary> {
    let image = Format::of_runtime(made_under);
    let reads = |binary: &&&Binary| {
        binary
            .format
            .zip(image)
            .is_some_and(|(writes, image)| writes.reads(image))
    };
    let made_by = split_kernel(made_under).0;
    binaries
        .iter()
        .find(|binary| split_kernel(&binary.runtime).0 == made_by)
        .or_else(|| binaries.iter().find(reads))
        .copied()
}

/// Whether any of `binaries` loads an image made under `made_under`; see
/// [`crate::Engine::reads`]. Only a known snapshot format that every binary
/// names, and none reads, is a no. One a binary reads but that was made on
/// another processor model or under another host kernel, as both labels
/// name them, was made elsewhere.
pub(super) fn readable(binaries: &[&Binary], made_under: &str) -> Readable {
    if let Some(binary) = chosen(binaries, made_under) {
        return elsewhere(&binary.runtime, made_under).map_or(Readable::Yes, Readable::Elsewhere);
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

/// How the host an image was made on, as `made_under` names it, differs
/// from this one, which `here` names, if the labels say. A label made
/// before labels named the kernel leaves it open, so it may differ.
fn elsewhere(here: &str, made_under: &str) -> Option<String> {
    match (processor_of(made_under), processor_of(here)) {
        (Some(made_on), Some(this)) if made_on != this => {
            return Some(format!("it was made on {made_on}, and this host is {this}"));
        }
        _ => {}
    }
    match (split_kernel(made_under).1, split_kernel(here).1) {
        (Some(made_under), Some(this)) if made_under != this => Some(format!(
            "it was made under Linux {made_under}, and this host runs Linux {this}"
        )),
        (None, Some(this)) => Some(format!(
            "its label does not name the host kernel it was made under, and this host runs \
             Linux {this}"
        )),
        _ => None,
    }
}

/// What a memory image made here depends on, and the snapshot format
/// `binary` writes if it names one: the format, the processor model and
/// the host kernel. Firecracker refuses snapshots in formats it does not
/// read, a guest's saved processor state belongs to its model, and the
/// processor state KVM saves depends on the kernel: an image made under a
/// newer kernel can hold registers an older one refuses, and Firecracker
/// promises no restore across kernels. Releases that write the same format
/// make interchangeable images, so an upgrade that keeps the format keeps
/// every image. A binary too old to name its format is known by its
/// release.
pub(super) fn runtime_of(binary: &Path) -> io::Result<(String, Option<Format>)> {
    let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    let host = host_label(cpu_model(&cpuinfo), kernel.trim());
    if let Some(format) = first_line(binary, "--snapshot-version")? {
        return Ok((
            format!("{FORMAT_LABEL}{format}{host}"),
            Format::parse(&format),
        ));
    }
    match first_line(binary, "--version")? {
        Some(release) => Ok((format!("{release}{host}"), None)),
        None => Err(io::Error::other(format!(
            "{} --version reported no version",
            binary.display()
        ))),
    }
}

/// The end of a runtime label, naming the host: its processor model and,
/// when known, its kernel release.
pub(super) fn host_label(processor: &str, kernel: &str) -> String {
    if kernel.is_empty() {
        format!(" on {processor}")
    } else {
        format!(" on {processor}{KERNEL_LABEL}{kernel}")
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
