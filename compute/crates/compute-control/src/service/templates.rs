//! Templates saved from sandboxes
//! ([ADR 22](../../../../docs/adr/0022-templates-saved-from-sandboxes.md)):
//! a team's sandbox's disk captured as a stored image that creates start
//! from, and the images nothing uses any more forgotten.
//!
//! A capture saves the sandbox, then asks its owner to capture it, which
//! the host does only while it stays saved; the host stores the disk in
//! the background and later asks hear how that went. A sandbox only in
//! object storage is woken onto a host first. The template is recorded
//! once the image is stored, and checked to be there after: an image
//! stored by an earlier capture can be forgotten just as a new one finds
//! it, and is then captured, and stored, again.

use std::time::Duration;

use compute_protocol::host::{ErrorCode, Id, ImageId, LevelName, PriorityName, Reply, Request};
use tokio::time::{Instant, sleep};

use super::{Depth, Failure, Service, host_failure, new_id, now_ms};
use crate::store::{Inserted, Spec, Store, TemplateRow, valid_template_name};

/// What a create names as its image to start from a team's template:
/// this, then the template's id or name.
pub const TEMPLATE_PREFIX: &str = "template/";

/// How long a capture may take in all: saving the sandbox, and storing
/// its disk at the pace of the fleet's object storage.
const CAPTURE_WITHIN: Duration = Duration::from_secs(30 * 60);
/// How often a capture asks how the store of its disk stands.
const ASK_EVERY: Duration = Duration::from_millis(500);
/// How often a capture asks again for the save of a sandbox not yet
/// saved.
const SAVE_AGAIN_EVERY: Duration = Duration::from_secs(5);
/// How long a host may take to answer a capture. It answers before it
/// stores anything, once it has copied the disk, which shares its blocks.
const CAPTURE_WAIT: Duration = Duration::from_secs(30);
/// How long a captured image stays unused before it is forgotten: far
/// longer than a create takes from finding its template to recording its
/// sandbox, which then uses the image.
pub const UNUSED_FOR: Duration = Duration::from_secs(3600);
/// How often the images nothing uses are looked for.
pub const COLLECT_EVERY: Duration = Duration::from_secs(600);

/// What a host said to a capture.
enum Asked {
    Capturing,
    Captured {
        image: ImageId,
        length: u64,
    },
    /// It is not saved on a host, or something under way there: save it.
    NotSaved,
}

impl<S: Store> Service<S> {
    /// Captures a team's sandbox as a new template, named `name` if
    /// given: its disk, as the sandbox last saved it, becomes a stored
    /// image that creates naming the template start from, with the
    /// sandbox's shape. The sandbox is left saved.
    ///
    /// # Errors
    ///
    /// [`Failure::Invalid`] for a name creates could not use, or one the
    /// fleet gives an image; [`Failure::Exists`] when the team has a
    /// template of that name; [`Failure::Unavailable`] when the fleet has
    /// no object storage or the sandbox's host cannot capture;
    /// [`Failure::Busy`] when it is not saved long enough within half an
    /// hour, as when something holds it awake throughout.
    pub async fn capture(
        &self,
        team: &str,
        id: Id,
        name: Option<String>,
    ) -> Result<TemplateRow, Failure> {
        let Some(archive) = &self.archive else {
            return Err(Failure::Unavailable(
                "this fleet has no object storage to keep templates in".into(),
            ));
        };
        if let Some(name) = &name {
            self.check_template_name(team, name).await?;
        }
        let row = self.get(team, id).await?;
        let deadline = Instant::now() + CAPTURE_WITHIN;
        let mut key = new_id()?.to_string();
        let mut saved_at: Option<Instant> = None;
        loop {
            if Instant::now() >= deadline {
                return Err(Failure::Busy(format!(
                    "sandbox {id} did not stay saved long enough to capture it; \
                     something may hold it awake"
                )));
            }
            let (image, length) = match self.ask_capture(team, id, &key).await? {
                Asked::Captured { image, length } => (image, length),
                Asked::Capturing => {
                    sleep(ASK_EVERY).await;
                    continue;
                }
                Asked::NotSaved => {
                    if saved_at.is_none_or(|at| at.elapsed() >= SAVE_AGAIN_EVERY) {
                        saved_at = Some(Instant::now());
                        self.save_for_capture(team, id).await?;
                    }
                    sleep(ASK_EVERY).await;
                    continue;
                }
            };
            let template = TemplateRow {
                team: team.to_owned(),
                id: new_id()?.to_string(),
                name: name.clone(),
                image,
                source: id,
                vcpus: row.spec.config.vcpus,
                memory_mib: row.spec.config.memory_mib,
                disk_mib: length.div_ceil(1 << 20),
                created_ms: now_ms(),
            };
            match self.store.insert_template(&template).await? {
                Inserted::Done => {}
                Inserted::NameTaken => {
                    return Err(Failure::Exists(format!(
                        "a template named {} exists",
                        name.as_deref().unwrap_or_default()
                    )));
                }
                Inserted::Collecting => {
                    // Captured again once it is forgotten.
                    key = new_id()?.to_string();
                    sleep(ASK_EVERY).await;
                    continue;
                }
            }
            match archive.get_pointer(&image.pointer()).await {
                Ok(Some(_)) => {
                    tracing::info!(sandbox = %id, template = %template.id, %image, length, "captured a sandbox as a template");
                    return Ok(template);
                }
                Ok(None) => {
                    // Forgotten as this capture found it stored: store it
                    // again under a new capture.
                    self.store.delete_template(team, &template.id).await?;
                    key = new_id()?.to_string();
                }
                Err(error) => {
                    self.store.delete_template(team, &template.id).await?;
                    return Err(Failure::Archive(error.to_string()));
                }
            }
        }
    }

    /// Refuses a template name creates could not use: one that is not
    /// a plain word, reads as a template's id or names a fleet image, or
    /// one the team has.
    async fn check_template_name(&self, team: &str, name: &str) -> Result<(), Failure> {
        if !valid_template_name(name) || name.parse::<Id>().is_ok() {
            return Err(Failure::Invalid(format!(
                "template name {name:?} must be 1 to 64 of letters, digits, '-', '_' and '.', \
                 starting with a letter or digit, and not read as an id"
            )));
        }
        if self.settings.image_named(name).is_some() {
            return Err(Failure::Invalid(format!(
                "{name} names one of the fleet's images"
            )));
        }
        if self.store.template(team, name).await?.is_some() {
            return Err(Failure::Exists(format!("a template named {name} exists")));
        }
        Ok(())
    }

    /// Asks the owner of a team's sandbox to capture it under `key`.
    async fn ask_capture(&self, team: &str, id: Id, key: &str) -> Result<Asked, Failure> {
        let row = self.get(team, id).await?;
        let Some(target) = self.owner(&row)? else {
            return Ok(Asked::NotSaved);
        };
        let request = Request::Capture {
            id,
            generation: None,
            key: key.to_owned(),
        };
        let answered = self
            .hosts
            .call(&target, Some(row.ownership.epoch), &request, CAPTURE_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        match &answered.answer.reply {
            Reply::Capturing => Ok(Asked::Capturing),
            Reply::Captured { image, length } => Ok(Asked::Captured {
                image: *image,
                length: *length,
            }),
            // Moved, or its owner's lease is being renewed: ask again.
            Reply::Error {
                code: ErrorCode::Busy | ErrorCode::Stale | ErrorCode::Expired,
                ..
            } => Ok(Asked::NotSaved),
            Reply::Error {
                code: ErrorCode::Invalid,
                message,
            } => Err(Failure::Unavailable(format!(
                "its host {} cannot capture sandboxes: {message}",
                target.name
            ))),
            _ => Err(host_failure(&answered)),
        }
    }

    /// Has a team's sandbox saved on a host: one only in object storage
    /// is woken onto one first, as it must be to be copied.
    async fn save_for_capture(&self, team: &str, id: Id) -> Result<(), Failure> {
        let depth = self.depth(team, id).await;
        if matches!(
            depth,
            Ok(Depth::Unowned
                | Depth::At {
                    level: LevelName::Remote,
                    ..
                })
        ) {
            self.wake(team, id, PriorityName::Background).await?;
        }
        match self.sleep(team, id, LevelName::Saved).await {
            Ok(()) => Ok(()),
            Err(Failure::NotFound) => Err(Failure::NotFound),
            Err(failure) => {
                tracing::debug!(sandbox = %id, %failure, "asking for a capture's save");
                Ok(())
            }
        }
    }

    /// A team's template with the id or name `key`.
    ///
    /// # Errors
    ///
    /// When the store fails.
    pub async fn template(&self, team: &str, key: &str) -> Result<Option<TemplateRow>, Failure> {
        Ok(self.store.template(team, key).await?)
    }

    /// A team's templates, oldest first.
    ///
    /// # Errors
    ///
    /// When the store fails.
    pub async fn templates(&self, team: &str) -> Result<Vec<TemplateRow>, Failure> {
        Ok(self.store.templates(team).await?)
    }

    /// Deletes a team's template with the id or name `key`; whether it
    /// had one. Sandboxes created from it keep running; its image is
    /// forgotten once nothing has used it for [`UNUSED_FOR`].
    ///
    /// # Errors
    ///
    /// When the store fails.
    pub async fn delete_template(&self, team: &str, key: &str) -> Result<bool, Failure> {
        let Some(template) = self.store.template(team, key).await? else {
            return Ok(false);
        };
        Ok(self.store.delete_template(team, &template.id).await?)
    }

    /// The image a create of `team`'s names in `spec`: one of the fleet's
    /// by its name (`None` for the hosts' base image), or one of the
    /// team's templates as [`TEMPLATE_PREFIX`] then its id or name, which
    /// `spec` then names by its id.
    pub(super) async fn image_of(
        &self,
        team: &str,
        spec: &mut Spec,
    ) -> Result<Option<ImageId>, Failure> {
        if let Some(image) = self.settings.image_named(&spec.image) {
            return Ok(image);
        }
        if let Some(key) = spec.image.strip_prefix(TEMPLATE_PREFIX) {
            let template = self
                .store
                .template(team, key)
                .await?
                .ok_or_else(|| Failure::Invalid(format!("no such template: {key}")))?;
            spec.image = format!("{TEMPLATE_PREFIX}{}", template.id);
            return Ok(Some(template.image));
        }
        Err(Failure::Invalid(format!("no such image: {}", spec.image)))
    }

    /// Forgets the captured images nothing has used for [`UNUSED_FOR`]:
    /// marks each as being collected, which no template is recorded over,
    /// deletes its pointer in object storage, which a sweep then frees
    /// the chunks of, and deletes its record. One a replica left being
    /// collected is finished. Answers how many were forgotten.
    ///
    /// # Errors
    ///
    /// When the store or object storage fails.
    pub async fn collect_images(&self) -> Result<usize, Failure> {
        let Some(archive) = &self.archive else {
            return Ok(0);
        };
        let now = now_ms();
        let before = now.saturating_sub(u64::try_from(UNUSED_FOR.as_millis()).unwrap_or(u64::MAX));
        let mut forgotten = 0;
        for image in self.store.unused_images(now, before).await? {
            // The fleet's own images are named by its settings, not the
            // store.
            if self.settings.images.names(image) {
                continue;
            }
            if !self.store.collect_image(image, before).await? {
                continue;
            }
            archive
                .forget_pointer(&image.pointer())
                .await
                .map_err(|error| Failure::Archive(error.to_string()))?;
            self.store.collected(image).await?;
            tracing::info!(%image, "forgot a captured image nothing uses");
            forgotten += 1;
        }
        Ok(forgotten)
    }
}
