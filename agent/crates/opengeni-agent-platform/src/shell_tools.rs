//! The agent's own copies of common shell tools (ripgrep and jq).
//!
//! A release agent materializes them into one directory at start and appends
//! that directory to the end of every command's `PATH`, so a copy the machine
//! already has always wins and the agent's copy only fills a gap. Development
//! builds carry no tools and never change a command's environment.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

/// The search path a Unix shell falls back to when a process has no `PATH`.
/// Setting only the tools directory would otherwise hide every system command.
#[cfg(unix)]
const DEFAULT_UNIX_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Records the directory holding this agent's shell tools. The first call wins.
pub fn set_shell_tools_directory(directory: PathBuf) {
    let _ = DIRECTORY.set(directory);
}

/// The directory recorded by [`set_shell_tools_directory`], if any.
#[must_use]
pub fn shell_tools_directory() -> Option<&'static Path> {
    DIRECTORY.get().map(PathBuf::as_path)
}

/// The `PATH` a child should receive so the agent's shell tools are found
/// last, or `None` to leave the child's environment untouched (no tools, or
/// the directory is already present). `requested` is the request's own
/// `PATH`; without one the agent's process `PATH` is extended.
#[must_use]
pub fn path_with_shell_tools<'a, I>(requested_env: I) -> Option<OsString>
where
    I: IntoIterator<Item = (&'a String, &'a String)>,
{
    let directory = shell_tools_directory()?;
    let requested = requested_path(requested_env).map(OsString::from);
    append_directory(requested.or_else(|| std::env::var_os("PATH")), directory)
}

/// The request's `PATH` value. Windows environment names ignore case.
fn requested_path<'a, I>(env: I) -> Option<&'a str>
where
    I: IntoIterator<Item = (&'a String, &'a String)>,
{
    env.into_iter()
        .filter(|(name, _)| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case("PATH")
            } else {
                name.as_str() == "PATH"
            }
        })
        .last()
        .map(|(_, value)| value.as_str())
}

fn append_directory(current: Option<OsString>, directory: &Path) -> Option<OsString> {
    let current = match current {
        Some(current) => current,
        #[cfg(unix)]
        None => OsString::from(DEFAULT_UNIX_PATH),
        #[cfg(not(unix))]
        None => return None,
    };
    // An empty `PATH` deliberately searches nowhere; appending would turn it
    // into `:<dir>`, which also searches the working directory.
    if current.is_empty() {
        return None;
    }
    let mut entries = std::env::split_paths(&current).collect::<Vec<_>>();
    if entries.iter().any(|entry| same_directory(entry, directory)) {
        return None;
    }
    entries.push(directory.to_path_buf());
    std::env::join_paths(entries).ok()
}

fn same_directory(entry: &Path, directory: &Path) -> bool {
    if cfg!(windows) {
        let normalize = |path: &Path| {
            let text: &OsStr = path.as_os_str();
            text.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_ascii_lowercase()
        };
        normalize(entry) == normalize(directory)
    } else {
        entry == directory
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(entries: &[&str]) -> OsString {
        std::env::join_paths(entries).expect("joinable")
    }

    #[test]
    fn appends_after_every_system_entry() {
        let tools = Path::new(if cfg!(windows) {
            r"C:\og\tools"
        } else {
            "/og/tools"
        });
        let system = if cfg!(windows) {
            r"C:\Windows\System32"
        } else {
            "/usr/bin"
        };
        let path = append_directory(Some(joined(&[system])), tools).expect("extended");
        let entries = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(entries, vec![PathBuf::from(system), tools.to_path_buf()]);
    }

    #[test]
    fn leaves_a_path_that_already_has_the_directory() {
        let tools = Path::new(if cfg!(windows) {
            r"C:\og\tools"
        } else {
            "/og/tools"
        });
        let system = if cfg!(windows) { r"C:\Windows" } else { "/bin" };
        let current = joined(&[system, tools.to_str().expect("utf-8")]);
        assert_eq!(append_directory(Some(current), tools), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_path_keeps_the_default_system_search() {
        let path = append_directory(None, Path::new("/og/tools")).expect("extended");
        assert_eq!(
            path,
            OsString::from(format!("{DEFAULT_UNIX_PATH}:/og/tools"))
        );
    }

    #[test]
    fn an_empty_path_is_left_alone() {
        assert_eq!(
            append_directory(Some(OsString::new()), Path::new("/og/tools")),
            None
        );
    }

    #[test]
    fn the_request_path_is_extended_instead_of_the_agent_path() {
        let env = [("PATH".to_string(), "/request/bin".to_string())];
        assert_eq!(
            requested_path(env.iter().map(|(name, value)| (name, value))),
            Some("/request/bin")
        );
        let none: [(String, String); 0] = [];
        assert_eq!(requested_path(none.iter().map(|(n, v)| (n, v))), None);
    }
}
