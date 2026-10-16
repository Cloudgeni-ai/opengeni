//! Named holds outlast the agent. Each sandbox's are kept in a small file
//! beside its record, written before a hold or release is acknowledged, so
//! a restart neither drops a hold a caller still counts on nor revives one
//! that lapsed meanwhile. The holds a connection takes end with the
//! connection, which a restart ends too, so only named holds are kept.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use compute_core::HoldId;

use crate::layout::write_atomic;

/// A pending write of a sandbox's holds; the change is durable once it
/// resolves.
pub(super) type Write = Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;

/// The hold id for a hold named through the API. Leases count up from one,
/// so named holds take the upper half of the id space.
pub(super) fn hold_id(name: &str) -> HoldId {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    HoldId(hasher.finish() | 1 << 63)
}

/// A sandbox's named holds and the file that keeps them.
#[derive(Debug)]
pub(super) struct Holds {
    path: PathBuf,
    /// When each lapses, in milliseconds since the Unix epoch; `None` lasts
    /// until released.
    named: BTreeMap<String, Option<u64>>,
    /// Changes made so far; each write carries the count it saw.
    changes: u64,
    /// The latest change written. Held while writing, so writes happen one
    /// at a time and an older list never replaces a newer one.
    written: Arc<tokio::sync::Mutex<u64>>,
}

impl Holds {
    /// No holds, kept at `path`.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            named: BTreeMap::new(),
            changes: 0,
            written: Arc::default(),
        }
    }

    /// The holds kept at `path` that have not lapsed by `now_ms`. A missing
    /// file holds none.
    pub fn load(path: PathBuf, now_ms: u64) -> io::Result<Self> {
        let mut holds = Self::new(path);
        match std::fs::read(&holds.path) {
            Ok(bytes) => {
                holds.named = serde_json::from_slice(&bytes)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                holds.drop_lapsed(now_ms);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(holds)
    }

    /// Each hold's name and when it lapses.
    pub fn named(&self) -> impl Iterator<Item = (&str, Option<u64>)> {
        self.named
            .iter()
            .map(|(name, lapses)| (name.as_str(), *lapses))
    }

    /// Holds `name` until `lapses_ms`, or until released.
    pub fn set(&mut self, name: String, lapses_ms: Option<u64>) {
        self.named.insert(name, lapses_ms);
    }

    /// Forgets hold `name`. Returns whether it was held.
    pub fn remove(&mut self, name: &str) -> bool {
        self.named.remove(name).is_some()
    }

    /// A write of the holds as they are now, less those lapsed by `now_ms`.
    /// The change is durable once it resolves.
    pub fn write(&mut self, now_ms: u64) -> Write {
        self.drop_lapsed(now_ms);
        self.changes += 1;
        let change = self.changes;
        let bytes = serde_json::to_vec(&self.named);
        let path = self.path.clone();
        let written = Arc::clone(&self.written);
        Box::pin(async move {
            let bytes = bytes.map_err(io::Error::other)?;
            let mut latest = written.lock().await;
            if *latest >= change {
                return Ok(());
            }
            tokio::task::spawn_blocking(move || write_atomic(&path, &bytes))
                .await
                .map_err(io::Error::other)??;
            *latest = change;
            Ok(())
        })
    }

    fn drop_lapsed(&mut self, now_ms: u64) {
        self.named
            .retain(|_, lapses| lapses.is_none_or(|lapses| lapses > now_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "holds-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("holds.json")
    }

    #[tokio::test]
    async fn holds_written_come_back_without_the_lapsed_ones() {
        let path = file();
        let mut holds = Holds::new(path.clone());
        holds.set("turn".into(), None);
        holds.set("timeout".into(), Some(2_000));
        holds.set("brief".into(), Some(1_500));
        holds.write(1_000).await.unwrap();
        let loaded = Holds::load(path.clone(), 1_600).unwrap();
        let named: Vec<_> = loaded.named().collect();
        assert_eq!(named, [("timeout", Some(2_000)), ("turn", None)]);

        holds.remove("turn");
        holds.write(1_000).await.unwrap();
        let loaded = Holds::load(path.clone(), 2_000).unwrap();
        assert_eq!(loaded.named().count(), 0, "lapsed at 2000");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn an_older_list_never_replaces_a_newer_one() {
        let path = file();
        let mut holds = Holds::new(path.clone());
        holds.set("first".into(), None);
        let older = holds.write(0);
        holds.set("second".into(), None);
        let newer = holds.write(0);
        // The newer write lands first; the older one then finds it
        // superseded and leaves the file alone.
        newer.await.unwrap();
        older.await.unwrap();
        let loaded = Holds::load(path.clone(), 0).unwrap();
        assert_eq!(loaded.named().count(), 2);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_file_holds_nothing_and_a_damaged_one_is_an_error() {
        let path = file();
        assert_eq!(Holds::load(path.clone(), 0).unwrap().named().count(), 0);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(
            Holds::load(path.clone(), 0).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
