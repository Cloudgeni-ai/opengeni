//! Privately staged, verified file replacement; no transport or authority inference.

use crate::{PlatformError, PlatformResult};
use opengeni_agent_proto::v1;
use std::path::Path;

/// One privately staged write. The caller serializes chunks and lifecycle actions.
pub trait TransactionalWrite: Send {
    /// Append one already sequence-validated chunk.
    ///
    /// # Errors
    /// Returns a typed failure for I/O, size mismatch, or a terminal transaction.
    fn append(&mut self, bytes: &[u8]) -> PlatformResult<()>;
    /// Verify and publish. `authorized` is checked immediately before publication.
    ///
    /// # Errors
    /// Returns a typed failure for I/O, unsupported metadata, content/base
    /// mismatch, or lost authority. A successful publication is never retried.
    fn commit(&mut self, authorized: &dyn Fn() -> bool) -> PlatformResult<()>;
}

/// Begin a transaction against a resolved absolute native path.
///
/// # Errors
/// Unsupported platforms and filesystem semantics fail closed.
pub fn begin(
    path: &Path,
    request: &v1::FsWriteBegin,
) -> PlatformResult<Box<dyn TransactionalWrite>> {
    #[cfg(target_os = "linux")]
    {
        linux::begin(path, request)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (path, request);
        Err(PlatformError::Unsupported(
            "transactional fs write requires Linux".into(),
        ))
    }
}

/// A stable, non-retryable transaction failure (also retained in terminal status).
#[must_use]
pub fn failure(code: &str, message: &str) -> PlatformError {
    PlatformError::Os {
        message: message.into(),
        detail: [("failure_code".into(), code.into())].into(),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{failure, v1, Path, PlatformError, PlatformResult, TransactionalWrite};
    use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags};
    use std::ffi::OsString;
    use std::fs::{File, Metadata};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;
    use xattr::FileExt as _;

    fn io(error: impl std::fmt::Display) -> PlatformError {
        failure("WRITE_IO", &error.to_string())
    }

    fn unsupported(message: &str) -> PlatformError {
        PlatformError::Unsupported(message.into())
    }

    fn open_dir(parent: &File, name: &std::ffi::OsStr) -> PlatformResult<File> {
        fs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| {
            unsupported("transactional write parent must be an accessible non-symlink directory")
        })
    }

    // Traverse without following any symlink, then retain the directory handle.
    // Parent creation is deliberately unsupported: it has visible side effects
    // that cannot be rolled back safely when other actors also use those paths.
    fn parent(path: &Path) -> PlatformResult<(File, OsString)> {
        if !path.is_absolute() {
            return Err(unsupported("transactional path must be absolute"));
        }
        let spelling = path.as_os_str().as_bytes();
        if spelling.ends_with(b"/") || spelling.ends_with(b"/.") {
            return Err(unsupported(
                "transactional destination must not use directory spelling",
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| unsupported("transactional destination must name a file"))?
            .to_os_string();
        let mut dir = File::open("/").map_err(io)?;
        for component in path
            .parent()
            .ok_or_else(|| unsupported("missing parent"))?
            .components()
        {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => dir = open_dir(&dir, name)?,
                _ => {
                    return Err(unsupported(
                        "transactional paths may not contain parent traversal",
                    ))
                }
            }
        }
        // Linux local filesystems with atomic rename/no-replace semantics. Do
        // not silently assume network/FUSE filesystems provide the same contract.
        let kind = fs::fstatfs(&dir).map_err(io)?.f_type;
        if !matches!(
            kind,
            0xef53 | 0x5846_5342 | 0x9123_683e | 0x0102_1994 | 0x794c_7630
        ) {
            return Err(unsupported("transactional write filesystem is not supported (requires ext4, XFS, Btrfs, tmpfs, or overlayfs)"));
        }
        if dir.metadata().map_err(io)?.mode() & 0o2000 != 0 {
            return Err(unsupported("setgid parent directories are not supported"));
        }
        no_xattrs(&dir)?;
        Ok((dir, name))
    }

    fn no_xattrs(file: &File) -> PlatformResult<()> {
        if file.list_xattr().map_err(io)?.next().is_some() {
            return Err(unsupported(
                "extended attributes/ACLs are not supported by transactional replacement",
            ));
        }
        Ok(())
    }

    fn regular(file: &File) -> PlatformResult<Metadata> {
        let meta = file.metadata().map_err(io)?;
        if !meta.is_file() || meta.nlink() != 1 || meta.mode() & 0o7000 != 0 {
            return Err(unsupported("transactional destination must be a single-link regular file without special mode bits"));
        }
        no_xattrs(file)?;
        match fs::ioctl_getflags(file) {
            // EXTENTS (0x80000) is a storage representation, not user metadata.
            Ok(flags) if flags.bits() & !0x0008_0000 == 0 => {}
            // tmpfs has no inode-flag interface.
            Err(rustix::io::Errno::NOTTY)
                if fs::fstatfs(file).map_err(io)?.f_type == 0x0102_1994 => {}
            _ => {
                return Err(unsupported(
                    "transactional destination has unsupported inode flags",
                ))
            }
        }
        Ok(meta)
    }

    fn same(a: &Metadata, b: &Metadata) -> bool {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mode() == b.mode()
            && a.uid() == b.uid()
            && a.gid() == b.gid()
            && a.nlink() == b.nlink()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }

    fn digest(file: &mut File) -> PlatformResult<(u64, String)> {
        file.seek(SeekFrom::Start(0)).map_err(io)?;
        let mut hash = blake3::Hasher::new();
        let mut bytes = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        loop {
            let count = file.read(&mut buffer).map_err(io)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            bytes = bytes
                .checked_add(count as u64)
                .ok_or_else(|| failure("WRITE_SIZE", "byte count overflow"))?;
        }
        Ok((bytes, hash.finalize().to_hex().to_string()))
    }

    struct Staged {
        path: std::path::PathBuf,
        parent: File,
        name: OsString,
        stage_name: String,
        stage_dir: File,
        content: File,
        base: Option<(File, Metadata)>,
        request: v1::FsWriteBegin,
        bytes: u64,
        published: bool,
    }

    impl Drop for Staged {
        fn drop(&mut self) {
            // Only our exact private names, relative to pinned handles. Never
            // sweep other transactions or interpret an orphan as a resumable op.
            let _ = fs::unlinkat(&self.stage_dir, "content", AtFlags::empty());
            let _ = fs::unlinkat(&self.parent, self.stage_name.as_str(), AtFlags::REMOVEDIR);
        }
    }

    pub(super) fn begin(
        path: &Path,
        request: &v1::FsWriteBegin,
    ) -> PlatformResult<Box<dyn TransactionalWrite>> {
        let valid_digest = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !valid_digest(&request.content_digest)
            || request.content_size.is_none()
            || request.expected_absent != request.expected_base_digest.is_empty()
            || (!request.expected_absent && !valid_digest(&request.expected_base_digest))
        {
            return Err(failure(
                "WRITE_CONTRACT",
                "intended digest/size and exactly one base condition are required",
            ));
        }
        if request.mode & !0o777 != 0 {
            return Err(unsupported("special file modes are not supported"));
        }
        let (parent, name) = parent(path)?;
        let base = match fs::openat(
            &parent,
            &name,
            OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => {
                if request.expected_absent {
                    return Err(failure("WRITE_CONFLICT", "destination exists"));
                }
                let mut file = File::from(fd);
                let meta = regular(&file)?;
                if digest(&mut file)?.1 != request.expected_base_digest
                    || !same(&meta, &regular(&file)?)
                {
                    return Err(failure("WRITE_CONFLICT", "base content changed"));
                }
                Some((file, meta))
            }
            Err(rustix::io::Errno::NOENT) if request.expected_absent => None,
            Err(rustix::io::Errno::NOENT) => {
                return Err(failure("WRITE_CONFLICT", "base file is absent"))
            }
            Err(_) => {
                return Err(unsupported(
                    "destination must be an accessible non-symlink regular file",
                ))
            }
        };
        let stage_name = format!(".opengeni-write-{}", uuid::Uuid::new_v4());
        fs::mkdirat(&parent, stage_name.as_str(), Mode::from_raw_mode(0o700)).map_err(io)?;
        let stage_dir = match open_dir(&parent, std::ffi::OsStr::new(&stage_name)) {
            Ok(dir) => dir,
            Err(error) => {
                let _ = fs::unlinkat(&parent, stage_name.as_str(), AtFlags::REMOVEDIR);
                return Err(error);
            }
        };
        let mode = if request.mode == 0 {
            0o666
        } else {
            request.mode
        };
        let content = match fs::openat(
            &stage_dir,
            "content",
            OFlags::CREATE | OFlags::EXCL | OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(mode),
        ) {
            Ok(fd) => File::from(fd),
            Err(error) => {
                let _ = fs::unlinkat(&parent, stage_name.as_str(), AtFlags::REMOVEDIR);
                return Err(io(error));
            }
        };
        let staged = Staged {
            path: path.to_path_buf(),
            parent,
            name,
            stage_name,
            stage_dir,
            content,
            base,
            request: request.clone(),
            bytes: 0,
            published: false,
        };
        let new_meta = regular(&staged.content)?;
        if let Some((_, meta)) = &staged.base {
            if meta.uid() != new_meta.uid() || meta.gid() != new_meta.gid() {
                return Err(unsupported(
                    "replacement cannot preserve destination ownership",
                ));
            }
            fs::fchmod(&staged.content, Mode::from_raw_mode(meta.mode() & 0o777)).map_err(io)?;
        }
        Ok(Box::new(staged))
    }

    impl TransactionalWrite for Staged {
        fn append(&mut self, bytes: &[u8]) -> PlatformResult<()> {
            if self.published {
                return Err(failure("WRITE_COMPLETE", "write already published"));
            }
            let end = self
                .bytes
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| failure("WRITE_SIZE", "byte count overflow"))?;
            if end > self.request.content_size.unwrap_or(0) {
                return Err(failure("WRITE_SIZE", "chunk exceeds intended size"));
            }
            self.content.write_all(bytes).map_err(io)?;
            self.bytes = end;
            Ok(())
        }

        fn commit(&mut self, authorized: &dyn Fn() -> bool) -> PlatformResult<()> {
            if self.published {
                return Err(failure("WRITE_COMPLETE", "write already published"));
            }
            let (bytes, hash) = digest(&mut self.content)?;
            if Some(bytes) != self.request.content_size || hash != self.request.content_digest {
                return Err(failure(
                    "WRITE_DIGEST",
                    "staged content differs from intended size/digest",
                ));
            }
            regular(&self.content)?;
            self.content.sync_all().map_err(io)?;
            let (current_parent, _) = parent(&self.path)?;
            let initial_parent = self.parent.metadata().map_err(io)?;
            let current_parent = current_parent.metadata().map_err(io)?;
            if initial_parent.dev() != current_parent.dev()
                || initial_parent.ino() != current_parent.ino()
            {
                return Err(failure("WRITE_CONFLICT", "destination parent changed"));
            }
            if let Some((base, initial)) = &mut self.base {
                let current = fs::openat(
                    &self.parent,
                    &self.name,
                    OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map(File::from)
                .map_err(|_| failure("WRITE_CONFLICT", "destination replaced or removed"))?;
                if !same(initial, &regular(&current)?)
                    || !same(initial, &regular(base)?)
                    || digest(base)?.1 != self.request.expected_base_digest
                    || !same(initial, &regular(base)?)
                    || !same(initial, &regular(&current)?)
                {
                    return Err(failure(
                        "WRITE_CONFLICT",
                        "destination inode or content changed",
                    ));
                }
                let named = fs::statat(&self.parent, &self.name, AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(|_| failure("WRITE_CONFLICT", "destination name changed"))?;
                if named.st_ino != initial.ino() || named.st_dev != initial.dev() {
                    return Err(failure("WRITE_CONFLICT", "destination name changed"));
                }
            }
            if !authorized() {
                return Err(failure(
                    "WRITE_FENCED",
                    "write authority changed before commit",
                ));
            }
            let flags = if self.request.expected_absent {
                RenameFlags::NOREPLACE
            } else {
                RenameFlags::empty()
            };
            fs::renameat_with(&self.stage_dir, "content", &self.parent, &self.name, flags)
                .map_err(|error| {
                    if error == rustix::io::Errno::EXIST {
                        failure("WRITE_CONFLICT", "destination appeared before commit")
                    } else {
                        io(error)
                    }
                })?;
            // Rename is the commit point. Do not turn a subsequent cleanup or
            // directory-sync failure into a retryable pre-commit error. This is
            // atomic visibility, not a durable receipt across power/process loss.
            self.published = true;
            Ok(())
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn request(bytes: &[u8], base: Option<&[u8]>) -> v1::FsWriteBegin {
        v1::FsWriteBegin {
            content_digest: blake3::hash(bytes).to_hex().to_string(),
            content_size: Some(bytes.len() as u64),
            expected_base_digest: base
                .map(|b| blake3::hash(b).to_hex().to_string())
                .unwrap_or_default(),
            expected_absent: base.is_none(),
            ..Default::default()
        }
    }

    #[test]
    fn transactional_write_stages_before_verified_atomic_commit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        std::fs::write(&path, b"old").unwrap();
        let mut write = begin(&path, &request(b"new content", Some(b"old"))).unwrap();
        write.append(b"new ").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        write.append(b"content").unwrap();
        write.commit(&|| true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new content");
    }

    #[test]
    fn digest_size_and_authority_failures_leave_target_unchanged() {
        for (body, authority) in [
            (b"bad".as_slice(), true),
            (b"ne".as_slice(), true),
            (b"new".as_slice(), false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("document");
            std::fs::write(&path, b"old").unwrap();
            let mut write = begin(&path, &request(b"new", Some(b"old"))).unwrap();
            write.append(body).unwrap();
            assert!(write.commit(&|| authority).is_err());
            drop(write);
            assert_eq!(std::fs::read(&path).unwrap(), b"old");
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn creation_is_atomic_no_clobber_and_abort_removes_private_stage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        let mut write = begin(&path, &request(b"new", None)).unwrap();
        write.append(b"new").unwrap();
        assert!(!path.exists());
        std::fs::write(&path, b"concurrent").unwrap();
        assert!(write.commit(&|| true).is_err());
        drop(write);
        assert_eq!(std::fs::read(&path).unwrap(), b"concurrent");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn base_content_inode_and_parent_changes_are_conflicts() {
        for mutation in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let parent = dir.path().join("parent");
            std::fs::create_dir(&parent).unwrap();
            let path = parent.join("document");
            std::fs::write(&path, b"old").unwrap();
            let mut write = begin(&path, &request(b"new", Some(b"old"))).unwrap();
            write.append(b"new").unwrap();
            match mutation {
                0 => std::fs::write(&path, b"changed").unwrap(),
                1 => {
                    let replacement = parent.join("replacement");
                    std::fs::write(&replacement, b"old").unwrap();
                    std::fs::rename(&replacement, &path).unwrap();
                }
                _ => {
                    std::fs::rename(&parent, dir.path().join("moved")).unwrap();
                    std::fs::create_dir(&parent).unwrap();
                    std::fs::write(&path, b"old").unwrap();
                }
            }
            assert!(write.commit(&|| true).is_err());
            assert_ne!(std::fs::read(&path).unwrap(), b"new");
        }
    }

    #[test]
    fn private_stage_preserves_regular_modes_and_rejects_unsupported_metadata() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();
        let mut write = begin(&path, &request(b"new", Some(b"old"))).unwrap();
        let private = std::fs::read_dir(dir.path())
            .unwrap()
            .map(Result::unwrap)
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".opengeni-write-")
            })
            .unwrap();
        assert_eq!(private.metadata().unwrap().mode() & 0o777, 0o700);
        write.append(b"new").unwrap();
        write.commit(&|| true).unwrap();
        drop(write);
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o751);
        let link = dir.path().join("symlink");
        symlink(&path, &link).unwrap();
        assert!(begin(&link, &request(b"x", Some(b"new"))).is_err());
        let hardlink = dir.path().join("hardlink");
        std::fs::hard_link(&path, &hardlink).unwrap();
        assert!(begin(&path, &request(b"x", Some(b"new"))).is_err());
        std::fs::remove_file(&hardlink).unwrap();
        xattr::set(&path, "user.synthetic", b"attribute").unwrap();
        assert!(begin(&path, &request(b"x", Some(b"new"))).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn empty_file_creation_and_existing_file_base_validation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty");
        let mut write = begin(&path, &request(b"", None)).unwrap();
        write.commit(&|| true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert!(begin(&path, &request(b"x", Some(b"wrong"))).is_err());
    }

    #[test]
    fn directory_spelling_symlink_parent_and_missing_parent_fail_closed() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        std::fs::write(&path, b"old").unwrap();
        for suffix in ["/", "/."] {
            let mut spelling = path.as_os_str().to_os_string();
            spelling.push(suffix);
            assert!(begin(Path::new(&spelling), &request(b"new", Some(b"old"))).is_err());
        }
        let alias = dir.path().join("alias");
        symlink(dir.path(), &alias).unwrap();
        assert!(begin(&alias.join("document"), &request(b"new", Some(b"old"))).is_err());
        let missing = dir.path().join("missing");
        let mut create = request(b"new", None);
        create.create_parents = true;
        assert!(begin(&missing.join("document"), &create).is_err());
        assert!(!missing.exists());
        assert_eq!(std::fs::read(path).unwrap(), b"old");
    }

    #[test]
    fn incomplete_or_ambiguous_contract_cannot_create_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        for case in 0..5 {
            let mut req = request(b"", None);
            match case {
                0 => req.content_size = None,
                1 => req.content_digest.clear(),
                2 => req.expected_absent = false,
                3 => req.expected_base_digest = blake3::hash(b"old").to_hex().to_string(),
                _ => req.mode = 0o4755,
            }
            assert!(begin(&path, &req).is_err());
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }
}
