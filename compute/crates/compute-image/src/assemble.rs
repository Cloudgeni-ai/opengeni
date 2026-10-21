//! What every image gets on top of its layers, for the guest and the E2B
//! SDK to work in it.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use compute_guest::config::{self, ImageConfig};
use compute_guest::users;

use crate::registry::RunConfig;
use crate::rootpath::{self, clean, resolve, resolve_all};

/// The files a build takes from the guest directory (`guest/build.sh`).
pub const GUEST_INIT: &str = "compute-guest";
pub const GUEST_ENVD: &str = "envd";
pub const GUEST_BASH: &str = "bash";

/// E2B's default user, added when an image has no account of that name.
const USER_LINE: &str = "user:x:1000:1000::/home/user:/bin/bash";
const USER_GROUP_LINE: &str = "user:x:1000:";

/// What the build added beyond the guest's own files.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Added {
    pub bash: bool,
    pub user: bool,
}

/// The guest's view of an OCI run config.
#[must_use]
pub fn image_config(run: Option<&RunConfig>) -> ImageConfig {
    let run = run.cloned().unwrap_or_default();
    ImageConfig {
        user: run.user.unwrap_or_default(),
        working_dir: run.working_dir.unwrap_or_default(),
        env: run.env.unwrap_or_default(),
        entrypoint: run.entrypoint.unwrap_or_default(),
        cmd: run.cmd.unwrap_or_default(),
    }
}

/// `path` in the image, its last component not followed.
fn at(root: &Path, path: &str) -> io::Result<PathBuf> {
    resolve(root, &clean(Path::new(path))?)
}

/// `path` in the image as the image itself would open it: every
/// component followed, inside the root.
fn opened(root: &Path, path: &str) -> io::Result<PathBuf> {
    resolve_all(root, &clean(Path::new(path))?)
}

/// A directory the image has at `path` (following its symlinks inside
/// the root), made if missing, with `mode`.
fn directory(root: &Path, path: &str, mode: Option<u32>, owner: Option<(u32, u32)>) -> Result<()> {
    let dir = opened(root, path)?;
    fs::create_dir_all(&dir).with_context(|| format!("/{path}"))?;
    if let Some(mode) = mode {
        rootpath::set_dir(&dir, mode, None, owner).with_context(|| format!("/{path}"))?;
    }
    Ok(())
}

/// Writes `contents` to a new file at `to` in the image, with `mode`,
/// replacing whatever was there without following it.
fn write(root: &Path, to: &str, contents: &mut dyn io::Read, mode: u32) -> Result<()> {
    let path = at(root, to)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = rootpath::create(root, &path, mode).with_context(|| format!("/{to}"))?;
    io::copy(contents, &mut file).with_context(|| format!("/{to}"))?;
    Ok(())
}

fn install(root: &Path, from: &Path, to: &str, mode: u32) -> Result<()> {
    let mut source = fs::File::open(from).with_context(|| format!("copy {}", from.display()))?;
    write(root, to, &mut source, mode)
}

/// Adds the guest's files from `guest` to the image at `root`, with
/// `image` as its config. Nothing it writes follows a symlink the image
/// has, out of the root or within it.
pub fn finish(root: &Path, guest: &Path, image: &ImageConfig) -> Result<Added> {
    for dir in ["proc", "sys", "dev", "run", "etc", "home", "opengeni"] {
        directory(root, dir, None, None)?;
    }
    directory(root, "tmp", Some(0o1777), None)?;
    install(root, &guest.join(GUEST_INIT), config::INIT_PATH, 0o755)?;
    install(root, &guest.join(GUEST_ENVD), config::ENVD_PATH, 0o755)?;
    write(
        root,
        config::CONFIG_PATH,
        &mut serde_json::to_vec_pretty(image)?.as_slice(),
        0o644,
    )?;
    // The kernel starts /sbin/init; the image's own init, if any, never runs.
    let init = at(root, "sbin/init")?;
    if let Some(parent) = init.parent() {
        fs::create_dir_all(parent)?;
    }
    rootpath::remove(root, &init)?;
    std::os::unix::fs::symlink(config::INIT_PATH, &init)?;
    let mut added = Added::default();
    if fs::symlink_metadata(at(root, "bin/bash")?).is_err() {
        install(root, &guest.join(GUEST_BASH), "bin/bash", 0o755)?;
        added.bash = true;
    }
    added.user = add_user(root)?;
    Ok(added)
}

/// The most of an account file read; real ones are a few KiB.
const ACCOUNTS_AT_MOST: u64 = 16 << 20;

/// The text of the file the image has at `path`; empty when missing. It
/// must be a regular file of at most [`ACCOUNTS_AT_MOST`].
fn read(path: &Path) -> Result<String> {
    match rootpath::open(path, None) {
        Ok(file) => {
            let mut text = String::new();
            io::Read::read_to_string(&mut io::Read::take(file, ACCOUNTS_AT_MOST + 1), &mut text)
                .with_context(|| format!("reading {}", path.display()))?;
            anyhow::ensure!(
                text.len() as u64 <= ACCOUNTS_AT_MOST,
                "{} is larger than {ACCOUNTS_AT_MOST} bytes",
                path.display()
            );
            Ok(text)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

/// Adds E2B's `user` (uid 1000, home `/home/user`) unless an account of
/// that name exists. Returns whether it did.
fn add_user(root: &Path) -> Result<bool> {
    let passwd = opened(root, "etc/passwd")?;
    let text = read(&passwd)?;
    let accounts = users::parse_passwd(&text);
    if accounts
        .iter()
        .any(|account| account.name == config::DEFAULT_USER)
    {
        return Ok(false);
    }
    let mut lines = String::new();
    if accounts.is_empty() {
        lines.push_str("root:x:0:0:root:/root:/bin/sh\n");
    }
    lines.push_str(USER_LINE);
    lines.push('\n');
    append(root, &passwd, &text, &lines, 0o644)?;
    let group = opened(root, "etc/group")?;
    let text = read(&group)?;
    let groups = users::parse_group(&text);
    if !groups
        .iter()
        .any(|group| group.name == config::DEFAULT_USER)
    {
        let mut lines = String::new();
        if groups.is_empty() {
            lines.push_str("root:x:0:\n");
        }
        lines.push_str(USER_GROUP_LINE);
        lines.push('\n');
        append(root, &group, &text, &lines, 0o644)?;
    }
    let shadow = opened(root, "etc/shadow")?;
    if fs::symlink_metadata(&shadow).is_ok() {
        let text = read(&shadow)?;
        append(root, &shadow, &text, "user:!:1::::::\n", 0o640)?;
    }
    let owner = rustix::process::geteuid().is_root().then_some((1000, 1000));
    directory(root, "home/user", Some(0o755), owner)?;
    Ok(true)
}

/// Appends `lines` to the file at `path` inside `root`, whose text is
/// `text`, on a line of their own; creates it with `mode` if missing.
fn append(root: &Path, path: &Path, text: &str, lines: &str, mode: u32) -> Result<()> {
    rootpath::confined(root, path)?;
    let mut file = rootpath::open(path, Some(mode))
        .with_context(|| format!("appending to {}", path.display()))?;
    if !text.is_empty() && !text.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    file.write_all(lines.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt as _, symlink};

    use super::*;

    #[test]
    fn symlinks_in_the_image_never_lead_writes_out_of_it() {
        let guest = guest();
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("root");
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::create_dir_all(root.join("opengeni")).unwrap();
        let victim = outer.path().join("victim");
        fs::write(&victim, "keep").unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o644)).unwrap();
        let victim_dir = outer.path().join("victim-dir");
        fs::create_dir(&victim_dir).unwrap();
        fs::set_permissions(&victim_dir, fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&victim, root.join("opengeni/image.json")).unwrap();
        symlink(&victim, root.join("opengeni/envd")).unwrap();
        symlink("../../victim", root.join("etc/passwd")).unwrap();
        symlink("../../../victim", root.join("etc/group")).unwrap();
        symlink(&victim, root.join("etc/shadow")).unwrap();
        // Relative: an absolute target is taken inside the root, and on a
        // host whose temporary directory is /tmp it would name itself.
        symlink("../victim-dir", root.join("tmp")).unwrap();
        symlink("../..", root.join("home")).unwrap();
        finish(&root, guest.path(), &ImageConfig::default()).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode(&victim), 0o644);
        assert_eq!(mode(&victim_dir), 0o755);
        assert_eq!(fs::read_dir(&victim_dir).unwrap().count(), 0);
        // The image's own files took the writes, inside the root.
        assert!(!root.join("opengeni/image.json").is_symlink());
        assert!(!root.join("opengeni/envd").is_symlink());
        assert!(
            fs::read_to_string(root.join("victim"))
                .unwrap()
                .contains(USER_LINE)
        );
        assert!(root.join("user").is_dir());
    }

    #[test]
    fn an_account_file_that_is_not_a_regular_file_is_refused() {
        let guest = guest();
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("root");
        fs::create_dir_all(root.join("etc/passwd")).unwrap();
        let error = format!(
            "{:#}",
            finish(&root, guest.path(), &ImageConfig::default()).unwrap_err()
        );
        assert!(error.contains("not a regular file"), "{error}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_account_file_that_is_a_fifo_is_refused_without_blocking() {
        let guest = guest();
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("root");
        fs::create_dir_all(root.join("etc")).unwrap();
        rustix::fs::mknodat(
            rustix::fs::CWD,
            root.join("etc/passwd"),
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::from_raw_mode(0o644),
            0,
        )
        .unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        let guest_dir = guest.path().to_owned();
        let builder = root.clone();
        std::thread::spawn(move || {
            let _ = done.send(finish(&builder, &guest_dir, &ImageConfig::default()));
        });
        let result = finished
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("blocked on a FIFO");
        let error = format!("{:#}", result.unwrap_err());
        assert!(error.contains("not a regular file"), "{error}");
    }

    fn guest() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in [GUEST_INIT, GUEST_ENVD, GUEST_BASH] {
            fs::write(dir.path().join(name), name).unwrap();
        }
        dir
    }

    #[test]
    fn a_bare_image_gets_everything() {
        let guest = guest();
        let root = tempfile::tempdir().unwrap();
        let image = ImageConfig {
            cmd: vec!["sh".into()],
            ..ImageConfig::default()
        };
        let added = finish(root.path(), guest.path(), &image).unwrap();
        assert_eq!(
            added,
            Added {
                bash: true,
                user: true
            }
        );
        let r = root.path();
        assert_eq!(
            fs::read_to_string(r.join("opengeni/init")).unwrap(),
            GUEST_INIT
        );
        assert_eq!(
            fs::read_to_string(r.join("opengeni/envd")).unwrap(),
            GUEST_ENVD
        );
        assert_eq!(fs::read_to_string(r.join("bin/bash")).unwrap(), GUEST_BASH);
        assert_eq!(
            fs::read_link(r.join("sbin/init")).unwrap(),
            Path::new(config::INIT_PATH)
        );
        let stored: ImageConfig =
            serde_json::from_slice(&fs::read(r.join("opengeni/image.json")).unwrap()).unwrap();
        assert_eq!(stored, image);
        assert_eq!(
            fs::read_to_string(r.join("etc/passwd")).unwrap(),
            format!("root:x:0:0:root:/root:/bin/sh\n{USER_LINE}\n")
        );
        assert_eq!(
            fs::read_to_string(r.join("etc/group")).unwrap(),
            "root:x:0:\nuser:x:1000:\n"
        );
        assert!(r.join("home/user").is_dir());
        assert_eq!(
            fs::metadata(r.join("tmp")).unwrap().permissions().mode() & 0o7777,
            0o1777
        );
    }

    #[test]
    fn what_the_image_has_is_kept() {
        let guest = guest();
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        // A merged /usr image with its own init, bash and user.
        fs::create_dir_all(r.join("usr/bin")).unwrap();
        fs::create_dir_all(r.join("usr/sbin")).unwrap();
        fs::create_dir_all(r.join("etc")).unwrap();
        symlink("usr/bin", r.join("bin")).unwrap();
        symlink("usr/sbin", r.join("sbin")).unwrap();
        fs::write(r.join("usr/bin/bash"), "theirs").unwrap();
        fs::write(r.join("usr/sbin/init"), "systemd").unwrap();
        fs::write(
            r.join("etc/passwd"),
            "root:x:0:0::/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash",
        )
        .unwrap();
        fs::write(r.join("etc/group"), "root:x:0:\nuser:x:1000:\n").unwrap();
        let added = finish(r, guest.path(), &ImageConfig::default()).unwrap();
        assert_eq!(added, Added::default());
        assert_eq!(
            fs::read_to_string(r.join("usr/bin/bash")).unwrap(),
            "theirs"
        );
        assert!(r.join("bin").is_symlink());
        assert_eq!(
            fs::read_link(r.join("usr/sbin/init")).unwrap(),
            Path::new(config::INIT_PATH)
        );
    }

    #[test]
    fn users_are_appended_on_lines_of_their_own() {
        let guest = guest();
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        fs::create_dir_all(r.join("etc")).unwrap();
        fs::write(r.join("etc/passwd"), "root:x:0:0::/root:/bin/sh").unwrap();
        fs::write(r.join("etc/shadow"), "root:*:1::::::\n").unwrap();
        finish(r, guest.path(), &ImageConfig::default()).unwrap();
        assert_eq!(
            fs::read_to_string(r.join("etc/passwd")).unwrap(),
            format!("root:x:0:0::/root:/bin/sh\n{USER_LINE}\n")
        );
        assert!(
            fs::read_to_string(r.join("etc/shadow"))
                .unwrap()
                .ends_with("\nuser:!:1::::::\n")
        );
    }

    #[test]
    fn run_configs_become_image_configs() {
        let run = RunConfig {
            user: Some("node".into()),
            working_dir: Some("/app".into()),
            env: Some(vec!["A=1".into()]),
            entrypoint: None,
            cmd: Some(vec!["node".into()]),
        };
        let image = image_config(Some(&run));
        assert_eq!(
            (image.user.as_str(), image.working_dir.as_str()),
            ("node", "/app")
        );
        assert_eq!(image.command(), ["node"]);
        assert_eq!(image_config(None), ImageConfig::default());
    }
}
