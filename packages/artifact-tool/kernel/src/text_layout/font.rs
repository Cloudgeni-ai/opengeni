use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rustybuzz::Face;
use sha2::{Digest, Sha256};

use super::{FontStyle, LayoutError, LayoutLimits};

const FONT_ID_DOMAIN: &[u8] = b"opengeni:artifact:font-face:v1\0";

/// SHA-256 of the exact caller-supplied font asset bytes.
#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FontAssetHash([u8; 32]);

impl FontAssetHash {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    #[must_use]
    pub fn to_hex(self) -> String {
        hex(&self.0)
    }
}

impl fmt::Debug for FontAssetHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("FontAssetHash")
            .field(&self.to_hex())
            .finish()
    }
}

/// Stable content-addressed identity for one face in a supplied font asset.
///
/// A collection face index participates in the identity. Family aliases and
/// style metadata do not: hosts can rename an explicit asset without changing
/// caches or persisted render commands.
#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FontId([u8; 16]);

impl FontId {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    #[must_use]
    pub fn is_zero(self) -> bool {
        self.0.iter().all(|byte| *byte == 0)
    }

    #[must_use]
    pub fn to_hex(self) -> String {
        hex(&self.0)
    }
}

impl fmt::Debug for FontId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("FontId")
            .field(&self.to_hex())
            .finish()
    }
}

/// Host-controlled metadata for an explicitly supplied OpenType face.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FontDescriptor {
    pub family: String,
    pub aliases: Vec<String>,
    pub weight: u16,
    pub style: FontStyle,
}

impl FontDescriptor {
    pub fn new(family: impl Into<String>) -> Self {
        Self {
            family: family.into(),
            aliases: Vec::new(),
            weight: 400,
            style: FontStyle::Normal,
        }
    }
}

/// Exact metrics and identity returned after registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisteredFont {
    pub id: FontId,
    pub asset_hash: FontAssetHash,
    pub face_index: u32,
    pub descriptor: FontDescriptor,
    pub units_per_em: u16,
    pub ascender: i16,
    pub descender: i16,
    pub line_gap: i16,
    pub asset_bytes: usize,
}

#[derive(Clone, Debug)]
struct FontRecord {
    metadata: RegisteredFont,
    bytes: Arc<[u8]>,
    coverage: BTreeMap<char, bool>,
}

impl FontRecord {
    fn face(&self) -> Result<Face<'_>, LayoutError> {
        Face::from_slice(&self.bytes, self.metadata.face_index)
            .ok_or(LayoutError::InvalidFont("registered face no longer parses"))
    }

    fn cached_support(&self, character: char) -> Option<bool> {
        if is_formatting_character(character) {
            return Some(true);
        }
        self.coverage.get(&character).copied()
    }

    fn compute_support(&self, character: char) -> Result<bool, LayoutError> {
        if is_formatting_character(character) {
            return Ok(true);
        }
        Ok(self.face()?.glyph_index(character).is_some())
    }
}

/// Bounded, explicit font authority shared by document and presentation layout.
///
/// The registry never probes the operating system, consults a browser font
/// stack, or performs network I/O. Native servers, persistent machines and
/// browser Wasm therefore resolve the same asset bytes to the same face.
#[derive(Clone, Debug)]
pub struct FontRegistry {
    fonts: BTreeMap<FontId, FontRecord>,
    families: BTreeMap<String, Vec<FontId>>,
    total_bytes: usize,
    generation: u64,
    limits: LayoutLimits,
}

impl FontRegistry {
    #[must_use]
    pub fn new(limits: LayoutLimits) -> Self {
        Self {
            fonts: BTreeMap::new(),
            families: BTreeMap::new(),
            total_bytes: 0,
            generation: 0,
            limits,
        }
    }

    /// Validates and registers one face. Re-registering the exact same face and
    /// descriptor is allocation-free and returns its existing identity.
    pub fn register(
        &mut self,
        bytes: impl Into<Arc<[u8]>>,
        face_index: u32,
        descriptor: FontDescriptor,
    ) -> Result<RegisteredFont, LayoutError> {
        validate_descriptor(&descriptor)?;
        let bytes = bytes.into();
        if bytes.is_empty() || bytes.len() > self.limits.max_font_asset_bytes {
            return Err(LayoutError::LimitExceeded("font asset bytes"));
        }

        let asset_hash = FontAssetHash(Sha256::digest(bytes.as_ref()).into());
        let id = derive_font_id(asset_hash, face_index);
        if let Some(existing) = self.fonts.get(&id) {
            if existing.metadata.asset_hash != asset_hash
                || existing.metadata.face_index != face_index
                || existing.metadata.descriptor != descriptor
            {
                return Err(LayoutError::FontIdentityConflict(id));
            }
            return Ok(existing.metadata.clone());
        }
        if self.fonts.len() >= self.limits.max_registered_fonts {
            return Err(LayoutError::LimitExceeded("registered fonts"));
        }
        let next_total = self
            .total_bytes
            .checked_add(bytes.len())
            .ok_or(LayoutError::LimitExceeded("font registry bytes"))?;
        if next_total > self.limits.max_font_registry_bytes {
            return Err(LayoutError::LimitExceeded("font registry bytes"));
        }

        let face = Face::from_slice(&bytes, face_index).ok_or(LayoutError::InvalidFont(
            "font bytes or collection face index are invalid",
        ))?;
        if face.units_per_em() <= 0 {
            return Err(LayoutError::InvalidFont("units-per-em must be positive"));
        }
        let metadata = RegisteredFont {
            id,
            asset_hash,
            face_index,
            descriptor: descriptor.clone(),
            units_per_em: u16::try_from(face.units_per_em())
                .map_err(|_| LayoutError::InvalidFont("units-per-em is out of range"))?,
            ascender: face.ascender(),
            descender: face.descender(),
            line_gap: face.line_gap(),
            asset_bytes: bytes.len(),
        };
        drop(face);

        let mut names = BTreeSet::new();
        names.insert(canonical_family(&descriptor.family)?);
        for alias in &descriptor.aliases {
            names.insert(canonical_family(alias)?);
        }
        self.fonts.insert(
            id,
            FontRecord {
                metadata: metadata.clone(),
                bytes,
                coverage: BTreeMap::new(),
            },
        );
        for name in names {
            let family = self.families.entry(name).or_default();
            family.push(id);
            family.sort_by_key(|candidate| {
                let descriptor = &self.fonts[candidate].metadata.descriptor;
                (descriptor.style, descriptor.weight, *candidate)
            });
        }
        self.total_bytes = next_total;
        self.generation = self.generation.wrapping_add(1).max(1);
        Ok(metadata)
    }

    #[must_use]
    pub fn get(&self, id: FontId) -> Option<&RegisteredFont> {
        self.fonts.get(&id).map(|record| &record.metadata)
    }

    /// Resolves a retained glyph run only when both its face identity and the
    /// full asset digest match the registered bytes. Renderers must call this
    /// before constructing a glyph atlas; a truncated-id collision or stale
    /// asset mapping therefore fails closed.
    pub fn resolve_retained_font(
        &self,
        id: FontId,
        asset_hash: FontAssetHash,
    ) -> Result<&RegisteredFont, LayoutError> {
        let metadata = self.get(id).ok_or(LayoutError::UnknownFont(id))?;
        if metadata.asset_hash != asset_hash {
            return Err(LayoutError::FontAssetMismatch(id));
        }
        Ok(metadata)
    }

    /// Returns a ref-counted view of the exact registered bytes for glyph-atlas
    /// construction. No copy occurs and no alternate platform font is opened.
    #[must_use]
    pub fn asset_bytes(&self, id: FontId) -> Option<Arc<[u8]>> {
        self.fonts.get(&id).map(|record| Arc::clone(&record.bytes))
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub const fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.fonts.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fonts.is_empty()
    }

    fn record(&self, id: FontId) -> Result<&FontRecord, LayoutError> {
        self.fonts.get(&id).ok_or(LayoutError::UnknownFont(id))
    }

    pub(super) fn candidates_for_family(
        &self,
        family: &str,
        weight: u16,
        style: FontStyle,
    ) -> Result<Vec<FontId>, LayoutError> {
        let key = canonical_family(family)?;
        let Some(ids) = self.families.get(&key) else {
            return Ok(Vec::new());
        };
        let mut ids = ids.clone();
        ids.sort_by_key(|id| {
            let descriptor = &self.fonts[id].metadata.descriptor;
            (
                u8::from(descriptor.style != style),
                descriptor.weight.abs_diff(weight),
                *id,
            )
        });
        Ok(ids)
    }

    pub(super) fn supports_grapheme_staged(
        &self,
        id: FontId,
        grapheme: &str,
        staged: &mut BTreeMap<FontId, BTreeMap<char, bool>>,
    ) -> Result<bool, LayoutError> {
        let record = self.fonts.get(&id).ok_or(LayoutError::UnknownFont(id))?;
        for character in grapheme.chars() {
            let supported = record
                .cached_support(character)
                .or_else(|| {
                    staged
                        .get(&id)
                        .and_then(|entries| entries.get(&character).copied())
                })
                .map(Ok)
                .unwrap_or_else(|| record.compute_support(character))?;
            if record.cached_support(character).is_none()
                && staged
                    .get(&id)
                    .and_then(|entries| entries.get(&character))
                    .is_none()
            {
                staged.entry(id).or_default().insert(character, supported);
            }
            if !supported {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Commits coverage learned by one successful layout. Failed layouts drop
    /// their staged entries, preserving the registry/cache state atomically.
    pub(super) fn commit_coverage(
        &mut self,
        staged: BTreeMap<FontId, BTreeMap<char, bool>>,
    ) -> Result<(), LayoutError> {
        let maximum = self.limits.max_font_coverage_cache_entries_per_face;
        if maximum == 0 {
            return Ok(());
        }
        if let Some(id) = staged.keys().find(|id| !self.fonts.contains_key(id)) {
            return Err(LayoutError::UnknownFont(*id));
        }
        for (id, entries) in staged {
            let record = self
                .fonts
                .get_mut(&id)
                .ok_or(LayoutError::UnknownFont(id))?;
            for (character, supported) in entries {
                if record.coverage.len() >= maximum {
                    record.coverage.clear();
                }
                record.coverage.insert(character, supported);
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn coverage_entry_count(&self) -> usize {
        self.fonts
            .values()
            .map(|record| record.coverage.len())
            .sum()
    }

    pub(super) fn face(&self, id: FontId) -> Result<Face<'_>, LayoutError> {
        self.record(id)?.face()
    }
}

fn validate_descriptor(descriptor: &FontDescriptor) -> Result<(), LayoutError> {
    canonical_family(&descriptor.family)?;
    if !(1..=1_000).contains(&descriptor.weight) {
        return Err(LayoutError::InvalidFontDescriptor(
            "weight must be 1..=1000",
        ));
    }
    if descriptor.aliases.len() > 64 {
        return Err(LayoutError::LimitExceeded("font aliases"));
    }
    for alias in &descriptor.aliases {
        canonical_family(alias)?;
    }
    Ok(())
}

pub(super) fn canonical_family(value: &str) -> Result<String, LayoutError> {
    if value.len() > 256 {
        return Err(LayoutError::LimitExceeded("font family bytes"));
    }
    let normalized = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if normalized.is_empty() || normalized.chars().any(char::is_control) {
        return Err(LayoutError::InvalidFontDescriptor(
            "font family must be non-empty printable text",
        ));
    }
    Ok(normalized)
}

fn derive_font_id(hash: FontAssetHash, face_index: u32) -> FontId {
    let mut digest = Sha256::new();
    digest.update(FONT_ID_DOMAIN);
    digest.update(hash.as_bytes());
    digest.update(face_index.to_le_bytes());
    let digest = digest.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    FontId(id)
}

pub(super) const fn font_asset_hash_from_protocol(bytes: [u8; 32]) -> FontAssetHash {
    FontAssetHash::from_bytes(bytes)
}

fn is_formatting_character(character: char) -> bool {
    matches!(
        character,
        '\n' | '\r' | '\t' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}'
    ) || ('\u{fe00}'..='\u{fe0f}').contains(&character)
        || ('\u{e0100}'..='\u{e01ef}').contains(&character)
        || ('\u{202a}'..='\u{202e}').contains(&character)
        || ('\u{2066}'..='\u{2069}').contains(&character)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}
