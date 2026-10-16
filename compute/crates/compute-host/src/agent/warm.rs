//! Keeping warm templates: building them in the background and handing
//! them to new sandboxes (see [`crate::pool`]).

use std::path::Path;
use std::sync::Arc;

use compute_engine::Engine;
use tokio::time::Instant;

use crate::layout::Images;
use crate::pool::{self, Build, Pool, PoolConfig, Shape, Sources, Template};
use crate::store::Store;

use super::{Event, HostAgent, Warm};

impl Warm {
    /// Sets up the templates of a starting agent, if it keeps any: ends the
    /// VMs of builds an earlier agent left, keeps the templates that still
    /// fit today's inputs, and returns the shapes to build at once.
    pub(super) async fn start<E: Engine>(
        config: Option<PoolConfig>,
        engine: &E,
        root: &Path,
        base_image: &Path,
        networked: bool,
        images: &Images,
    ) -> (Option<Self>, Vec<Shape>) {
        let Some(config) = config else {
            return (None, Vec::new());
        };
        let sources = Arc::new(Sources {
            kernel: images.kernel.clone(),
            base_image: base_image.to_owned(),
            depends_on: config.depends_on,
            boot_args: images.boot_args.clone(),
            networked,
            memory: format!("{:?}", engine.memory_profile()),
        });
        let ready = pool::recover(engine, root, &sources, images.first_uid).await;
        let warm = Self {
            pool: Pool::new(ready),
            sources,
            ready_port: config.ready_port,
            ready_timeout: config.ready_timeout,
        };
        (Some(warm), config.shapes)
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
    }

    /// Records a finished build and frees the user its VM ran as.
    pub(super) fn template_built(
        &mut self,
        shape: Shape,
        ordinal: u32,
        result: Result<Template, String>,
    ) {
        self.ordinals.remove(&ordinal);
        if let Some(warm) = &mut self.warm {
            warm.pool.built(shape, result, Instant::now());
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
                    result: Err(problem),
                });
                return;
            }
        };
        let build = Build {
            root: self.root.clone(),
            sources,
            shape,
            uid,
            ready_port,
            ready_timeout,
        };
        let engine = Arc::clone(&self.engine);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let result = pool::build(&*engine, build).await;
            let _ = events.send(Event::TemplateBuilt {
                shape,
                ordinal,
                result,
            });
        });
    }
}
