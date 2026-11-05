//! Storing a file's chunks in packs (ADR 31): the chunks an archive stores
//! for a file go end to end, in file order, into objects of about
//! [`PACK_BYTES`](compute_storage::pack::PACK_BYTES), so the store keeps a
//! few large objects per archive rather than one per chunk.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::sync::Arc;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::pack::Packer;
use compute_storage::store::PutPack;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use futures::{FutureExt as _, Stream, StreamExt as _, stream};

use super::files::{Checks, Earlier, Prepared, Reusable};
use super::{Chunked, Piece, UPLOADS_PER_FILE, ZSTD_LEVEL, storage_error};
use crate::image::{Hash, chunk_range};

/// Packs of one file uploading at once: each holds its bytes in memory.
const PACKS_IN_FLIGHT: usize = 2;

/// What one chunk-sized piece of a file is stored as.
#[derive(Clone, Debug)]
enum Slot {
    Zero,
    /// A chunk stored before, and whether the image names it.
    Named(ChunkRef, bool),
    /// The chunk at a place in one of this file's packs, by number.
    Packed(usize, usize),
    /// The same bytes as an earlier piece, by index, which is packed.
    Same(usize),
}

impl Chunked {
    /// Stores the `wanted` chunk-sized pieces of `file`, `length` bytes
    /// long, as [`Self::put_file`] does each, with every new chunk in this
    /// file's packs, and returns the pieces; `None` once `stop` fired.
    ///
    /// A chunk an `earlier` copy stored is reused, as it is without packs,
    /// unless reusing it would keep alive an object mostly of chunks no
    /// copy names: a chunk stored on its own, or in a pack this file names
    /// less than half of, is stored again in this file's packs from the
    /// local bytes, when they are still the same. A chunk the image names
    /// is always reused, since the image keeps it anyway.
    pub(super) async fn put_packed(
        &self,
        file: &Arc<File>,
        length: u64,
        wanted: Vec<usize>,
        earlier: Arc<Earlier>,
        known: Option<Arc<Vec<Hash>>>,
        stop: &CancellationToken,
    ) -> Result<Option<Vec<Piece>>, EngineError> {
        let checks = &Checks::default();
        let mut packing = Packing::new(self, stop.clone());
        let prepared = stream::iter(wanted)
            .map(|index| {
                let file = Arc::clone(file);
                let earlier = Arc::clone(&earlier);
                let expected = known.as_ref().map(|known| known[index]);
                async move {
                    if stop.is_cancelled() {
                        return Ok(None);
                    }
                    let range = chunk_range(index, length);
                    let earlier = earlier.get(&range.start).cloned().unwrap_or_default();
                    self.resolve_chunk(&file, range, earlier, expected, checks)
                        .await
                        .map(|prepared| Some((index, prepared)))
                }
            })
            .buffered(UPLOADS_PER_FILE);
        packing.run(prepared).await?;
        // Stored again from the local bytes, after the new chunks: which
        // are is known only once every piece is.
        let again = packing.sparse();
        let restored = stream::iter(again)
            .map(|(index, reference)| {
                let file = Arc::clone(file);
                async move {
                    if stop.is_cancelled() {
                        return Ok(None);
                    }
                    let range = chunk_range(index, length);
                    let prepared = match self.reencode(&file, range, &reference).await? {
                        Some(chunk) => Prepared::New(chunk),
                        // Not local, or changed: the earlier chunk still
                        // holds these bytes.
                        None => Prepared::Known(Reusable {
                            reference,
                            confirmed: true,
                            image: false,
                        }),
                    };
                    Ok(Some((index, prepared)))
                }
            })
            .buffered(UPLOADS_PER_FILE);
        packing.run(restored).await?;
        let pieces = packing.finish(length).await?;
        Ok(pieces.filter(|_| !stop.is_cancelled()))
    }

    /// The chunk-sized `range` of `file` encoded anew, if it still holds
    /// the bytes `reference` names.
    async fn reencode(
        &self,
        file: &Arc<File>,
        range: Range<u64>,
        reference: &ChunkRef,
    ) -> Result<Option<EncodedChunk>, EngineError> {
        const OP: &str = "archive";
        let file = Arc::clone(file);
        let hash = reference.hash.clone();
        let _permit = self
            .compress
            .acquire()
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
        tokio::task::spawn_blocking(move || {
            let length = usize::try_from(range.end - range.start)
                .map_err(|_| StorageError::Invalid("chunk length"))?;
            let mut plain = vec![0_u8; length];
            match file.read_exact_at(&mut plain, range.start) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(error) => return Err(StorageError::from(error)),
            }
            if blake3::hash(&plain).to_hex().as_str() != hash {
                return Ok(None);
            }
            EncodedChunk::encode(&plain, ZSTD_LEVEL).map(Some)
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| storage_error(OP, error))
    }
}

/// A file's pieces as they are packed and stored.
struct Packing<'a> {
    chunked: &'a Chunked,
    stop: CancellationToken,
    slots: BTreeMap<usize, Slot>,
    /// The first piece of each new chunk's bytes, by stored hash.
    first: HashMap<String, usize>,
    packer: Packer,
    /// The chunks of each pack once stored, by number.
    packs: Vec<Option<Vec<ChunkRef>>>,
    uploads: FuturesUnordered<BoxFuture<'a, Result<(usize, PutPack), EngineError>>>,
    /// Whether a piece was skipped once `stop` fired.
    skipped: bool,
}

impl<'a> Packing<'a> {
    fn new(chunked: &'a Chunked, stop: CancellationToken) -> Self {
        Self {
            chunked,
            stop,
            slots: BTreeMap::new(),
            first: HashMap::new(),
            packer: Packer::new(),
            packs: Vec::new(),
            uploads: FuturesUnordered::new(),
            skipped: false,
        }
    }

    /// Takes in every piece `pieces` gives, packing new chunks and storing
    /// each pack as it fills, with at most [`PACKS_IN_FLIGHT`] uploading.
    /// After a failure no further piece is taken, and it returns once the
    /// uploads under way have ended.
    async fn run(
        &mut self,
        pieces: impl Stream<Item = Result<Option<(usize, Prepared)>, EngineError>>,
    ) -> Result<(), EngineError> {
        let mut pieces = std::pin::pin!(pieces);
        let mut open = true;
        loop {
            if !open && self.uploads.is_empty() {
                return Ok(());
            }
            let taking = open && self.uploads.len() < PACKS_IN_FLIGHT;
            tokio::select! {
                Some(stored) = self.uploads.next(), if !self.uploads.is_empty() => {
                    if let Err(error) = self.stored(stored) {
                        return self.failed(error).await;
                    }
                }
                piece = pieces.next(), if taking => match piece {
                    None => open = false,
                    Some(Err(error)) => return self.failed(error).await,
                    Some(Ok(None)) => self.skipped = true,
                    Some(Ok(Some((index, prepared)))) => self.add(index, prepared),
                },
            }
        }
    }

    fn add(&mut self, index: usize, prepared: Prepared) {
        let slot = match prepared {
            Prepared::Zero => Slot::Zero,
            Prepared::Known(reusable) => Slot::Named(reusable.reference, reusable.image),
            Prepared::New(chunk) => {
                let stored = chunk.reference.stored_hash.clone();
                if let Some(&first) = self.first.get(&stored) {
                    Slot::Same(first)
                } else {
                    self.first.insert(stored, index);
                    let place = self.packer.push(&chunk);
                    let slot = Slot::Packed(self.packs.len(), place);
                    if self.packer.is_full() {
                        self.launch();
                    }
                    slot
                }
            }
        };
        self.slots.insert(index, slot);
    }

    /// Starts storing the pack being filled.
    fn launch(&mut self) {
        let packer = std::mem::take(&mut self.packer);
        let number = self.packs.len();
        self.packs.push(None);
        let chunked = self.chunked;
        self.uploads.push(
            async move {
                const OP: &str = "archive";
                let _permit = chunked
                    .transfers
                    .acquire()
                    .await
                    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
                let put = chunked
                    .chunks
                    .put_pack(packer)
                    .await
                    .map_err(|error| storage_error(OP, error))?;
                Ok((number, put))
            }
            .boxed(),
        );
    }

    fn stored(&mut self, stored: Result<(usize, PutPack), EngineError>) -> Result<(), EngineError> {
        let (number, put) = stored?;
        if put.new {
            // A copy within the store, of what an archive a sweep stopped
            // stored an hour before, moves nothing over the network.
            let how = if put.copied { "copied" } else { "uploaded" };
            crate::observe::notes::bytes(how, put.len);
        }
        self.packs[number] = Some(put.references);
        Ok(())
    }

    /// Stops taking pieces, waits for the uploads under way, and fails.
    async fn failed(&mut self, error: EngineError) -> Result<(), EngineError> {
        self.stop.cancel();
        while self.uploads.next().await.is_some() {}
        Err(error)
    }

    /// The pieces named by a chunk stored before that is better stored
    /// again ([`Chunked::put_packed`]), in file order, with that chunk.
    fn sparse(&self) -> Vec<(usize, ChunkRef)> {
        // Of each pack, the places this file names.
        let mut named: HashMap<String, HashSet<u64>> = HashMap::new();
        let mut covered: HashMap<String, u64> = HashMap::new();
        for slot in self.slots.values() {
            if let Slot::Named(reference, false) = slot
                && let Some(pack) = &reference.pack
                && named
                    .entry(reference.key())
                    .or_default()
                    .insert(pack.offset)
            {
                *covered.entry(reference.key()).or_default() += u64::from(reference.stored_len);
            }
        }
        self.slots
            .iter()
            .filter_map(|(&index, slot)| match slot {
                Slot::Named(reference, false) => {
                    let sparse = reference.pack.as_ref().is_none_or(|pack| {
                        covered.get(&reference.key()).copied().unwrap_or(0) * 2 < pack.len
                    });
                    sparse.then(|| (index, reference.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// Stores the last pack, waits for every upload, and returns the pieces
    /// of a file of `length` bytes; `None` if a piece was skipped.
    async fn finish(mut self, length: u64) -> Result<Option<Vec<Piece>>, EngineError> {
        if !self.packer.is_empty() && !self.stop.is_cancelled() {
            self.launch();
        }
        self.run(stream::empty()).await?;
        if self.skipped || self.stop.is_cancelled() {
            return Ok(None);
        }
        let named = |slot: &Slot| match slot {
            Slot::Packed(number, place) => self.packs[*number]
                .as_ref()
                .and_then(|references| references.get(*place))
                .cloned(),
            _ => None,
        };
        let mut pieces = Vec::with_capacity(self.slots.len());
        for (&index, slot) in &self.slots {
            let reference = match slot {
                Slot::Zero => None,
                Slot::Named(reference, _) => Some(reference.clone()),
                Slot::Packed(..) => named(slot),
                Slot::Same(first) => self.slots.get(first).and_then(named),
            };
            if reference.is_none() && !matches!(slot, Slot::Zero) {
                return Err(EngineError::new(
                    ErrorKind::Fatal,
                    "archive",
                    "a packed chunk has no reference",
                ));
            }
            pieces.push((chunk_range(index, length), reference));
        }
        Ok(Some(pieces))
    }
}
