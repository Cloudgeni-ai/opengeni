//! The fleet's pointers in memory (see [`crate::store::Store`]). Every
//! write, import and registration happens under the store's one lock, so
//! they take turns.

use std::collections::BTreeMap;

use compute_fleet::{HostState, Stamp};

use super::Inner;
use crate::store::{Found, Import, Imported, PointerRow};

/// The fleet's pointers, by name, and whether they were imported.
#[derive(Debug, Default)]
pub(super) struct Pointers {
    rows: BTreeMap<String, PointerRow>,
    /// The last version given.
    version: i64,
    imported: Option<Imported>,
}

impl Pointers {
    fn next(&mut self) -> i64 {
        self.version += 1;
        self.version
    }
}

impl Inner {
    /// Whether a host that does or does not keep its pointers in the
    /// service (`in_service`) is outdated: one that does not, once the
    /// fleet's pointers are imported.
    pub(super) fn outdated(&self, in_service: bool) -> bool {
        !in_service && self.pointers.imported.is_some()
    }

    pub(super) fn pointer(&self, name: &str) -> Option<PointerRow> {
        self.pointers.rows.get(name).cloned()
    }

    pub(super) fn write_pointer(
        &mut self,
        name: &str,
        owner: Stamp,
        pointer: &[u8],
        on: Option<i64>,
    ) -> Option<i64> {
        let kept = self.pointers.rows.get(name).map(|row| row.version);
        if kept != on {
            return None;
        }
        let version = self.pointers.next();
        self.pointers.rows.insert(
            name.to_owned(),
            PointerRow {
                owner,
                pointer: pointer.to_vec(),
                version,
            },
        );
        Some(version)
    }

    pub(super) fn pointer_names(&self) -> Vec<String> {
        self.pointers.rows.keys().cloned().collect()
    }

    pub(super) fn pointers_imported(&self) -> Option<Imported> {
        self.pointers.imported.clone()
    }

    pub(super) fn adopt_pointers(&mut self, found: &[Found]) -> usize {
        let mut kept = 0;
        for found in found {
            if self.pointers.rows.contains_key(&found.name) {
                continue;
            }
            let version = self.pointers.next();
            self.pointers.rows.insert(
                found.name.clone(),
                PointerRow {
                    owner: found.owner,
                    pointer: found.pointer.clone(),
                    version,
                },
            );
            kept += 1;
        }
        kept
    }

    pub(super) fn import_pointers(
        &mut self,
        found: &[Found],
        from: &str,
        at_ms: u64,
        seen: u64,
    ) -> Import {
        if let Some(imported) = &self.pointers.imported {
            return Import::Done(imported.clone());
        }
        let waiting: Vec<String> = self
            .hosts
            .values()
            .filter(|host| {
                !host.row.capacity.pointers_in_service
                    && (host.row.state != HostState::Lost || host.row.changed > seen)
            })
            .map(|host| host.row.info.name.clone())
            .collect();
        if !waiting.is_empty() {
            return Import::Waiting(waiting);
        }
        self.adopt_pointers(found);
        let imported = Imported {
            at_ms,
            from: from.to_owned(),
        };
        self.pointers.imported = Some(imported.clone());
        Import::Done(imported)
    }
}
