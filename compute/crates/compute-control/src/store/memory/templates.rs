//! Templates, and the captured and built images' records, in memory (see
//! [`crate::store::Store`]). Every use recorded of an image and every
//! claim on it happen under the store's one lock, so they take turns.

use compute_protocol::host::ImageId;

use super::Inner;
use crate::store::{Collector, Inserted, SandboxRow, TEMPLATE_PREFIX, TemplateRow};

/// A captured or built image's record.
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
            || self.latest_builds().any(|built| built == image)
    }

    /// The image of the source each name used last.
    fn latest_builds(&self) -> impl Iterator<Item = ImageId> + '_ {
        let mut seen = std::collections::HashSet::new();
        self.image_uses
            .iter()
            .rev()
            .filter(move |(name, _)| seen.insert(name.as_str()))
            .filter_map(|(_, source)| self.built.get(source).copied())
    }

    /// Whether a collector claimed `image` to forget it.
    fn collecting_image(&self, image: ImageId) -> bool {
        self.captured
            .get(&image)
            .is_some_and(|captured| captured.claim.is_some())
    }

    pub(super) fn image_built(&self, source: &str) -> Option<ImageId> {
        self.built
            .get(source)
            .copied()
            .filter(|image| !self.collecting_image(*image))
    }

    pub(super) fn record_built(
        &mut self,
        source: &str,
        name: &str,
        image: ImageId,
    ) -> Option<ImageId> {
        let recorded = self.built.get(source).copied().unwrap_or(image);
        if self.collecting_image(recorded) {
            return None;
        }
        self.built.insert(source.to_owned(), recorded);
        // The one offered when another was recorded first is stored too,
        // and nothing uses it.
        self.captured.entry(image).or_default();
        self.captured.entry(recorded).or_default().unused_ms = None;
        self.image_uses
            .retain(|(named, used)| named != name || used != source);
        self.image_uses.push((name.to_owned(), source.to_owned()));
        Some(recorded)
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
            // The builds that made it go with it.
            self.built.retain(|_, built| *built != image);
            let built = &self.built;
            self.image_uses
                .retain(|(_, source)| built.contains_key(source));
        }
    }
}
