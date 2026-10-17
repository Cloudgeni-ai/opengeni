//! What every image gets on top of its layers, for the guest and the E2B
//! SDK to work in it.

use std::fs;
use std::io::{self, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;

use anyhow::{Context as _, Result};
use compute_guest::config::{self, ImageConfig};
use compute_guest::users;

use crate::registry::RunConfig;
use crate::rootpath::{clean, resolve};

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

fn at(root: &Path, path: &str) -> io::Result<std::path::PathBuf> {
    resolve(root, &clean(Path::new(path))?)
}

fn install(from: &Path, to: &Path, mode: u32) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(to);
    fs::copy(from, to).with_context(|| format!("copy {}", from.display()))?;
    fs::set_permissions(to, fs::Permissions::from_mode(mode))?;
    Ok(())
}

/// Adds the guest's files from `guest` to the image at `root`, with
/// `image` as its config.
pub fn finish(root: &Path, guest: &Path, image: &ImageConfig) -> Result<Added> {
    for dir in [
        "proc", "sys", "dev", "run", "tmp", "etc", "home", "opengeni",
    ] {
        fs::create_dir_all(at(root, dir)?)?;
    }
    fs::set_permissions(at(root, "tmp")?, fs::Permissions::from_mode(0o1777))?;
    install(
        &guest.join(GUEST_INIT),
        &at(root, config::INIT_PATH)?,
        0o755,
    )?;
    install(
        &guest.join(GUEST_ENVD),
        &at(root, config::ENVD_PATH)?,
        0o755,
    )?;
    fs::write(
        at(root, config::CONFIG_PATH)?,
        serde_json::to_vec_pretty(image)?,
    )?;
    // The kernel starts /sbin/init; the image's own init, if any, never runs.
    let init = at(root, "sbin/init")?;
    if let Some(parent) = init.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::symlink_metadata(&init).is_ok_and(|meta| meta.is_dir()) {
        fs::remove_dir_all(&init)?;
    } else {
        let _ = fs::remove_file(&init);
    }
    std::os::unix::fs::symlink(config::INIT_PATH, &init)?;
    let mut added = Added::default();
    let bash = at(root, "bin/bash")?;
    if fs::symlink_metadata(&bash).is_err() {
        install(&guest.join(GUEST_BASH), &bash, 0o755)?;
        added.bash = true;
    }
    added.user = add_user(root)?;
    Ok(added)
}

/// Adds E2B's `user` (uid 1000, home `/home/user`) unless an account of
/// that name exists. Returns whether it did.
fn add_user(root: &Path) -> Result<bool> {
    let passwd = at(root, "etc/passwd")?;
    let text = fs::read_to_string(&passwd).unwrap_or_default();
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
    append(&passwd, &text, &lines)?;
    let group = at(root, "etc/group")?;
    let text = fs::read_to_string(&group).unwrap_or_default();
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
        append(&group, &text, &lines)?;
    }
    let shadow = at(root, "etc/shadow")?;
    if let Ok(text) = fs::read_to_string(&shadow) {
        append(&shadow, &text, "user:!:1::::::\n")?;
    }
    let home = at(root, "home/user")?;
    fs::create_dir_all(&home)?;
    fs::set_permissions(&home, fs::Permissions::from_mode(0o755))?;
    if rustix::process::geteuid().is_root() {
        rustix::fs::chown(
            &home,
            Some(rustix::fs::Uid::from_raw(1000)),
            Some(rustix::fs::Gid::from_raw(1000)),
        )?;
    }
    Ok(true)
}

/// Appends `lines` to the file at `path`, whose text is `text`, on a line
/// of their own.
fn append(path: &Path, text: &str, lines: &str) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    if !text.is_empty() && !text.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    file.write_all(lines.as_bytes())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

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
