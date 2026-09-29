//! Descriptor-based ACL inspection. Apple ACL storage is opaque; compare its
//! external representation with a freshly allocated empty ACL rather than
//! assuming that extended attributes enumerate ACLs or parsing private layouts.

use std::ffi::{c_int, c_void};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

extern "C" {
    fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
    fn acl_init(count: c_int) -> *mut c_void;
    fn acl_free(object: *mut c_void) -> c_int;
    fn acl_size(acl: *mut c_void) -> isize;
    fn acl_copy_ext(buffer: *mut c_void, acl: *mut c_void, size: isize) -> isize;
}

struct Acl(*mut c_void);

impl Acl {
    fn checked(pointer: *mut c_void) -> io::Result<Self> {
        if pointer.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(pointer))
        }
    }

    fn bytes(&self) -> io::Result<Vec<u8>> {
        // SAFETY: self owns a live ACL from acl_init/acl_get_fd_np until Drop.
        let size = unsafe { acl_size(self.0) };
        if size < 0 {
            return Err(io::Error::last_os_error());
        }
        let length = usize::try_from(size)
            .ok()
            .filter(|length| (1..=64 * 1024).contains(length))
            .ok_or_else(|| io::Error::other("ACL representation exceeds inspection bounds"))?;
        // The C serializer may access native integer fields. Keep its backing
        // storage aligned for u64 as well as large enough for the reported size.
        let mut words = vec![0_u64; length.div_ceil(8)];
        // SAFETY: the mutable buffer has at least the size reported by acl_size;
        // this synchronous call borrows the live ACL and buffer only here.
        let copied = unsafe { acl_copy_ext(words.as_mut_ptr().cast(), self.0, size) };
        if copied < 0 {
            return Err(io::Error::last_os_error());
        }
        if copied != size {
            return Err(io::Error::other("ACL representation size changed"));
        }
        Ok(words
            .into_iter()
            .flat_map(u64::to_ne_bytes)
            .take(length)
            .collect())
    }
}

impl Drop for Acl {
    fn drop(&mut self) {
        // SAFETY: this non-cloneable owner frees the successful ACL allocation
        // exactly once. No borrowed entry/flag pointers escape this module.
        unsafe { acl_free(self.0) };
    }
}

/// Detect extended ACL entries or flags using an already opened descriptor.
///
/// # Errors
/// Returns an error if ACL retrieval or bounded serialization fails.
pub fn has_extended_acl(file: &File) -> io::Result<bool> {
    // ACL_TYPE_EXTENDED is 0x100 in Apple's public sys/acl.h. The File borrow
    // keeps the descriptor alive throughout the synchronous inspection.
    let actual = match Acl::checked(unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) }) {
        Ok(acl) => acl,
        // Apple's acl_get_fd_np uses filesec_get_property(FILESEC_ACL), which
        // returns ENOENT when that descriptor has no ACL property. Confirm the
        // borrowed descriptor remains valid; all other retrieval errors fail.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            file.metadata()?;
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    // SAFETY: zero creates a valid empty ACL; ownership goes directly to Acl.
    let empty = Acl::checked(unsafe { acl_init(0) })?;
    Ok(actual.bytes()? != empty.bytes()?)
}
