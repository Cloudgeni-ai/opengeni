//! The agent's program, kept so that the agent can always start again.
//!
//! The agent runs from [`AGENT_PATH`] on the sandbox's disk, where a
//! command running as root can move, remove or overwrite it. The init used
//! to start the agent only while that file was there, so an agent that then
//! ended stayed gone, through reboots as well. The init therefore keeps its
//! own copy of the program, [`KEPT_AGENT_PATH`] beside its own files in a
//! directory only root may enter: a copy rather than a link, so writing
//! over the usual path's file does not change it, and on the disk, so a
//! reboot finds it. Before it starts the agent, the init puts the kept
//! program back at the usual path when that holds no program (or one that
//! does not start, or keeps ending at once), in one rename, and starts it
//! from there, the path the agent's own self-update replaces. The program
//! the agent has run for a whole [`PROVEN`] period, from the file still at
//! the usual path, is the one kept from then on: a verified self-update
//! (which the agent execs as the same process) is kept once it has run
//! that long, and so is what a reboot starts. An agent started from the
//! kept path itself (a directory took the usual one) replaces the kept
//! copy when it updates itself. The copy costs one agent-sized file on
//! each sandbox's disk.

use std::fs::{self, DirBuilder, File};
use std::io::{self, Read as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::agent::AGENT_PATH;

/// Where the init keeps the agent's program: beside its own files on the
/// sandbox's disk, in a directory only root may enter.
pub const KEPT_AGENT_PATH: &str = "/opengeni/kept/opengeni-agent";

/// How often the init looks at which program the agent runs: one that ran
/// a whole period is the one kept.
pub const PROVEN: Duration = Duration::from_secs(60);

/// One file, by its device and inode.
pub type FileId = (u64, u64);

/// A program at its usual path, and the init's own copy of it.
#[derive(Debug, Clone)]
pub struct Program {
    path: PathBuf,
    kept: PathBuf,
}

impl Program {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, kept: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kept: kept.into(),
        }
    }

    /// Opengeni's agent.
    #[must_use]
    pub fn agent() -> Self {
        Self::new(AGENT_PATH, KEPT_AGENT_PATH)
    }

    /// Its usual path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The init's own copy of it.
    #[must_use]
    pub fn kept(&self) -> &Path {
        &self.kept
    }

    /// Whether there is a program to start, at its path or kept.
    #[must_use]
    pub fn available(&self) -> bool {
        is_program(&self.path) || is_program(&self.kept)
    }

    /// The file at its usual path, if that holds a program.
    #[must_use]
    pub fn current(&self) -> Option<FileId> {
        is_program(&self.path)
            .then(|| fs::metadata(&self.path).ok())
            .flatten()
            .map(|meta| (meta.dev(), meta.ino()))
    }

    /// Whether a program is kept.
    #[must_use]
    pub fn is_kept(&self) -> bool {
        is_program(&self.kept)
    }

    /// Whether the usual path holds a program the same as the one kept.
    #[must_use]
    pub fn holds_kept(&self) -> bool {
        is_program(&self.path) && self.is_kept() && same_content(&self.path, &self.kept)
    }

    /// Keeps the program at its usual path, unless nothing is kept yet and
    /// `only_first` is set, or it already is the one kept. Whether it kept
    /// it.
    pub fn keep(&self, only_first: bool) -> io::Result<bool> {
        if self.current().is_none() {
            return Ok(false);
        }
        if self.is_kept() && (only_first || self.holds_kept()) {
            return Ok(false);
        }
        let dir = parent(&self.kept)?;
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        // The file itself, never a symbolic link to it.
        let source = fs::canonicalize(&self.path)?;
        place(&source, &self.kept)?;
        Ok(true)
    }

    /// Puts the kept program at its usual path when that holds no program,
    /// or whenever `force` is set and the one there is not the one kept.
    /// Whether it put it back.
    pub fn restore(&self, force: bool) -> io::Result<bool> {
        if !self.is_kept() {
            return Ok(false);
        }
        if self.current().is_some() && (!force || self.holds_kept()) {
            return Ok(false);
        }
        // A directory in its place is never removed: it may hold files.
        if fs::symlink_metadata(&self.path).is_ok_and(|meta| meta.is_dir()) {
            return Err(io::Error::other("a directory is in its place"));
        }
        DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(parent(&self.path)?)?;
        place(&self.kept, &self.path)?;
        Ok(true)
    }
}

/// Whether `path` is (or leads to) a file that can be run.
fn is_program(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn parent(path: &Path) -> io::Result<&Path> {
    path.parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Whether two files hold the same bytes.
fn same_content(a: &Path, b: &Path) -> bool {
    let (Ok(mut a), Ok(mut b)) = (File::open(a), File::open(b)) else {
        return false;
    };
    match (a.metadata(), b.metadata()) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => {}
        _ => return false,
    }
    let (mut left, mut right) = (vec![0; 1 << 16], vec![0; 1 << 16]);
    loop {
        let Ok(read) = a.read(&mut left) else {
            return false;
        };
        if read == 0 {
            return b.read(&mut right[..1]).is_ok_and(|more| more == 0);
        }
        if b.read_exact(&mut right[..read]).is_err() || left[..read] != right[..read] {
            return false;
        }
    }
}

/// Puts a copy of `source` at `target` in one rename, through a file
/// beside the target, written out before it takes the name.
fn place(source: &Path, target: &Path) -> io::Result<()> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let staged = parent(target)?.join(format!(".{}.placing", name.to_string_lossy()));
    match fs::remove_file(&staged) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::copy(source, &staged)?;
    File::open(&staged)?.sync_all()?;
    fs::rename(&staged, target).inspect_err(|_| {
        let _ = fs::remove_file(&staged);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "compute-guest-program-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn script(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_moved_program_is_put_back_from_the_one_kept() {
        let dir = scratch("moved");
        let program = Program::new(dir.join("bin/agent"), dir.join("init/kept/agent"));
        script(program.path(), "echo agent");
        assert!(program.keep(true).unwrap());
        assert!(program.holds_kept());
        let kept_mode = fs::metadata(dir.join("init/kept"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(kept_mode & 0o777, 0o700);
        assert!(!program.keep(false).unwrap(), "already kept");

        // `mv /usr/local/bin/opengeni-agent …`
        fs::rename(program.path(), dir.join("moved-away")).unwrap();
        assert!(program.current().is_none());
        assert!(program.available(), "the kept one can still start");
        assert!(program.restore(false).unwrap());
        assert_eq!(
            fs::read_to_string(program.path()).unwrap(),
            "#!/bin/sh\necho agent\n"
        );
        assert!(program.current().is_some());
        // Nothing to do once it is back.
        assert!(!program.restore(false).unwrap());

        // `rm`, and the directory with it.
        fs::remove_dir_all(dir.join("bin")).unwrap();
        assert!(program.restore(false).unwrap());
        assert!(program.current().is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_holds_no_program_is_replaced_but_a_directory_is_not() {
        let dir = scratch("replaced");
        let program = Program::new(dir.join("agent"), dir.join("kept/agent"));
        script(program.path(), "echo agent");
        program.keep(true).unwrap();
        fs::remove_file(program.path()).unwrap();
        // A file that cannot run.
        fs::write(program.path(), "not a program").unwrap();
        assert!(program.restore(false).unwrap());
        assert!(program.holds_kept());
        // A link to nothing.
        fs::remove_file(program.path()).unwrap();
        symlink(dir.join("nowhere"), program.path()).unwrap();
        assert!(program.restore(false).unwrap());
        assert!(program.holds_kept());
        // A directory.
        fs::remove_file(program.path()).unwrap();
        fs::create_dir(program.path()).unwrap();
        assert!(program.restore(false).is_err());
        assert!(program.path().is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_program_is_replaced_only_when_forced_and_kept_once_proven() {
        let dir = scratch("forced");
        let program = Program::new(dir.join("agent"), dir.join("kept/agent"));
        script(program.path(), "echo first");
        program.keep(true).unwrap();
        // A self-update renames a new program over the path.
        script(&dir.join("next"), "echo second");
        fs::rename(dir.join("next"), program.path()).unwrap();
        assert!(!program.restore(false).unwrap(), "a program is there");
        assert!(
            !program.keep(true).unwrap(),
            "only the first is kept at boot"
        );
        // Once it has proven itself, it is the one kept.
        assert!(program.keep(false).unwrap());
        assert!(program.holds_kept());
        assert_eq!(
            fs::read_to_string(program.kept()).unwrap(),
            "#!/bin/sh\necho second\n"
        );
        // One that keeps failing is replaced with the kept one when forced.
        script(&dir.join("broken"), "exit 1");
        fs::rename(dir.join("broken"), program.path()).unwrap();
        assert!(program.restore(true).unwrap());
        assert_eq!(
            fs::read_to_string(program.path()).unwrap(),
            "#!/bin/sh\necho second\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_over_the_program_does_not_change_the_one_kept() {
        let dir = scratch("overwritten");
        let program = Program::new(dir.join("agent"), dir.join("kept/agent"));
        script(program.path(), "echo agent");
        program.keep(true).unwrap();
        // `cp /bin/true /usr/local/bin/opengeni-agent` writes in place.
        fs::write(program.path(), "#!/bin/sh\nexit 1\n").unwrap();
        assert!(!program.holds_kept());
        assert_eq!(
            fs::read_to_string(program.kept()).unwrap(),
            "#!/bin/sh\necho agent\n"
        );
        assert!(program.restore(true).unwrap());
        assert!(program.holds_kept());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_kept_or_put_back_without_a_program() {
        let dir = scratch("none");
        let program = Program::new(dir.join("agent"), dir.join("kept/agent"));
        assert!(!program.available());
        assert!(!program.keep(true).unwrap());
        assert!(!program.restore(true).unwrap());
        // A symbolic link at the path keeps the file it leads to.
        script(&dir.join("real"), "echo real");
        symlink(dir.join("real"), program.path()).unwrap();
        assert!(program.keep(true).unwrap());
        fs::remove_file(dir.join("real")).unwrap();
        assert!(program.restore(false).unwrap());
        assert_eq!(
            fs::read_to_string(program.path()).unwrap(),
            "#!/bin/sh\necho real\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
