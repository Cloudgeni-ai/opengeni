//! Keeping warm templates: building them in the background and handing
//! them to new sandboxes (see [`crate::pool`]).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use compute_engine::Engine;
use tokio::time::Instant;

use crate::layout::Images;
use crate::pool::{self, Build, Built, Held, Pool, PoolConfig, Shape, Sources, Template};
use crate::store::Store;

use super::{Event, HostAgent, Warm};

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
    /// if it keeps any, keeps the templates that still fit today's inputs.
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
        let ready = pool::keep_templates(root, &sources).await;
        Started {
            warm: Some(Self {
                pool: Pool::new(ready),
                sources,
                ready_port: config.ready_port,
                ready_timeout: config.ready_timeout,
            }),
            shapes: config.shapes,
            held,
            ready: config.ready,
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
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
        if let Some(warm) = &mut self.warm {
            warm.pool.built(shape, built.result, Instant::now());
        }
    }

    /// Keeps the ordinals of builds an earlier agent left running taken.
    /// One whose ordinal is unknown could clash with any new sandbox, so
    /// none is created while it may run.
    pub(super) fn hold_builds(&mut self, held: Vec<Held>) {
        for build in held {
            match build.ordinal {
                Some(ordinal) => {
                    self.ordinals.insert(ordinal);
                }
                None => {
                    self.unknown_builds.insert(build.name);
                }
            }
        }
    }

    /// Builds `shape`'s template in the background. Its VM runs as the user
    /// of an ordinal reserved for the build, so it shares a user with no
    /// sandbox.
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
        let ordinal = self.take_ordinal();
        let uid = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation.uid,
            Err(problem) => {
                let _ = self.events_tx.send(Event::TemplateBuilt {
                    shape,
                    ordinal,
                    built: Built {
                        result: Err(problem),
                        ended: true,
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
