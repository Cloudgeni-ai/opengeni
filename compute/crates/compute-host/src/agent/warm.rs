//! Keeping warm templates: building them in the background and handing
//! them to new sandboxes (see [`crate::pool`]).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use compute_core::{DiskSpace, Input};
use compute_engine::Engine;
use tokio::time::Instant;

use crate::layout::{Images, templates_dir};
use crate::pool::{self, Build, Built, Held, Pool, PoolConfig, Shape, Sources, Template, Uses};
use crate::protocol::Id;
use crate::store::Store;

use super::{Event, HostAgent, SAVE_EXTRA, Warm};

/// How a starting agent stands with templates.
pub(super) struct Started {
    /// Its templates, if it keeps any.
    pub warm: Option<Warm>,
    /// The shapes to build at once.
    pub shapes: Vec<Shape>,
    /// Builds an earlier agent left whose VMs may still run.
    pub held: Vec<Held>,
    /// How many ready sandboxes to keep of each shape.
    pub ready: BTreeMap<Shape, u32>,
}

impl Warm {
    /// Sets up the templates of a starting agent: ends the VMs of builds an
    /// earlier agent left (whether or not this one keeps templates), and,
    /// if it keeps any, keeps the templates that still fit today's inputs
    /// and whose shapes have been used lately; the others retire.
    pub(super) async fn start<E: Engine>(
        config: Option<PoolConfig>,
        engine: &E,
        root: &Path,
        base_image: &Path,
        networked: bool,
        images: &Images,
    ) -> Started {
        let (depends_on, ready_port) = config.as_ref().map_or((Vec::new(), 0), |config| {
            (config.depends_on.clone(), config.ready_port)
        });
        let sources = Arc::new(Sources {
            kernel: images.kernel.clone(),
            base_image: base_image.to_owned(),
            depends_on,
            boot_args: images.boot_args.clone(),
            networked,
            memory: format!("{:?}", engine.memory_profile()),
            ready_port,
            hashes: std::sync::Mutex::default(),
        });
        let held = pool::end_leftover_builds(engine, root, &sources, images.first_uid).await;
        let Some(config) = config else {
            return Started {
                warm: None,
                shapes: Vec::new(),
                held,
                ready: BTreeMap::new(),
            };
        };
        let found = pool::keep_templates(root, &sources).await;
        let now = SystemTime::now();
        let uses = Uses::load(
            &templates_dir(root),
            config.unused_after,
            config
                .shapes
                .iter()
                .copied()
                .chain(found.iter().map(Template::shape)),
            now,
        );
        let unused = uses.unused(now);
        let (found, retiring): (Vec<_>, Vec<_>) = found
            .into_iter()
            .partition(|template| !unused.contains(&template.shape()));
        for template in retiring {
            tokio::spawn(pool::remove(&template));
        }
        let mut pool = Pool::new(found.iter().map(Template::shape));
        for shape in &unused {
            pool.retire(*shape);
        }
        Started {
            warm: Some(Self {
                pool,
                found,
                sources,
                ready_port: config.ready_port,
                ready_timeout: config.ready_timeout,
                uses,
            }),
            shapes: config
                .shapes
                .into_iter()
                .filter(|shape| !unused.contains(shape))
                .collect(),
            held,
            ready: config.ready,
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Checks the templates an earlier agent left, in the background, and
    /// builds those of `shapes` that have none. A template being checked is
    /// not used yet: sandboxes of its shape boot cold meanwhile.
    pub(super) fn start_templates(&mut self, shapes: Vec<Shape>) {
        let found = self
            .warm
            .as_mut()
            .map(|warm| std::mem::take(&mut warm.found))
            .unwrap_or_default();
        for template in found {
            let events = self.events_tx.clone();
            tokio::spawn(async move {
                let shape = template.shape();
                let result = Box::new(pool::check_found(template).await);
                let _ = events.send(Event::TemplateChecked { shape, result });
            });
        }
        for shape in shapes {
            self.want_template(shape);
        }
    }

    /// Uses a checked template, or builds a new one if it failed.
    pub(super) fn template_checked(&mut self, shape: Shape, result: Result<Template, String>) {
        let Some(warm) = &mut self.warm else {
            return;
        };
        if warm.pool.checked(shape, result) {
            self.build_template(shape);
        }
    }

    /// Starts building `shape`'s template unless it is ready or on its way.
    pub(super) fn want_template(&mut self, shape: Shape) {
        let Some(warm) = &mut self.warm else {
            return;
        };
        if warm.pool.want(shape, Instant::now()) {
            self.build_template(shape);
        }
    }

    /// The template a new sandbox of `shape` starts from, if one is ready.
    /// Without one, its build starts in the background: the sandbox boots
    /// cold rather than wait.
    pub(super) fn template_for(&mut self, shape: Shape) -> Option<Arc<Template>> {
        let warm = self.warm.as_mut()?;
        let (template, build) = warm.pool.take(shape, Instant::now());
        if build {
            self.build_template(shape);
        }
        template
    }

    /// Records a create of `shape`, which keeps its template from retiring.
    pub(super) fn template_used(&mut self, shape: Shape) {
        let Some(warm) = &mut self.warm else {
            return;
        };
        let now = SystemTime::now();
        if let Some(mark) = warm.uses.used(shape, now) {
            tokio::task::spawn_blocking(move || pool::write_use(mark, now));
        }
    }

    /// Retires the templates of shapes unused for long, with their ready
    /// sandboxes. A template being built retires once built.
    pub(super) fn retire_unused(&mut self) {
        let Some(warm) = &mut self.warm else {
            return;
        };
        let mut retired = Vec::new();
        for shape in warm.uses.unused(SystemTime::now()) {
            if let Some(gone) = warm.pool.retire(shape) {
                retired.push(shape);
                if let Some(template) = gone.template {
                    tokio::spawn(pool::remove(&template));
                }
            }
        }
        for shape in retired {
            self.discard_stale_ready(shape);
        }
    }

    /// Forgets `template`, which no longer fits today's inputs, and builds
    /// its replacement.
    pub(super) fn template_stale(&mut self, template: &Arc<Template>) {
        let Some(warm) = &mut self.warm else {
            return;
        };
        if warm.pool.stale(template, Instant::now()) {
            self.build_template(template.shape());
        }
        // Ready sandboxes cloned from it are as stale.
        self.discard_stale_ready(template.shape());
    }

    /// Records a finished build and frees the user its VM ran as, once
    /// the VM is proven gone. Otherwise the ordinal stays taken until the
    /// next start of the agent ends the VM.
    pub(super) fn template_built(&mut self, shape: Shape, ordinal: u32, built: Built) {
        if built.ended {
            self.ordinals.remove(&ordinal);
        }
        let booked = self.ready.building.remove(&shape);
        if let Some(name) = booked {
            self.spare_gone(name, built.ended);
        }
        if let Some(vm) = built.vm {
            if built.ended {
                self.build_left(vm, None);
            } else if booked.is_some() {
                self.build_left(vm, booked);
            }
        }
        if let Some(warm) = &mut self.warm {
            warm.pool.built(shape, built.result, Instant::now());
        }
    }

    /// Keeps one booking of host memory per build VM that may still run:
    /// `still` names the one its memory is counted under now, or is
    /// `None` once the VM is proven gone. A build that ends proves gone
    /// any earlier VM of its name, since it cleans that up first.
    fn build_left(&mut self, vm: String, still: Option<Id>) {
        let earlier = match still {
            Some(name) => self.ready.left_builds.insert(vm, name),
            None => self.ready.left_builds.remove(&vm),
        };
        if let Some(earlier) = earlier.filter(|earlier| Some(*earlier) != still) {
            self.input(Input::Unmanaged {
                sandbox: earlier.0,
                bytes: 0,
            });
        }
    }

    /// Keeps the ordinals of builds an earlier agent left running taken,
    /// and their memory counted as unmanaged until a build of the same
    /// name proves them gone or the next start of the agent ends them.
    /// Such a VM may have stopped part way through coming up, so what it
    /// may still take stays claimed above the high watermark meanwhile,
    /// as for a build of this agent that could not be ended.
    /// One whose ordinal is unknown could clash with any new sandbox, so
    /// none is created while it may run.
    pub(super) fn hold_builds(&mut self, held: Vec<Held>) {
        for build in held {
            match build.ordinal {
                Some(ordinal) => {
                    self.ordinals.insert(ordinal);
                }
                None => {
                    self.unknown_builds.insert(build.name.clone());
                }
            }
            let name = self.spare_name();
            self.inputs([
                Input::Spare {
                    sandbox: name.0,
                    bytes: build.bytes,
                    disk: DiskSpace::default(),
                    filling: true,
                },
                Input::Unmanaged {
                    sandbox: name.0,
                    bytes: build.bytes,
                },
            ]);
            self.build_left(build.name, Some(name));
        }
    }

    /// Builds `shape`'s template in the background. Its VM runs as the user
    /// of an ordinal reserved for the build, so it shares a user with no
    /// sandbox. Its memory, and the disk its snapshot may write, are booked
    /// with the core as a spare VM's, within what the core can spare;
    /// without that room it waits as after a failed build, and sandboxes
    /// boot cold meanwhile.
    fn build_template(&mut self, shape: Shape) {
        let Some((sources, ready_port, ready_timeout)) = self.warm.as_ref().map(|warm| {
            (
                Arc::clone(&warm.sources),
                warm.ready_port,
                warm.ready_timeout,
            )
        }) else {
            return;
        };
        let disk = pool::build_disk(shape, &sources.base_image, self.save_copies, SAVE_EXTRA);
        if !disk
            .as_ref()
            .is_ok_and(|disk| self.core.spare_fits(shape.bytes(), *disk))
        {
            if let Some(warm) = &mut self.warm {
                let problem = match &disk {
                    Ok(_) => "the host has no memory or disk to spare for a template build".into(),
                    Err(error) => format!("reading the base image: {error}"),
                };
                warm.pool.built(shape, Err(problem), Instant::now());
            }
            return;
        }
        let disk = disk.unwrap_or_default();
        let ordinal = match self.take_ordinal() {
            Ok(ordinal) => ordinal,
            Err(problem) => {
                if let Some(warm) = &mut self.warm {
                    warm.pool.built(shape, Err(problem), Instant::now());
                }
                return;
            }
        };
        let uid = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation.uid,
            Err(problem) => {
                let _ = self.events_tx.send(Event::TemplateBuilt {
                    shape,
                    ordinal,
                    built: Built {
                        result: Err(problem),
                        ended: true,
                        vm: None,
                    },
                });
                return;
            }
        };
        let job = Build {
            root: self.root.clone(),
            sources,
            shape,
            ordinal,
            lender: self.lender.clone(),
            uid,
            ready_port,
            ready_timeout,
        };
        let name = self.spare_name();
        self.ready.building.insert(shape, name);
        self.book_spare(name, shape.bytes(), disk, true);
        let engine = Arc::clone(&self.engine);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let built = pool::build(&*engine, job).await;
            let _ = events.send(Event::TemplateBuilt {
                shape,
                ordinal,
                built,
            });
        });
    }
}
