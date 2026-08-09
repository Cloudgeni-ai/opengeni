use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::ParagraphLayout;

pub(super) type LayoutCacheKey = [u8; 32];

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LayoutCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub estimated_bytes: usize,
}

#[derive(Debug)]
struct CacheEntry {
    value: Arc<ParagraphLayout>,
    estimated_bytes: usize,
    used_at: u64,
}

/// Deterministic byte-bounded LRU. It deliberately owns immutable layouts so
/// readers can retain an `Arc` while eviction immediately releases the cache's
/// ownership without invalidating in-flight paint work.
#[derive(Debug)]
pub(super) struct LayoutCache {
    entries: BTreeMap<LayoutCacheKey, CacheEntry>,
    recency: BTreeSet<(u64, LayoutCacheKey)>,
    max_entries: usize,
    max_bytes: usize,
    bytes: usize,
    clock: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl LayoutCache {
    pub(super) fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            recency: BTreeSet::new(),
            max_entries,
            max_bytes,
            bytes: 0,
            clock: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    /// Returns a cached layout. A miss deliberately has no observable side
    /// effect: callers record it only after an uncached layout succeeds, so a
    /// rejected/over-budget request leaves cache state byte-for-byte stable.
    pub(super) fn get(&mut self, key: &LayoutCacheKey) -> Option<Arc<ParagraphLayout>> {
        let entry = self.entries.get_mut(key)?;
        self.recency.remove(&(entry.used_at, *key));
        self.clock = self.clock.wrapping_add(1).max(1);
        entry.used_at = self.clock;
        self.recency.insert((entry.used_at, *key));
        self.hits = self.hits.saturating_add(1);
        Some(Arc::clone(&entry.value))
    }

    pub(super) fn insert(&mut self, key: LayoutCacheKey, value: Arc<ParagraphLayout>) {
        self.misses = self.misses.saturating_add(1);
        let estimated_bytes = value.estimated_bytes();
        if self.max_entries == 0 || self.max_bytes == 0 || estimated_bytes > self.max_bytes {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.recency.remove(&(previous.used_at, key));
            self.bytes = self.bytes.saturating_sub(previous.estimated_bytes);
        }
        self.clock = self.clock.wrapping_add(1).max(1);
        self.bytes = self.bytes.saturating_add(estimated_bytes);
        self.recency.insert((self.clock, key));
        self.entries.insert(
            key,
            CacheEntry {
                value,
                estimated_bytes,
                used_at: self.clock,
            },
        );
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some((used_at, victim)) = self.recency.iter().next().copied() else {
                break;
            };
            self.recency.remove(&(used_at, victim));
            if let Some(removed) = self.entries.remove(&victim) {
                self.bytes = self.bytes.saturating_sub(removed.estimated_bytes);
                self.evictions = self.evictions.saturating_add(1);
            }
        }
    }

    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.recency.clear();
        self.bytes = 0;
    }

    pub(super) fn stats(&self) -> LayoutCacheStats {
        LayoutCacheStats {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: self.entries.len(),
            estimated_bytes: self.bytes,
        }
    }
}
