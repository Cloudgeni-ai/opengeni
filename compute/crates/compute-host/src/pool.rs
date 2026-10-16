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
//!   vm/firecracker/template-<key>/ the jail of the VM building it
//! ```
//!
//! Anything a build left when the agent stopped is removed on start, its VM
//! ended first.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use compute_engine::{Engine, SnapshotFiles, SnapshotKind, VmSpec, vsock};
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, sleep, timeout};

use crate::image::{Images, Parts};
use crate::layout::{
    Machine, Paths, copy_sparse, link_kernel, remove_if_present, sync_parent, templates_dir,
    write_atomic,
};
use crate::net::Isolated;
use crate::protocol::{SandboxConfig, TemplateState, TemplateStatus};
use crate::step::{sync_jailed, take_written};

/// Version of the template layout; a change rebuilds every template.
const FORMAT: u32 = 1;
/// The inputs file in a template's directory.
const INPUTS: &str = "template.json";
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
}

/// Where today's templates come from. Fixed for the agent's life; the
/// files' identities are read whenever a template is built or used.
#[derive(Clone, Debug)]
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
}

impl Sources {
    /// The inputs a template of `shape` built now has. Blocks.
    pub fn inputs(&self, shape: Shape) -> io::Result<Inputs> {
        let files = [&self.kernel, &self.base_image]
            .into_iter()
            .chain(&self.depends_on)
            .map(|path| FileId::of(path))
            .collect::<io::Result<_>>()?;
        Ok(Inputs {
            format: FORMAT,
            shape,
            files,
            boot_args: self.boot_args.clone(),
            networked: self.networked,
            memory: self.memory.clone(),
        })
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

/// Which file a path named when a template was built: replacing or
/// rewriting it changes its identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileId {
    path: PathBuf,
    device: u64,
    inode: u64,
    len: u64,
    modified_ns: i128,
}

impl FileId {
    fn of(path: &Path) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        Ok(Self {
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
                + i128::from(metadata.mtime_nsec()),
        })
    }
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
    fn copy_to(&self, paths: &Paths, images: &Images) -> io::Result<()> {
        let source = self.images();
        let image = source
            .current_verified()
            .map_err(io::Error::other)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the template has no image"))?;
        copy_sparse(&self.dir.join(DISK), &paths.disk)?;
        images
            .publish(Parts::Shared {
                from: &source,
                image: &image,
            })
            .map_err(io::Error::other)?;
        Ok(())
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
    /// inputs: it must be rebuilt.
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
                    // Removed by a rebuild meanwhile, say: boot cold.
                    tracing::warn!(%error, dir = %template.dir.display(), "could not copy a template");
                    images.clear()?;
                    remove_if_present(&paths.disk)?;
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
}

/// The host's templates, one per shape. Pure: the agent carries out the
/// builds it asks for and reports back.
#[derive(Debug)]
pub(crate) struct Pool {
    entries: HashMap<Shape, Entry>,
}

impl Pool {
    /// A pool holding the templates found on disk.
    pub fn new(ready: Vec<Template>) -> Self {
        Self {
            entries: ready
                .into_iter()
                .map(|template| (template.inputs.shape, Entry::Ready(Arc::new(template))))
                .collect(),
        }
    }

    /// Asks for `shape`'s template to be built unless it is ready, being
    /// built, or failed too recently; true if the caller must build it.
    pub fn want(&mut self, shape: Shape, now: Instant) -> bool {
        let build = match self.entries.get(&shape) {
            None => true,
            Some(Entry::Failed { retry }) => now >= *retry,
            Some(Entry::Ready(_) | Entry::Building) => false,
        };
        if build {
            self.entries.insert(shape, Entry::Building);
        }
        build
    }

    /// The template a new sandbox of `shape` starts from, if one is ready;
    /// otherwise asks for it as [`Pool::want`] does. The second value says
    /// whether the caller must build it.
    pub fn take(&mut self, shape: Shape, now: Instant) -> (Option<Arc<Template>>, bool) {
        if let Some(Entry::Ready(template)) = self.entries.get(&shape) {
            return (Some(Arc::clone(template)), false);
        }
        (None, self.want(shape, now))
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
                },
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
    /// The user and group the template's VMM runs as, which no other VM on
    /// the host has meanwhile.
    pub uid: u32,
    pub ready_port: u32,
    pub ready_timeout: Duration,
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
/// shape. Whatever happens, the build's VM has ended and its jail and
/// namespace are gone when this returns.
pub(crate) async fn build<E: Engine>(engine: &E, build: Build) -> Result<Template, String> {
    let started = Instant::now();
    let inputs = {
        let (sources, shape) = (Arc::clone(&build.sources), build.shape);
        blocking(move || sources.inputs(shape)).await?
    };
    let name = inputs.vm_name();
    let (paths, spec) = template_vm(&build.root, &name, build.shape, build.uid, &build.sources);
    let isolated = build.sources.networked.then(|| Isolated::new(&name));
    let result = attempt(engine, &build, inputs, &paths, &spec, isolated.clone()).await;
    if let Err(error) = engine.clean_up(&spec).await {
        tracing::warn!(%error, %name, "a template VM was not cleaned up");
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
    result
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
    {
        let (paths, sources, uid) = (paths.clone(), Arc::clone(&build.sources), build.uid);
        blocking(move || {
            remove_dir(&paths.dir)?;
            fs::create_dir_all(&paths.jail)?;
            copy_sparse(&sources.base_image, &paths.disk)?;
            link_kernel(&sources.kernel, &paths)?;
            if let Some(isolated) = isolated {
                isolated.ensure(uid, uid).map_err(io::Error::other)?;
            }
            Ok(())
        })
        .await?;
    }
    let vm = engine.boot(spec).await.map_err(|error| error.to_string())?;
    let files = SnapshotFiles {
        state: paths.in_jail("save.state"),
        memory: paths.in_jail("save.mem"),
    };
    let saved = async {
        ready(engine, &vm, spec, build.ready_port, build.ready_timeout).await?;
        engine.pause(&vm).await.map_err(|error| error.to_string())?;
        engine
            .snapshot(&vm, &files, SnapshotKind::Full)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    let stopped = engine.stop(vm).await.map_err(|error| error.to_string());
    saved?;
    stopped?;
    let (root, paths) = (build.root.clone(), paths.clone());
    blocking(move || publish(&root, inputs, &paths, &files)).await
}

/// Waits until the guest of `vm` accepts a connection on `port`.
async fn ready<E: Engine>(
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
                "the template's guest did not accept connections on port {port} within {limit:?}"
            ));
        }
        tokio::select! {
            () = &mut exited => return Err("the template's VM ended while booting".into()),
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
    sync_jailed(&paths.disk)?;
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

/// Removes the directory `dir` and everything in it; succeeds if there is
/// none.
fn remove_dir(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Clears what builds cut short by an agent stop left under `root`, their
/// VMs ended first, and returns the templates that still fit today's
/// `sources`. `uid` is any unprivileged user, for describing leftover VMs.
pub(crate) async fn recover<E: Engine>(
    engine: &E,
    root: &Path,
    sources: &Arc<Sources>,
    uid: u32,
) -> Vec<Template> {
    let jails = chroot_base(root).join("firecracker");
    let leftovers: Vec<String> = fs::read_dir(&jails)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(VM_PREFIX))
        .collect();
    for name in leftovers {
        let shape = Shape {
            vcpus: 1,
            memory_mib: 128,
        };
        let (paths, spec) = template_vm(root, &name, shape, uid, sources);
        if let Err(error) = engine.clean_up(&spec).await {
            tracing::warn!(%error, %name, "could not end a template VM left behind");
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
    let (dir, sources) = (templates_dir(root), Arc::clone(sources));
    blocking(move || Ok(keep_fitting(&dir, &sources)))
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not look for templates");
            Vec::new()
        })
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
        if name == "vm" {
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
mod tests {
    use super::*;

    fn shape(vcpus: u8, memory_mib: u32) -> Shape {
        Shape { vcpus, memory_mib }
    }

    fn template(shape: Shape) -> Template {
        Template {
            dir: PathBuf::from("/nowhere"),
            inputs: Inputs {
                format: FORMAT,
                shape,
                files: Vec::new(),
                boot_args: String::new(),
                networked: false,
                memory: String::new(),
            },
        }
    }

    #[test]
    fn shapes_parse_and_print_alike() {
        let parsed: Shape = "2x1024".parse().unwrap();
        assert_eq!(parsed, shape(2, 1024));
        assert_eq!(parsed.to_string(), "2x1024");
        for bad in ["2", "x1024", "0x1024", "2x64", "2x1024x1", "ax1024"] {
            assert!(bad.parse::<Shape>().is_err(), "{bad}");
        }
    }

    /// One build per shape at a time; a failed build waits before the next
    /// try; a ready template is handed out until it turns out stale, and
    /// only the template found stale is forgotten.
    #[test]
    fn the_pool_builds_each_shape_once_and_retries_after_a_pause() {
        let start = Instant::now();
        let small = shape(1, 512);
        let mut pool = Pool::new(Vec::new());
        assert!(pool.take(small, start).1, "first use builds");
        assert!(!pool.take(small, start).1, "already building");
        assert!(!pool.want(small, start));

        pool.built(small, Err("boom".into()), start);
        assert!(!pool.take(small, start).1, "failed just now");
        let later = start + RETRY_AFTER;
        assert!(pool.take(small, later).1, "tried again later");

        pool.built(small, Ok(template(small)), later);
        let (ready, build) = pool.take(small, later);
        let ready = ready.unwrap();
        assert!(!build);
        assert_eq!(pool.status()[0].state, TemplateState::Ready);

        // A newer template replaces the old one; the old one turning out
        // stale afterwards must not forget the newer.
        pool.built(small, Ok(template(small)), later);
        assert!(!pool.stale(&ready, later));
        assert!(pool.take(small, later).0.is_some());

        let newer = pool.take(small, later).0.unwrap();
        assert!(pool.stale(&newer, later), "stale: rebuild");
        let (none, build) = pool.take(small, later);
        assert!(none.is_none() && !build, "already building");
        assert_eq!(pool.status()[0].state, TemplateState::Building);
    }

    #[test]
    fn inputs_name_every_change() {
        let base = template(shape(1, 512)).inputs;
        let mut other = base.clone();
        other.boot_args = "quiet".into();
        assert_ne!(base.key(), other.key());
        assert_eq!(base.key(), base.clone().key());
        assert!(base.dir_name().starts_with("1x512-"));
        assert!(base.vm_name().len() <= 64);
    }
}
