//! Warm templates: new sandboxes start from a guest that has already
//! booted.
//!
//! A cold boot runs the guest's whole startup before the first command can
//! run. A template is that startup done once per shape (processors and
//! memory): a VM booted from the base image, left until its guest accepts
//! connections on the ready port, then paused and saved whole. A new
//! sandbox of that shape gets a copy of the template's disk (a shared-extent
//! clone where the filesystem has them) and the template's memory image as
//! its own saved image, by hard link, so every sandbox restored from it
//! reads the same file through one page cache. Its record says Saved, with
//! memory, on local disk: its first wake is an ordinary restore.
//!
//! Every VM on a host has the same devices at the same paths inside its
//! jail, the same guest address and the same tap name in its own network
//! namespace (see [`crate::layout::Machine`] and [`crate::net`]), so the
//! template's saved state fits every sandbox without changes. The template
//! VM runs in a namespace with only that tap, leading nowhere.
//!
//! Every clone wakes with the template's memory: its random number
//! generator is reseeded by the guest kernel when the VMM changes the VM
//! generation id on restore, and it learns its own sandbox id from the
//! restore notice (see [`crate::restore_notice`]).
//!
//! A template is only good for the exact inputs it was built from: its
//! shape, the kernel, the base image, the VMM's files, the kernel command
//! line, whether sandboxes are networked and how memory is backed. They are
//! recorded with it and checked before every use; when any changed, the
//! sandbox boots cold and a new template is built. Creating a sandbox never
//! waits for a template: without a ready one it boots cold, and a build for
//! its shape starts in the background.
//!
//! ```text
//! <root>/templates/
//!   <shape>-<key>/                 a ready template, renamed into place last
//!     template.json                the inputs it was built from
//!     disk.ext4                    its disk, as its memory image left it
//!     images/                      its memory image (see crate::image)
//!   <shape>-<key>.building/        a template being put together
//!   vm/firecracker/template-<key>/ the VM building it: its jail, and
//!     ordinal                      the ordinal whose user its VMM runs as
//!   used/<shape>                   when the shape was last used (see uses)
//! ```
//!
//! Anything a build left when the agent stopped is removed on start, its VM
//! ended first, whether or not the agent keeps templates now. A build's
//! ordinal stays taken until its VM is proven gone, so no sandbox ever
//! shares a user with a VMM that may still run.
//!
//! A shape unused for a while (see [`uses`]) retires: its template is
//! removed and no ready sandboxes are kept of it until its next create.

mod uses;

pub(crate) use uses::{Uses, write_use};

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_core::{LoanId, Step};
use compute_engine::{Engine, SnapshotFiles, SnapshotKind, VmSpec, vsock};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio::time::{Instant, sleep, timeout};

use crate::image::{Depth, Images, Parts, Suspect};
use crate::layout::{
    Machine, Paths, copy_sparse, link_kernel, remove_if_present, sync_parent, templates_dir,
    write_atomic,
};
use crate::net::Isolated;
use crate::protocol::{SandboxConfig, TemplateState, TemplateStatus};
use crate::step::{DiskWatch, take_written};

/// Version of the template layout; a change rebuilds every template.
const FORMAT: u32 = 2;
/// The inputs file in a template's directory.
const INPUTS: &str = "template.json";
/// The file in a template VM's directory naming the ordinal it runs as.
const ORDINAL: &str = "ordinal";
/// The disk in a template's directory.
const DISK: &str = "disk.ext4";
/// The suffix of a template being put together.
const BUILDING: &str = ".building";
/// The name of every template VM starts with this.
const VM_PREFIX: &str = "template-";
/// How long after a failed build the next use of its shape tries again.
const RETRY_AFTER: Duration = Duration::from_secs(60);
/// How often the ready port is tried while the guest boots.
const READY_POLL: Duration = Duration::from_millis(20);

/// A sandbox shape: what a memory image fixes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shape {
    /// Virtual processors.
    pub vcpus: u8,
    /// Guest memory in MiB.
    pub memory_mib: u32,
}

impl Shape {
    /// The shape of sandboxes created with `config`.
    #[must_use]
    pub fn of(config: &SandboxConfig) -> Self {
        Self {
            vcpus: config.vcpus,
            memory_mib: config.memory_mib,
        }
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{}", self.vcpus, self.memory_mib)
    }
}

impl FromStr for Shape {
    type Err = String;

    /// Parses `VCPUS x MEMORY_MIB`, such as `2x1024`.
    fn from_str(text: &str) -> Result<Self, String> {
        let (vcpus, memory) = text
            .split_once('x')
            .ok_or_else(|| format!("shape {text:?} is not VCPUSxMEMORY_MIB, such as 2x1024"))?;
        let shape = Self {
            vcpus: vcpus
                .parse()
                .map_err(|error| format!("vcpus in {text:?}: {error}"))?,
            memory_mib: memory
                .parse()
                .map_err(|error| format!("memory in {text:?}: {error}"))?,
        };
        SandboxConfig {
            vcpus: shape.vcpus,
            memory_mib: shape.memory_mib,
            sleep: crate::protocol::SleepConfig::default(),
        }
        .validate()
        .map(|_| shape)
    }
}

/// A shape and how many ready sandboxes of it to keep, written
/// `SHAPE[:READY]` such as `1x512:16`. Without `:READY`, none: new
/// sandboxes of the shape restore its template.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keep {
    /// The shape, whose template is built as soon as the agent starts.
    pub shape: Shape,
    /// How many sandboxes of it to keep restored, warm and paused.
    pub ready: u32,
}

impl FromStr for Keep {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        let (shape, ready) = match text.split_once(':') {
            Some((shape, ready)) => (
                shape,
                ready
                    .parse()
                    .map_err(|error| format!("ready count in {text:?}: {error}"))?,
            ),
            None => (text, 0),
        };
        Ok(Self {
            shape: shape.parse()?,
            ready,
        })
    }
}

/// How a host keeps warm templates.
#[derive(Clone, Debug)]
pub struct PoolConfig {
    /// A guest vsock port that accepts connections once the guest is ready
    /// for work. A template is saved as soon as it does.
    pub ready_port: u32,
    /// Shapes whose templates are built as soon as the agent starts. Other
    /// shapes get one the first time a sandbox of theirs is created.
    pub shapes: Vec<Shape>,
    /// Further files every template depends on, such as the VMM's binaries:
    /// a change to any of them rebuilds the templates.
    pub depends_on: Vec<PathBuf>,
    /// How long a template's guest may take to become ready.
    pub ready_timeout: Duration,
    /// How many ready sandboxes to keep of each shape: restored from its
    /// template, warmed until the guest is ready and paused, so a create
    /// of that shape only claims one. Each shape here also gets its
    /// template at start.
    pub ready: BTreeMap<Shape, u32>,
    /// How long a shape may go unused before its template and ready
    /// sandboxes are given up, until its next create.
    pub unused_after: Duration,
}

impl PoolConfig {
    /// How long a shape may go unused by default: a week.
    pub const UNUSED_AFTER: Duration = Duration::from_secs(7 * 86_400);
}

/// Where today's templates come from. Fixed for the agent's life; the
/// files' contents are checked whenever a template is built or used.
#[derive(Debug)]
pub(crate) struct Sources {
    pub kernel: PathBuf,
    pub base_image: PathBuf,
    pub depends_on: Vec<PathBuf>,
    /// The kernel command line every VM boots with, before any sandbox's
    /// own arguments.
    pub boot_args: String,
    pub networked: bool,
    /// How guest memory is backed, as the engine describes it.
    pub memory: String,
    /// The guest port that says a booted guest is ready for work: a guest
    /// image that answers elsewhere is another guest.
    pub ready_port: u32,
    /// The content hash of each file, with the metadata it was read under.
    pub hashes: Mutex<HashMap<PathBuf, (Stamp, String)>>,
}

impl Sources {
    /// The inputs a template of `shape` built now has. Blocks: the first
    /// time, and after a file changed, it reads the whole file.
    pub fn inputs(&self, shape: Shape) -> io::Result<Inputs> {
        let files = [&self.kernel, &self.base_image]
            .into_iter()
            .chain(&self.depends_on)
            .map(|path| self.content(path))
            .collect::<io::Result<_>>()?;
        Ok(Inputs {
            format: FORMAT,
            shape,
            files,
            boot_args: self.boot_args.clone(),
            networked: self.networked,
            memory: self.memory.clone(),
            ready_port: self.ready_port,
        })
    }

    /// What the file at `path` holds, hashed again only when its metadata
    /// says it may have changed.
    fn content(&self, path: &Path) -> io::Result<FileId> {
        let stamp = Stamp::of(&fs::metadata(path)?);
        let known = self
            .hashes
            .lock()
            .map_err(|_| io::Error::other("template input hashes poisoned"))?
            .get(path)
            .filter(|(seen, _)| *seen == stamp)
            .map(|(_, hash)| hash.clone());
        let hash = if let Some(hash) = known {
            hash
        } else {
            let mut hasher = blake3::Hasher::new();
            hasher.update_reader(fs::File::open(path)?)?;
            // A file written to while it was read has no one content.
            if Stamp::of(&fs::metadata(path)?) != stamp {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    format!("{} changed while it was read", path.display()),
                ));
            }
            let hash = hasher.finalize().to_hex().to_string();
            self.hashes
                .lock()
                .map_err(|_| io::Error::other("template input hashes poisoned"))?
                .insert(path.to_owned(), (stamp, hash.clone()));
            hash
        };
        Ok(FileId {
            path: path.to_owned(),
            len: stamp.len,
            blake3: hash,
        })
    }
}

/// What a file's metadata says about its content. Every write to a file,
/// and every replacement of it, changes one of these: the kernel moves a
/// file's change time on each, and nothing can set it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Stamp {
    device: u64,
    inode: u64,
    len: u64,
    modified_ns: i128,
    changed_ns: i128,
}

impl Stamp {
    fn of(metadata: &fs::Metadata) -> Self {
        let ns = |secs: i64, nanos: i64| i128::from(secs) * 1_000_000_000 + i128::from(nanos);
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified_ns: ns(metadata.mtime(), metadata.mtime_nsec()),
            changed_ns: ns(metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

/// Everything a template's saved state depends on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inputs {
    format: u32,
    shape: Shape,
    files: Vec<FileId>,
    boot_args: String,
    networked: bool,
    memory: String,
    ready_port: u32,
}

impl Inputs {
    /// A short name that changes whenever any input does.
    fn key(&self) -> String {
        let hash = blake3::hash(format!("{self:?}").as_bytes());
        hash.to_hex()[..16].to_owned()
    }

    /// The template's directory name.
    fn dir_name(&self) -> String {
        format!("{}-{}", self.shape, self.key())
    }

    /// The name of the VM that builds the template.
    fn vm_name(&self) -> String {
        format!("{VM_PREFIX}{}", self.key())
    }
}

/// What a path held when a template was built: any change to its content
/// changes this, and nothing else does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileId {
    path: PathBuf,
    len: u64,
    blake3: String,
}

/// A ready template.
#[derive(Debug)]
pub(crate) struct Template {
    dir: PathBuf,
    inputs: Inputs,
}

impl Template {
    pub fn shape(&self) -> Shape {
        self.inputs.shape
    }

    /// Whether the template still fits today's `sources`. Blocks, as
    /// [`Sources::inputs`] does.
    pub fn fits(&self, sources: &Sources) -> io::Result<bool> {
        Ok(sources.inputs(self.inputs.shape)? == self.inputs)
    }

    fn images(&self) -> Images {
        Images::new(self.dir.join("images"))
    }

    /// Reads the template in `dir`, if it was built from `now` and its
    /// image checks out.
    fn open(dir: &Path, now: &Inputs) -> io::Result<Option<Self>> {
        let inputs: Inputs = serde_json::from_slice(&fs::read(dir.join(INPUTS))?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let fits = inputs == *now && dir.file_name().is_some_and(|name| *name == *now.dir_name());
        let template = Self {
            dir: dir.to_owned(),
            inputs,
        };
        if !fits || !matches!(template.images().current_verified(), Ok(Some(_))) {
            return Ok(None);
        }
        Ok(Some(template))
    }

    /// Gives the new sandbox at `paths` this template's disk and memory
    /// image. Blocks.
    fn copy_to(&self, paths: &Paths, images: &Images) -> Result<(), CopyFailure> {
        let source = self.images();
        let image = source
            .current_verified()
            .map_err(CopyFailure::from)?
            .ok_or_else(|| CopyFailure::Unusable("the template has no image".into()))?;
        copy_sparse(&self.dir.join(DISK), &paths.disk).map_err(CopyFailure::from)?;
        images
            .publish(Parts::Shared {
                from: &source,
                image: &image,
            })
            .map_err(CopyFailure::from)?;
        Ok(())
    }
}

/// Why a template could not be given to a sandbox.
#[derive(Debug, thiserror::Error)]
enum CopyFailure {
    /// A file of the template is gone or damaged: it must be rebuilt.
    #[error("the template is unusable: {0}")]
    Unusable(String),
    /// The host could not copy it this time.
    #[error(transparent)]
    Io(io::Error),
}

impl From<io::Error> for CopyFailure {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::Unusable(error.to_string())
        } else {
            Self::Io(error)
        }
    }
}

impl From<Suspect> for CopyFailure {
    fn from(suspect: Suspect) -> Self {
        match suspect {
            Suspect::Io(error) => error.into(),
            definite => Self::Unusable(definite.to_string()),
        }
    }
}

/// How a new sandbox's files came about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Start {
    /// From the base image, to be booted.
    Cold,
    /// From a template, to be restored.
    Template,
    /// From the base image, because the template no longer fits today's
    /// inputs, or a file of it is gone or damaged: it must be rebuilt.
    Stale,
}

/// Gives the new sandbox at `paths` its first files: from `template` when
/// it still fits today's `sources`, otherwise a copy of `base_image`.
/// `images` is the sandbox's own image directory. Blocks.
pub(crate) fn first_files(
    paths: &Paths,
    images: &Images,
    base_image: &Path,
    template: Option<(&Template, &Sources)>,
) -> io::Result<Start> {
    let mut start = Start::Cold;
    if let Some((template, sources)) = template {
        match sources.inputs(template.inputs.shape) {
            Ok(now) if now == template.inputs => match template.copy_to(paths, images) {
                Ok(()) => return Ok(Start::Template),
                Err(error) => {
                    // Removed by a rebuild meanwhile, damaged, or the host's
                    // disk failed: boot cold. Only a template proven
                    // unusable is replaced.
                    tracing::warn!(%error, dir = %template.dir.display(), "could not copy a template");
                    images.clear()?;
                    remove_if_present(&paths.disk)?;
                    if matches!(error, CopyFailure::Unusable(_)) {
                        start = Start::Stale;
                    }
                }
            },
            Ok(_) => start = Start::Stale,
            Err(error) => tracing::warn!(%error, "could not check the template's inputs"),
        }
    }
    copy_sparse(base_image, &paths.disk)?;
    Ok(start)
}

/// What the agent knows of one shape's template.
#[derive(Debug)]
enum Entry {
    Ready(Arc<Template>),
    Building,
    /// The last build failed; the next use after `retry` tries again.
    Failed {
        retry: Instant,
    },
    /// Unused for long enough to give up; the next create builds it again.
    Retired,
}

/// A shape [`Pool::retire`] gave up.
pub(crate) struct Retired {
    /// Its template, whose files are to be removed, if it had one.
    pub template: Option<Arc<Template>>,
}

/// The host's templates, one per shape. Pure: the agent carries out the
/// builds it asks for and reports back.
#[derive(Debug)]
pub(crate) struct Pool {
    entries: HashMap<Shape, Entry>,
}

impl Pool {
    /// A pool whose templates found on disk, of `checking` shapes, are
    /// still being checked: each counts as being built until
    /// [`Pool::checked`].
    pub fn new(checking: impl IntoIterator<Item = Shape>) -> Self {
        Self {
            entries: checking
                .into_iter()
                .map(|shape| (shape, Entry::Building))
                .collect(),
        }
    }

    /// Records how the check of `shape`'s template found on disk ended
    /// (see [`check_found`]); true if the caller must build a new one.
    pub fn checked(&mut self, shape: Shape, result: Result<Template, String>) -> bool {
        match result {
            Ok(template) => {
                self.entries.insert(shape, Entry::Ready(Arc::new(template)));
                false
            }
            Err(error) => {
                tracing::warn!(%shape, %error, "a template found on disk failed its check; building it again");
                self.entries.insert(shape, Entry::Building);
                true
            }
        }
    }

    /// Asks for `shape`'s template to be built unless it is ready, being
    /// built, or failed too recently; true if the caller must build it.
    pub fn want(&mut self, shape: Shape, now: Instant) -> bool {
        let build = match self.entries.get(&shape) {
            None => true,
            Some(Entry::Failed { retry }) => now >= *retry,
            Some(Entry::Ready(_) | Entry::Building | Entry::Retired) => false,
        };
        if build {
            self.entries.insert(shape, Entry::Building);
        }
        build
    }

    /// `shape`'s template, if one is ready.
    pub fn ready(&self, shape: Shape) -> Option<Arc<Template>> {
        match self.entries.get(&shape) {
            Some(Entry::Ready(template)) => Some(Arc::clone(template)),
            _ => None,
        }
    }

    /// The template a new sandbox of `shape` starts from, if one is ready;
    /// otherwise asks for it as [`Pool::want`] does. The second value says
    /// whether the caller must build it.
    pub fn take(&mut self, shape: Shape, now: Instant) -> (Option<Arc<Template>>, bool) {
        match self.entries.get(&shape) {
            Some(Entry::Ready(template)) => return (Some(Arc::clone(template)), false),
            Some(Entry::Retired) => {
                self.entries.remove(&shape);
            }
            _ => {}
        }
        (None, self.want(shape, now))
    }

    /// Gives up `shape`'s template, which went unused, until its next
    /// [`Pool::take`]. Returns nothing if it is being built (it retires
    /// once built) or already retired.
    pub fn retire(&mut self, shape: Shape) -> Option<Retired> {
        let entry = self.entries.get(&shape);
        if matches!(entry, Some(Entry::Building | Entry::Retired)) {
            return None;
        }
        let template = match self.entries.insert(shape, Entry::Retired) {
            Some(Entry::Ready(template)) => Some(template),
            _ => None,
        };
        tracing::info!(%shape, "template unused for long; retired");
        Some(Retired { template })
    }

    /// Records how a build of `shape` ended.
    pub fn built(&mut self, shape: Shape, result: Result<Template, String>, now: Instant) {
        let entry = match result {
            Ok(template) => Entry::Ready(Arc::new(template)),
            Err(error) => {
                tracing::warn!(%shape, %error, "template not built");
                Entry::Failed {
                    retry: now + RETRY_AFTER,
                }
            }
        };
        self.entries.insert(shape, entry);
    }

    /// Forgets `template`, which no longer fits today's inputs, and asks for
    /// a new one as [`Pool::want`] does, unless a newer one is already
    /// ready or being built.
    pub fn stale(&mut self, template: &Arc<Template>, now: Instant) -> bool {
        let shape = template.inputs.shape;
        if let Some(Entry::Ready(current)) = self.entries.get(&shape)
            && Arc::ptr_eq(current, template)
        {
            self.entries.remove(&shape);
        }
        self.want(shape, now)
    }

    /// Every shape's template, by shape.
    pub fn status(&self) -> Vec<TemplateStatus> {
        let mut all: Vec<TemplateStatus> = self
            .entries
            .iter()
            .map(|(shape, entry)| TemplateStatus {
                vcpus: shape.vcpus,
                memory_mib: shape.memory_mib,
                state: match entry {
                    Entry::Ready(_) => TemplateState::Ready,
                    Entry::Building => TemplateState::Building,
                    Entry::Failed { .. } => TemplateState::Failed,
                    Entry::Retired => TemplateState::Retired,
                },
                ready: 0,
                ready_resident_bytes: 0,
                target: 0,
                filling: 0,
            })
            .collect();
        all.sort_by_key(|status| (status.vcpus, status.memory_mib));
        all
    }
}

/// One template build.
pub(crate) struct Build {
    /// The host's state root.
    pub root: PathBuf,
    pub sources: Arc<Sources>,
    pub shape: Shape,
    /// The ordinal reserved for the build, recorded with its VM.
    pub ordinal: u32,
    /// Admits its boot and its save under the host's limits.
    pub lender: Lender,
    /// The user and group the template's VMM runs as, which no other VM on
    /// the host has meanwhile: the ordinal's.
    pub uid: u32,
    pub ready_port: u32,
    pub ready_timeout: Duration,
}

/// Asks the host for places under its step limits, for work outside any
/// sandbox, so template builds never run beside more boots or saves than
/// the limits allow (see [`compute_core::Input::Borrow`]).
#[derive(Clone)]
pub(crate) struct Lender {
    send: Arc<dyn Fn(Loaning) + Send + Sync>,
    next: Arc<AtomicU64>,
}

impl fmt::Debug for Lender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Lender")
    }
}

/// What a [`Lender`] tells the host.
#[derive(Debug)]
pub(crate) enum Loaning {
    /// Asks for a place under `step`'s limit; `granted` is told once lent.
    Borrow {
        loan: LoanId,
        step: Step,
        granted: oneshot::Sender<()>,
    },
    /// Gives the place back, or withdraws the request.
    Return(LoanId),
}

impl Lender {
    pub fn new(send: impl Fn(Loaning) + Send + Sync + 'static) -> Self {
        Self {
            send: Arc::new(send),
            next: Arc::default(),
        }
    }

    /// Waits for a place under `step`'s limit, held until the loan is
    /// dropped. A host that is gone lends at once: nothing else runs.
    pub async fn borrow(&self, step: Step) -> Loan {
        let loan = LoanId(self.next.fetch_add(1, Ordering::Relaxed));
        let (granted, lent) = oneshot::channel();
        (self.send)(Loaning::Borrow {
            loan,
            step,
            granted,
        });
        // Made first, so a borrower dropped while waiting withdraws.
        let held = Loan {
            lender: self.clone(),
            loan,
        };
        let _ = lent.await;
        held
    }
}

/// A place under a step limit, given back when dropped.
#[derive(Debug)]
pub(crate) struct Loan {
    lender: Lender,
    loan: LoanId,
}

impl Drop for Loan {
    fn drop(&mut self) {
        (self.lender.send)(Loaning::Return(self.loan));
    }
}

/// How a build ended.
#[derive(Debug)]
pub(crate) struct Built {
    pub result: Result<Template, String>,
    /// Whether the build's VM is proven gone. Until it is, its ordinal
    /// stays taken: the VMM may still run as its user.
    pub ended: bool,
}

/// The jailer's chroot base for template VMs.
fn chroot_base(root: &Path) -> PathBuf {
    templates_dir(root).join("vm")
}

/// The description of the VM named `name` that builds a template.
fn template_vm(
    root: &Path,
    name: &str,
    shape: Shape,
    uid: u32,
    sources: &Sources,
) -> (Paths, VmSpec) {
    let paths = Paths::at(chroot_base(root).join("firecracker").join(name));
    let spec = Machine {
        name: name.to_owned(),
        paths: &paths,
        uid,
        gid: uid,
        vcpus: shape.vcpus,
        memory_mib: shape.memory_mib,
        boot_args: sources.boot_args.clone(),
        network: sources.networked.then(|| Isolated::new(name).vm_network()),
    }
    .spec();
    (paths, spec)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Builds the template `build` describes, replacing older ones of its
/// shape. Unless the build's VM could not be proven gone, it has ended and
/// its jail and namespace are gone when this returns; otherwise they are
/// left for the next start of the agent, with the ordinal it runs as.
pub(crate) async fn build<E: Engine>(engine: &E, build: Build) -> Built {
    let started = Instant::now();
    let inputs = {
        let (sources, shape) = (Arc::clone(&build.sources), build.shape);
        match blocking(move || sources.inputs(shape)).await {
            Ok(inputs) => inputs,
            Err(error) => {
                return Built {
                    result: Err(error),
                    ended: true,
                };
            }
        }
    };
    let name = inputs.vm_name();
    let (paths, spec) = template_vm(&build.root, &name, build.shape, build.uid, &build.sources);
    let isolated = build.sources.networked.then(|| Isolated::new(&name));
    let result = attempt(engine, &build, inputs, &paths, &spec, isolated.clone()).await;
    if let Err(error) = engine.clean_up(&spec).await {
        // Its files say which ordinal it holds when the next agent tries.
        tracing::error!(%error, %name, ordinal = build.ordinal, "a template VM may still run; its user stays taken");
        return Built {
            result,
            ended: false,
        };
    }
    let dir = paths.dir.clone();
    let cleared = blocking(move || {
        if let Some(isolated) = isolated {
            isolated.remove().map_err(io::Error::other)?;
        }
        remove_dir(&dir)
    })
    .await;
    if let Err(error) = cleared {
        tracing::warn!(%error, %name, "a template VM's files were not removed");
    }
    if result.is_ok() {
        tracing::info!(
            shape = %build.shape,
            ms = started.elapsed().as_millis(),
            "template built"
        );
    }
    Built {
        result,
        ended: true,
    }
}

async fn attempt<E: Engine>(
    engine: &E,
    build: &Build,
    inputs: Inputs,
    paths: &Paths,
    spec: &VmSpec,
    isolated: Option<Isolated>,
) -> Result<Template, String> {
    // Whatever an earlier attempt of this template left goes first.
    engine
        .clean_up(spec)
        .await
        .map_err(|error| error.to_string())?;
    // The watch is opened before the VMM starts, so it sees every write
    // to the template's disk that is lost; see `DiskWatch`.
    let disk = {
        let (paths, sources, uid) = (paths.clone(), Arc::clone(&build.sources), build.uid);
        let ordinal = build.ordinal;
        Arc::new(
            blocking(move || {
                remove_dir(&paths.dir)?;
                fs::create_dir_all(&paths.jail)?;
                // Before any VMM of it can exist. Only an agent stop leaves
                // it behind for the next agent, and a VM outlives only that,
                // so it needs no flush to disk.
                fs::write(paths.dir.join(ORDINAL), ordinal.to_string())?;
                copy_sparse(&sources.base_image, &paths.disk)?;
                link_kernel(&sources.kernel, &paths)?;
                if let Some(isolated) = isolated {
                    isolated.ensure(uid, uid).map_err(io::Error::other)?;
                }
                DiskWatch::fresh(&paths)
            })
            .await?,
        )
    };
    // Booting until the guest is ready counts as a boot, and pausing and
    // saving it as a save, under the same limits as sandboxes' steps and
    // after every one queued: a sandbox can always boot cold instead.
    let booting = build.lender.borrow(Step::Boot).await;
    let vm = engine.boot(spec).await.map_err(|error| error.to_string())?;
    let files = SnapshotFiles {
        state: paths.in_jail("save.state"),
        memory: paths.in_jail("save.mem"),
    };
    let saved = async {
        ready(engine, &vm, spec, build.ready_port, build.ready_timeout).await?;
        drop(booting);
        let _saving = build.lender.borrow(Step::Save).await;
        engine.pause(&vm).await.map_err(|error| error.to_string())?;
        let watch = Arc::clone(&disk);
        blocking(move || watch.begin()).await?;
        engine
            .snapshot(&vm, &files, SnapshotKind::Full)
            .await
            .map_err(|error| error.to_string())?;
        // The template is trusted only if no write to its disk was lost.
        let watch = Arc::clone(&disk);
        blocking(move || watch.sync()).await
    }
    .await;
    let stopped = engine.stop(vm).await.map_err(|error| error.to_string());
    saved?;
    stopped?;
    let (root, paths) = (build.root.clone(), paths.clone());
    blocking(move || publish(&root, inputs, &paths, &files)).await
}

/// Waits until the guest of `vm` accepts a connection on `port`.
pub(crate) async fn ready<E: Engine>(
    engine: &E,
    vm: &E::Vm,
    spec: &VmSpec,
    port: u32,
    limit: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    let exited = engine.exited(vm);
    tokio::pin!(exited);
    let socket = spec.vsock_path();
    loop {
        if let Ok(Ok(_)) = timeout(Duration::from_secs(1), vsock::connect(&socket, port)).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the guest did not accept connections on port {port} within {limit:?}"
            ));
        }
        tokio::select! {
            () = &mut exited => return Err("the VM ended before its guest was ready".into()),
            () = sleep(READY_POLL) => {}
        }
    }
}

/// Puts the template together from what its stopped VM left in `paths`,
/// publishes it, and removes older templates of its shape. Blocks.
fn publish(
    root: &Path,
    inputs: Inputs,
    paths: &Paths,
    files: &SnapshotFiles,
) -> io::Result<Template> {
    let templates = templates_dir(root);
    let name = inputs.dir_name();
    let staging = templates.join(format!("{name}{BUILDING}"));
    remove_dir(&staging)?;
    fs::create_dir_all(&staging)?;
    // What the VMM wrote, and its disk, leave the jail before anything
    // reads them.
    let written = take_written(files, &paths.dir.join("saving"))?;
    let disk = staging.join(DISK);
    fs::rename(&paths.disk, &disk)?;
    compute_engine::confined::check_written(&disk)?;
    seal(&disk)?;
    Images::new(staging.join("images"))
        .publish(Parts::Whole {
            state: &written.state,
            memory: &written.memory,
        })
        .map_err(io::Error::other)?;
    let encoded = serde_json::to_vec_pretty(&inputs).map_err(io::Error::other)?;
    write_atomic(&staging.join(INPUTS), &encoded)?;
    let ready = templates.join(&name);
    remove_dir(&ready)?;
    fs::rename(&staging, &ready)?;
    sync_parent(&ready)?;
    let older = format!("{}-", inputs.shape);
    for entry in fs::read_dir(&templates)? {
        let entry = entry?;
        let other = entry.file_name();
        let other = other.to_string_lossy();
        if other != name && other.starts_with(&older) && !other.ends_with(BUILDING) {
            remove_dir(&entry.path())?;
        }
    }
    Ok(Template { dir: ready, inputs })
}

/// Makes the template's disk read-only and the agent's, so nothing changes
/// what every new sandbox copies.
fn seal(path: &Path) -> io::Result<()> {
    rustix::fs::chown(
        path,
        Some(rustix::process::geteuid()),
        Some(rustix::process::getegid()),
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))?;
    fs::File::open(path)?.sync_all()
}

/// Removes the files of a retired `template`. Sandboxes started from it
/// keep theirs: their memory images are their own links to the file.
///
/// The directory leaves its name at once, before this returns, so a build
/// of the same inputs started any time later publishes there and is never
/// what the removal, which runs when the returned future does, deletes.
/// Its new name marks it unfinished, so an agent that stops first removes
/// it at its next start.
pub(crate) fn remove(template: &Template) -> impl Future<Output = ()> + Send + 'static {
    let dir = template.dir.clone();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let mut away = dir.clone().into_os_string();
    away.push(format!(".retired-{nanos}{BUILDING}"));
    let away = PathBuf::from(away);
    let moved = fs::rename(&dir, &away);
    async move {
        match moved {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!(%error, dir = %dir.display(), "could not move a retired template away");
                return;
            }
        }
        if let Err(error) = blocking(move || remove_dir(&away)).await {
            tracing::warn!(%error, dir = %dir.display(), "could not remove a retired template");
        }
    }
}

/// Removes the directory `dir` and everything in it; succeeds if there is
/// none.
fn remove_dir(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// A template build's VM an earlier agent left that could not be proven
/// gone: it may still run, as the user of `ordinal`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Held {
    pub name: String,
    /// The ordinal its VMM runs as, when its files still say.
    pub ordinal: Option<u32>,
}

/// Ends the VMs of builds an earlier agent left under `root` and removes
/// their files, whether or not this agent keeps templates. Returns those
/// whose VM could not be proven gone: their files are left for the next
/// start, and their ordinals must stay taken. `first_uid` is the user of
/// ordinal 0.
pub(crate) async fn end_leftover_builds<E: Engine>(
    engine: &E,
    root: &Path,
    sources: &Arc<Sources>,
    first_uid: u32,
) -> Vec<Held> {
    let jails = chroot_base(root).join("firecracker");
    let leftovers: Vec<String> = fs::read_dir(&jails)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(VM_PREFIX))
        .collect();
    let mut held = Vec::new();
    for name in leftovers {
        // Only its name and paths matter for ending it.
        let shape = Shape {
            vcpus: 1,
            memory_mib: 128,
        };
        let dir = jails.join(&name);
        let ordinal = {
            let dir = dir.clone();
            blocking(move || Ok(build_ordinal(&dir, first_uid)))
                .await
                .ok()
                .flatten()
        };
        let uid = ordinal.map_or(first_uid, |ordinal| first_uid.saturating_add(ordinal));
        let (paths, spec) = template_vm(root, &name, shape, uid, sources);
        if let Err(error) = engine.clean_up(&spec).await {
            tracing::error!(%error, %name, ?ordinal, "a template VM left behind may still run; its user stays taken");
            held.push(Held { name, ordinal });
            continue;
        }
        let networked = sources.networked;
        let removed = blocking(move || {
            if networked {
                Isolated::new(&name).remove().map_err(io::Error::other)?;
            }
            remove_dir(&paths.dir)
        })
        .await;
        if let Err(error) = removed {
            tracing::warn!(%error, "could not remove a template VM's files");
        }
    }
    held
}

/// The ordinal the build VM in `dir` runs as: from its ordinal file, or
/// else from the owner of its disk, which the host gives the VMM's user
/// before the VMM starts. Blocks.
fn build_ordinal(dir: &Path, first_uid: u32) -> Option<u32> {
    if let Ok(text) = fs::read_to_string(dir.join(ORDINAL))
        && let Ok(ordinal) = text.trim().parse()
    {
        return Some(ordinal);
    }
    let owner = fs::symlink_metadata(Paths::at(dir.to_owned()).disk)
        .ok()?
        .uid();
    owner.checked_sub(first_uid)
}

/// The templates under `root` that still fit today's `sources`; the rest
/// are removed.
pub(crate) async fn keep_templates(root: &Path, sources: &Arc<Sources>) -> Vec<Template> {
    let (dir, sources) = (templates_dir(root), Arc::clone(sources));
    blocking(move || Ok(keep_fitting(&dir, &sources)))
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not look for templates");
            Vec::new()
        })
}

/// Checks every chunk of the memory image of `template`, found on disk,
/// against its chunk map, once, before the pool trusts it: a same-length
/// change passes the light check each clone makes. One that fails is
/// removed, so it can be built again. Templates this agent built are
/// trusted as built.
pub(crate) async fn check_found(template: Template) -> Result<Template, String> {
    blocking(move || {
        let images = template.images();
        let checked = match images.current() {
            Ok(Some(generation)) => images
                .verify(generation, Depth::Deep)
                .map(drop)
                .map_err(|suspect| suspect.to_string()),
            Ok(None) => Err("the template has no image".into()),
            Err(error) => Err(error.to_string()),
        };
        if let Err(reason) = checked {
            remove_dir(&template.dir)?;
            return Ok(Err(reason));
        }
        Ok(Ok(template))
    })
    .await
    .and_then(|checked| checked)
}

/// Removes every template in `dir` that is unfinished or no longer fits
/// `sources`, and returns the rest.
fn keep_fitting(dir: &Path, sources: &Sources) -> Vec<Template> {
    let mut kept = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return kept;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name();
        if name == "vm" || name == uses::USED {
            continue;
        }
        let fitting = read_inputs(&path)
            .and_then(|inputs| sources.inputs(inputs.shape))
            .and_then(|now| Template::open(&path, &now));
        match fitting {
            Ok(Some(template)) if !name.to_string_lossy().ends_with(BUILDING) => {
                kept.push(template);
            }
            _ => {
                tracing::info!(dir = %path.display(), "removing a template that no longer fits");
                if let Err(error) = remove_dir(&path) {
                    tracing::warn!(%error, dir = %path.display(), "could not remove a template");
                }
            }
        }
    }
    kept
}

fn read_inputs(dir: &Path) -> io::Result<Inputs> {
    serde_json::from_slice(&fs::read(dir.join(INPUTS))?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests;
