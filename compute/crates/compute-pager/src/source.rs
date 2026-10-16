//! Where page contents come from.
//!
//! A [`Source`] hands the pager the bytes of a memory image. A local file is
//! always ready. A remote image is not: the source starts fetching what was
//! asked for and answers "not yet", the pager parks the fault, and the source
//! signals its readiness descriptor when more bytes have arrived. The pager
//! never blocks on a source, so one slow fetch never delays a page that is
//! already available.

use std::fs::File;
use std::io::{self, Read, Write};
use std::ops::Range;
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use memmap2::{Mmap, MmapOptions};

/// The bytes of one immutable memory image.
pub trait Source {
    /// The image's length in bytes.
    fn len(&self) -> u64;

    /// Whether the image is empty.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The `len` bytes at `offset`, or `None` when they are not available
    /// yet. Asking starts fetching them; `urgent` means a guest processor
    /// is stalled on them, so they jump the queue. The pager only asks for
    /// ranges inside the image and at most 2 MiB long.
    ///
    /// A returned slice stays valid and unchanged until the next call on
    /// this source.
    fn get(&mut self, offset: u64, len: u64, urgent: bool) -> io::Result<Option<&[u8]>>;

    /// A descriptor that becomes readable when bytes that were not
    /// available have arrived, or `None` if [`Source::get`] never returns
    /// `None`.
    fn ready_fd(&self) -> Option<BorrowedFd<'_>> {
        None
    }

    /// Clears the readiness signalled on [`Source::ready_fd`]. Called before
    /// the pager retries everything it parked.
    fn acknowledge(&mut self) -> io::Result<()> {
        Ok(())
    }

    /// Whether every byte of the image is available, so that nothing it
    /// serves will ever wait again.
    fn complete(&self) -> bool {
        false
    }
}

/// A memory image in a local file, mapped read-only.
#[derive(Debug)]
pub struct MappedFile {
    map: Mmap,
}

impl MappedFile {
    /// Maps `file`.
    ///
    /// # Safety
    ///
    /// Nothing may modify or truncate the file while the mapping lives:
    /// either is undefined behaviour for the mapping and would hand the guest
    /// memory that never existed.
    pub unsafe fn new(file: &File) -> io::Result<Self> {
        // SAFETY: the caller guarantees the file is immutable while mapped.
        let map = unsafe { MmapOptions::new().map(file)? };
        Ok(Self { map })
    }
}

impl Source for MappedFile {
    fn len(&self) -> u64 {
        self.map.len() as u64
    }

    fn get(&mut self, offset: u64, len: u64, _: bool) -> io::Result<Option<&[u8]>> {
        let range = usize::try_from(offset)
            .ok()
            .zip(usize::try_from(len).ok())
            .and_then(|(start, len)| Some(start..start.checked_add(len)?))
            .and_then(|range| self.map.get(range))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "read past the image"))?;
        Ok(Some(range))
    }

    fn complete(&self) -> bool {
        true
    }
}

/// Which 4 KiB units of an image may be read, as another thread fills the
/// image in. A unit only ever turns readable.
#[derive(Debug)]
pub struct Readable {
    words: Vec<AtomicU64>,
    len: u64,
    missing: AtomicU64,
}

impl Readable {
    /// Bytes per unit.
    pub const UNIT: u64 = 4096;

    /// An image of `len` bytes, all readable or none.
    #[must_use]
    pub fn new(len: u64, all: bool) -> Self {
        let units = len.div_ceil(Self::UNIT);
        let words = (0..units.div_ceil(64))
            .map(|word| {
                let bits = (units - word * 64).min(64);
                let full = if bits == 64 {
                    u64::MAX
                } else {
                    (1 << bits) - 1
                };
                AtomicU64::new(if all { full } else { 0 })
            })
            .collect();
        Self {
            words,
            len,
            missing: AtomicU64::new(if all { 0 } else { units }),
        }
    }

    /// The image's length.
    #[must_use]
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Whether the image is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn units(range: &Range<u64>) -> Range<u64> {
        range.start / Self::UNIT..range.end.div_ceil(Self::UNIT)
    }

    /// Marks `range` readable. It must cover whole units (the last may end
    /// at the image's end), so no unit is marked of which a part is not.
    ///
    /// # Errors
    ///
    /// The range is empty, unaligned or outside the image.
    pub fn mark(&self, range: Range<u64>) -> io::Result<()> {
        if range.start >= range.end
            || range.end > self.len
            || !range.start.is_multiple_of(Self::UNIT)
            || !(range.end.is_multiple_of(Self::UNIT) || range.end == self.len)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "filled range not whole pages of the image",
            ));
        }
        for unit in Self::units(&range) {
            let bit = 1 << (unit % 64);
            let index = usize::try_from(unit / 64).unwrap_or(usize::MAX);
            if self.words[index].fetch_or(bit, Ordering::AcqRel) & bit == 0 {
                self.missing.fetch_sub(1, Ordering::AcqRel);
            }
        }
        Ok(())
    }

    /// Whether every byte of `range` may be read.
    #[must_use]
    pub fn covers(&self, range: Range<u64>) -> bool {
        if self.complete() {
            return true;
        }
        Self::units(&range).all(|unit| {
            let index = usize::try_from(unit / 64).unwrap_or(usize::MAX);
            self.words
                .get(index)
                .is_some_and(|word| word.load(Ordering::Acquire) & (1 << (unit % 64)) != 0)
        })
    }

    /// Whether the whole image may be read.
    #[must_use]
    pub fn complete(&self) -> bool {
        self.missing.load(Ordering::Acquire) == 0
    }

    /// The byte ranges not yet readable, merged.
    #[must_use]
    pub fn missing(&self) -> Vec<(u64, u64)> {
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for unit in 0..self.len.div_ceil(Self::UNIT) {
            let start = unit * Self::UNIT;
            if self.covers(start..start + 1) {
                continue;
            }
            let end = (start + Self::UNIT).min(self.len);
            match ranges.last_mut() {
                Some(last) if last.1 == start => last.1 = end,
                _ => ranges.push((start, end)),
            }
        }
        ranges
    }
}

/// What a pager asks to have filled in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Want {
    pub offset: u64,
    pub len: u64,
    pub urgent: bool,
}

/// The state an image being filled in shares between the pager, which
/// reads it, and the thread that talks to whoever fills it.
#[derive(Debug)]
pub struct Fill {
    pub readable: Readable,
    wants: Mutex<Vec<Want>>,
    /// Bumped on each new connection of a filler, which knows nothing of
    /// what an earlier one was asked: everything is asked again.
    epoch: AtomicU64,
    /// Written to when bytes have arrived; the pager polls the other end.
    arrived: (UnixStream, UnixStream),
    /// Written to when there is something to tell the filler.
    tell: (UnixStream, UnixStream),
}

impl Fill {
    /// An image of `len` bytes, all readable already or none yet.
    ///
    /// # Errors
    ///
    /// The signalling sockets cannot be made.
    pub fn new(len: u64, complete: bool) -> io::Result<Self> {
        let pair = || -> io::Result<(UnixStream, UnixStream)> {
            let (a, b) = UnixStream::pair()?;
            a.set_nonblocking(true)?;
            b.set_nonblocking(true)?;
            Ok((a, b))
        };
        Ok(Self {
            readable: Readable::new(len, complete),
            wants: Mutex::new(Vec::new()),
            epoch: AtomicU64::new(0),
            arrived: pair()?,
            tell: pair()?,
        })
    }

    /// Wakes the pager: bytes have arrived, or everything must be asked
    /// for again.
    pub fn signal_arrived(&self) {
        // A full buffer already holds a wake-up.
        let _ = (&self.arrived.0).write(&[1]);
    }

    /// Wakes the thread talking to the filler.
    pub fn signal_tell(&self) {
        let _ = (&self.tell.0).write(&[1]);
    }

    /// The descriptor that turns readable on [`Self::signal_tell`].
    #[must_use]
    pub fn tell_fd(&self) -> BorrowedFd<'_> {
        self.tell.1.as_fd()
    }

    /// Clears the wake-ups sent with [`Self::signal_tell`].
    pub fn acknowledge_tell(&self) {
        drain(&self.tell.1);
    }

    /// A new filler connected: what was asked before is asked again.
    pub fn reconnected(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.wants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.signal_arrived();
    }

    /// The requests not yet passed on.
    pub fn take_wants(&self) -> Vec<Want> {
        std::mem::take(
            &mut *self
                .wants
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn want(&self, want: Want) {
        self.wants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(want);
        self.signal_tell();
    }
}

fn drain(mut socket: &UnixStream) {
    let mut buffer = [0_u8; 64];
    while matches!(socket.read(&mut buffer), Ok(count) if count > 0) {}
}

/// A memory image filled in by someone else while the pager serves it: the
/// bytes [`Fill::readable`] covers are read from the mapped file, and the
/// rest is asked for once, through [`Fill`], and waited for.
#[derive(Debug)]
pub struct FilledFile {
    map: Mmap,
    fill: std::sync::Arc<Fill>,
    /// Per unit: 0 not asked, 1 asked, 2 asked as urgent, in `epoch`.
    asked: Vec<u8>,
    epoch: u64,
}

impl FilledFile {
    /// Maps `file`, whose length `fill` describes.
    ///
    /// # Errors
    ///
    /// The file cannot be mapped or its length differs.
    ///
    /// # Safety
    ///
    /// A byte of the file may change only before `fill` marks it readable,
    /// and the file's length never changes while the mapping lives.
    pub unsafe fn new(file: &File, filling: std::sync::Arc<Fill>) -> io::Result<Self> {
        // SAFETY: the caller guarantees bytes are read only once they no
        // longer change, and that the length is fixed.
        let map = unsafe { MmapOptions::new().map(file)? };
        if map.len() as u64 != filling.readable.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the memory file's length changed",
            ));
        }
        let units = usize::try_from(filling.readable.len().div_ceil(Readable::UNIT))
            .map_err(io::Error::other)?;
        Ok(Self {
            map,
            fill: filling,
            asked: vec![0; units],
            epoch: 0,
        })
    }
}

/// Maps the memory file a pager process serves while its host agent fills
/// it in.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn filled(file: &File, filling: std::sync::Arc<Fill>) -> io::Result<FilledFile> {
    // SAFETY: the host agent writes a range of the file only before it
    // reports the range filled, never afterwards, and never changes the
    // file's length (see `crate::control`); a local image is never written.
    unsafe { FilledFile::new(file, filling) }
}

impl Source for FilledFile {
    fn len(&self) -> u64 {
        self.map.len() as u64
    }

    fn get(&mut self, offset: u64, len: u64, urgent: bool) -> io::Result<Option<&[u8]>> {
        let end = offset
            .checked_add(len)
            .filter(|end| *end <= self.len() && len > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "read past the image"))?;
        if !self.fill.readable.covers(offset..end) {
            let epoch = self.fill.epoch.load(Ordering::Acquire);
            if epoch != self.epoch {
                self.epoch = epoch;
                self.asked.fill(0);
            }
            let level = if urgent { 2 } else { 1 };
            let units = usize::try_from(offset / Readable::UNIT).unwrap_or(usize::MAX)
                ..usize::try_from(end.div_ceil(Readable::UNIT)).unwrap_or(usize::MAX);
            let mut new = false;
            for asked in &mut self.asked[units] {
                if *asked < level {
                    *asked = level;
                    new = true;
                }
            }
            if new {
                self.fill.want(Want {
                    offset,
                    len,
                    urgent,
                });
            }
            return Ok(None);
        }
        let start = usize::try_from(offset).map_err(io::Error::other)?;
        let stop = usize::try_from(end).map_err(io::Error::other)?;
        Ok(self.map.get(start..stop))
    }

    fn ready_fd(&self) -> Option<BorrowedFd<'_>> {
        Some(self.fill.arrived.1.as_fd())
    }

    fn acknowledge(&mut self) -> io::Result<()> {
        drain(&self.fill.arrived.1);
        Ok(())
    }

    fn complete(&self) -> bool {
        self.fill.readable.complete()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn a_mapped_file_is_always_ready_and_bounded() {
        let mut file = tempfile_with(&[1, 2, 3, 4]);
        file.flush().unwrap();
        // SAFETY: the test owns the file and never changes it while mapped.
        let mut source = unsafe { MappedFile::new(&file) }.unwrap();
        assert_eq!(source.len(), 4);
        assert_eq!(source.get(1, 2, false).unwrap(), Some(&[2_u8, 3][..]));
        assert!(source.get(3, 2, true).is_err());
        assert!(source.get(u64::MAX, 2, true).is_err());
        assert!(source.ready_fd().is_none());
    }

    fn tempfile_with(bytes: &[u8]) -> File {
        let path = std::env::temp_dir().join(format!(
            "pager-source-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.write_all(bytes).unwrap();
        std::fs::remove_file(&path).unwrap();
        file
    }
}
