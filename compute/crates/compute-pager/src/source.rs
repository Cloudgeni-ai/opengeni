//! Where page contents come from.
//!
//! A [`Source`] hands the pager the bytes of a memory image. A local file is
//! always ready. A remote image is not: the source starts fetching what was
//! asked for and answers "not yet", the pager parks the fault, and the source
//! signals its readiness descriptor when more bytes have arrived. The pager
//! never blocks on a source, so one slow fetch never delays a page that is
//! already available.

use std::fs::File;
use std::io;
use std::os::fd::BorrowedFd;

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
