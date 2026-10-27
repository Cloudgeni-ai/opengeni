//! Templates and captured images in memory (see [`crate::store::Store`]).
//! Every use recorded of a captured image and every claim on it happen
//! under the store's one lock, so they take turns.

use compute_protocol::host::ImageId;

use super::Inner;
use crate::store::{Collector, Inserted, SandboxRow, TEMPLATE_PREFIX, TemplateRow};

/// A captured image's record.
#[derive(Clone, Debug, Default)]
pub(super) struct Captured {
    /// Since when nothing uses it, as last noted.
    unused_ms: Option<u64>,
    /// The collector that claimed it to forget it, and when.
    claim: Option<(String, u64)>,
}

impl Inner {
    fn image_used(&self, image: ImageId) -> bool {
        self.templates.values().any(|row| row.image == image)
            || self
                .sandboxes
                .values()
                .any(|row| row.spec.config.image == Some(image))
            || self.built.values().any(|built| *built == image)
    }

    /// Whether `row` is created from a team's template that is gone.
    pub(super) fn template_gone(&self, row: &SandboxRow) -> bool {
        row.spec
            .image
            .strip_prefix(TEMPLATE_PREFIX)
            .is_some_and(|id| {
                !self
                    .templates
                    .contains_key(&(row.team.clone(), id.to_owned()))
            })
    }

    pub(super) fn insert_template(&mut self, row: &TemplateRow) -> Inserted {
        let captured = self.captured.entry(row.image).or_default();
        if captured.claim.is_some() {
            return Inserted::Collecting;
        }
        let taken = row.name.as_ref().is_some_and(|name| {
            self.templates
                .values()
                .any(|other| other.team == row.team && other.name.as_ref() == Some(name))
        });
        if taken
            || self
                .templates
                .contains_key(&(row.team.clone(), row.id.clone()))
        {
            return Inserted::NameTaken;
        }
        if let Some(captured) = self.captured.get_mut(&row.image) {
            captured.unused_ms = None;
        }
        self.templates
            .insert((row.team.clone(), row.id.clone()), row.clone());
        Inserted::Done
    }

    pub(super) fn template(&self, team: &str, key: &str) -> Option<TemplateRow> {
        self.templates
            .get(&(team.to_owned(), key.to_owned()))
            .or_else(|| {
                self.templates
                    .values()
                    .find(|row| row.team == team && row.name.as_deref() == Some(key))
            })
            .cloned()
    }

    pub(super) fn templates(&self, team: &str) -> Vec<TemplateRow> {
        let mut rows: Vec<TemplateRow> = self
            .templates
            .values()
            .filter(|row| row.team == team)
            .cloned()
            .collect();
        rows.sort_by(|a, b| (a.created_ms, &a.id).cmp(&(b.created_ms, &b.id)));
        rows
    }

    pub(super) fn delete_template(&mut self, team: &str, id: &str) -> bool {
        self.templates
            .remove(&(team.to_owned(), id.to_owned()))
            .is_some()
    }

    pub(super) fn unused_images(&mut self, now_ms: u64, before_ms: u64) -> Vec<ImageId> {
        let images: Vec<ImageId> = self.captured.keys().copied().collect();
        let mut collect = Vec::new();
        for image in images {
            let used = self.image_used(image);
            let Some(captured) = self.captured.get_mut(&image) else {
                continue;
            };
            if captured.claim.is_some() {
                collect.push(image);
                continue;
            }
            captured.unused_ms = if used {
                None
            } else {
                Some(captured.unused_ms.unwrap_or(now_ms))
            };
            if captured.unused_ms.is_some_and(|since| since < before_ms) {
                collect.push(image);
            }
        }
        collect.sort();
        collect
    }

    pub(super) fn collect_image(
        &mut self,
        image: ImageId,
        before_ms: u64,
        collector: &Collector,
    ) -> bool {
        let used = self.image_used(image);
        let Some(captured) = self.captured.get_mut(&image) else {
            return false;
        };
        let claim = Some((collector.id.clone(), collector.at_ms));
        if let Some((holder, at)) = &captured.claim {
            if *holder == collector.id {
                return true;
            }
            if *at >= collector.lapsed_ms {
                return false;
            }
            // Lapsed: taken over. Nothing recorded a use of it meanwhile.
            captured.claim = claim;
            return true;
        }
        if used {
            captured.unused_ms = None;
            return false;
        }
        if captured.unused_ms.is_none_or(|since| since >= before_ms) {
            return false;
        }
        captured.claim = claim;
        true
    }

    pub(super) fn collecting(&self, image: ImageId, collector: &str) -> bool {
        self.captured.get(&image).is_some_and(|captured| {
            captured
                .claim
                .as_ref()
                .is_some_and(|(holder, _)| holder == collector)
        })
    }

    pub(super) fn collected(&mut self, image: ImageId, collector: &str) {
        if self.collecting(image, collector) {
            self.captured.remove(&image);
        }
    }
}
