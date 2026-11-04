//! What a sweep keeps: every pointer, fenced, and a fingerprint of every
//! key the pointers name, reading what an object naming more names from
//! the record an earlier sweep kept of it when there is one.

use std::collections::{BTreeMap, HashMap, HashSet};

use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _, stream};

use super::{Names, READS, tried};
use crate::store::{ChunkStore, Stock as Held};
use crate::{Error, Result};

/// A key's fingerprint: the first eight bytes of its BLAKE3 hash. Two keys
/// that share one only keep garbage a little longer.
pub(super) type Print = u64;

pub(super) fn print(key: &str) -> Print {
    let hash = blake3::hash(key.as_bytes());
    let mut first = [0; 8];
    first.copy_from_slice(&hash.as_bytes()[..8]);
    Print::from_le_bytes(first)
}

/// Where, below the sweep's records, what an object names is kept: under
/// the object's own key.
pub(super) const WITHIN: &str = "v1/within";

/// What starts a record of what an object names.
const MAGIC: &[u8; 8] = b"ogsweep1";

/// What a sweep found the pointers name.
#[derive(Debug, Default)]
pub(super) struct Stock {
    /// Pointers kept, tombstones among them.
    pub pointers: usize,
    pub tombstones: usize,
    /// What each pointer that names something holds, by its name.
    pub held: BTreeMap<String, Vec<u8>>,
    /// Every key named.
    pub prints: HashSet<Print>,
    /// The keys of the objects named that name more.
    pub within: HashSet<String>,
    /// Such objects read, and those a record answered for.
    pub read: usize,
    pub remembered: usize,
}

/// Keeps every pointer `store` holds again (or only reads it, unless
/// `delete`), and finds what they name.
pub(super) async fn take<N: Names>(store: &ChunkStore, names: &N, delete: bool) -> Result<Stock> {
    // Listed after the sweep began: a pointer missing from the list was
    // first kept by an archive that began after it.
    let listed = tried("listing the pointers", || store.pointer_names()).await?;
    let taken: Vec<(String, Held)> = stream::iter(listed)
        .map(|name| async move {
            // Only a sweep that deletes fences: a look stops no archive.
            let held = tried("keeping a pointer", || async {
                if delete {
                    store.fence(&name).await
                } else {
                    store.look(&name).await
                }
            })
            .await?;
            Ok::<_, Error>((name, held))
        })
        .buffer_unordered(READS)
        .try_collect()
        .await?;
    let mut stock = Stock {
        pointers: taken.len(),
        ..Stock::default()
    };
    let mut within = HashMap::new();
    for (name, held) in taken {
        match held {
            Held::Holds(bytes) if !bytes.is_empty() => {
                let said = names.named(&bytes)?;
                stock.prints.extend(said.keys.iter().map(|key| print(key)));
                for (key, object) in said.within {
                    stock.prints.insert(print(&key));
                    within.entry(key).or_insert(object);
                }
                stock.held.insert(name, bytes);
            }
            Held::Tombstone => stock.tombstones += 1,
            // Deleted since the listing, so what it named may go, or the
            // empty pointer of an archive that has not published.
            Held::Holds(_) | Held::Gone => {}
        }
    }
    stock.within = within.keys().cloned().collect();
    let found: Vec<(Vec<Print>, bool)> = stream::iter(within)
        .map(|(key, object)| named_within(store, names, key, object, delete))
        .buffer_unordered(READS)
        .try_collect()
        .await?;
    for (prints, remembered) in found {
        stock.prints.extend(prints);
        if remembered {
            stock.remembered += 1;
        } else {
            stock.read += 1;
        }
    }
    Ok(stock)
}

/// What the object under `key` names: from its record, or read, keeping a
/// record of it unless only looking. Whether a record answered.
async fn named_within<N: Names>(
    store: &ChunkStore,
    names: &N,
    key: String,
    object: N::Within,
    delete: bool,
) -> Result<(Vec<Print>, bool)> {
    let record = format!("{WITHIN}/{key}");
    match store.get_record(&record).await {
        Ok(Some(bytes)) => {
            if let Some(prints) = decode(&key, &bytes) {
                return Ok((prints, true));
            }
            tracing::warn!(key, "sweep: a damaged record; reading the object again");
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(%error, key, "sweep: could not read a record; reading the object");
        }
    }
    let read = tried("reading what a stored object names", || {
        names.within(&object)
    })
    .await?;
    let Some(keys) = read else {
        return Ok((Vec::new(), false));
    };
    let prints: Vec<Print> = keys.iter().map(|key| print(key)).collect();
    if delete && let Err(error) = store.put_record(&record, encode(&key, &prints)).await {
        tracing::warn!(%error, key, "sweep: could not keep a record; the next sweep reads it again");
    }
    Ok((prints, false))
}

/// A record of `prints`, what the object under `key` names: [`MAGIC`],
/// their count, each in little-endian order, and the BLAKE3 hash of the
/// key and all before it, so a record damaged or kept under another key
/// is not believed.
pub(super) fn encode(key: &str, prints: &[Print]) -> Bytes {
    let mut bytes = Vec::with_capacity(MAGIC.len() + 4 + prints.len() * 8 + 32);
    bytes.extend_from_slice(MAGIC);
    let count = u32::try_from(prints.len()).unwrap_or(u32::MAX);
    bytes.extend_from_slice(&count.to_le_bytes());
    for print in prints.iter().take(count as usize) {
        bytes.extend_from_slice(&print.to_le_bytes());
    }
    let check = checked(key, &bytes);
    bytes.extend_from_slice(check.as_bytes());
    Bytes::from(bytes)
}

/// What the record `bytes` of the object under `key` holds, if it is
/// whole.
pub(super) fn decode(key: &str, bytes: &[u8]) -> Option<Vec<Print>> {
    let (body, check) = bytes.split_at_checked(bytes.len().checked_sub(32)?)?;
    if checked(key, body).as_bytes() != check {
        return None;
    }
    let rest = body.strip_prefix(MAGIC)?;
    let (count, rest) = rest.split_at_checked(4)?;
    let count = u32::from_le_bytes(count.try_into().ok()?) as usize;
    if rest.len() != count.checked_mul(8)? {
        return None;
    }
    let (prints, _) = rest.as_chunks::<8>();
    Some(
        prints
            .iter()
            .map(|print| Print::from_le_bytes(*print))
            .collect(),
    )
}

fn checked(key: &str, body: &[u8]) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new();
    hasher.update(key.as_bytes());
    hasher.update(&[0]);
    hasher.update(body);
    hasher.finalize()
}
