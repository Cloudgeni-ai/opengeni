//! Run-as against the real kernel: exec, git, PTY, file operations and
//! transactional writes executed as another local user.
//!
//! These tests need Linux and an agent-like root process. Elsewhere, or when
//! not root, each test returns early (CI runners are not root); the Linux root
//! run is `sudo -E cargo test -p opengeni-agent-platform --test run_as`.

#![cfg(target_os = "linux")]

use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::Path;

use opengeni_agent_platform::run_as::{self, RunAsIdentity};
use opengeni_agent_platform::{spawn_pty, NativePlatform, Platform, PlatformError};
use opengeni_agent_proto::v1;

/// The unprivileged account every mainstream distribution ships.
const USER: &str = "nobody";

fn identity() -> Option<RunAsIdentity> {
    if !run_as::supported() {
        eprintln!("skipped: run-as needs a Linux root process");
        return None;
    }
    Some(
        run_as::resolve(USER)
            .expect("resolve nobody")
            .expect("non-empty run_as"),
    )
}

/// A scratch directory the test user may write into (and root owns).
fn shared_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    dir
}

/// A directory only root may enter.
fn private_dir(parent: &Path) -> std::path::PathBuf {
    let path = parent.join("root-only");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn owner(path: &Path) -> (u32, u32) {
    let meta = std::fs::symlink_metadata(path).expect("stat");
    (meta.uid(), meta.gid())
}

async fn exec_as(platform: &NativePlatform, script: &str, run_as: &str) -> v1::ExecResponse {
    platform
        .exec(&v1::ExecRequest {
            command: vec![script.to_string()],
            shell: true,
            run_as: run_as.to_string(),
            timeout_ms: 30_000,
            ..Default::default()
        })
        .await
        .expect("exec")
}

#[test]
fn the_capability_matches_the_process() {
    let platform = NativePlatform::new();
    assert_eq!(platform.run_as_supported(), run_as::supported());
}

#[tokio::test]
async fn exec_runs_with_the_users_ids_groups_and_login_environment() {
    let Some(user) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let reply = exec_as(
        &platform,
        "echo \"$(id -u) $(id -g) $HOME $USER $LOGNAME $SHELL\"; id -G; touch made-by-exec",
        USER,
    )
    .await;
    assert_eq!(reply.exit_code, 0, "stderr: {:?}", reply.stderr);
    let stdout = String::from_utf8_lossy(&reply.stdout);
    let mut lines = stdout.lines();
    assert_eq!(
        lines.next().unwrap(),
        format!(
            "{} {} {} {} {} {}",
            user.uid,
            user.gid,
            user.home.display(),
            user.name,
            user.name,
            user.shell.display()
        )
    );
    let mut groups: Vec<u32> = lines
        .next()
        .unwrap()
        .split_whitespace()
        .map(|group| group.parse().unwrap())
        .collect();
    groups.sort_unstable();
    assert_eq!(groups, user.groups);
    assert_eq!(
        owner(&dir.path().join("made-by-exec")),
        (user.uid, user.gid)
    );

    // Request environment overrides the login environment.
    let reply = platform
        .exec(&v1::ExecRequest {
            command: vec!["echo $HOME".to_string()],
            shell: true,
            env: [("HOME".to_string(), "/custom".to_string())].into(),
            run_as: USER.to_string(),
            ..Default::default()
        })
        .await
        .expect("exec");
    assert_eq!(String::from_utf8_lossy(&reply.stdout).trim(), "/custom");
}

#[tokio::test]
async fn the_child_cannot_regain_root() {
    let Some(_) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let reply = exec_as(
        &platform,
        "grep -E '^(Uid|Gid|CapEff)' /proc/self/status",
        USER,
    )
    .await;
    let status = String::from_utf8_lossy(&reply.stdout);
    assert_eq!(status.lines().count(), 3, "{status}");
    for line in status.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match fields[0] {
            "Uid:" | "Gid:" => assert!(
                fields[1..].iter().all(|id| *id != "0"),
                "real, effective, saved and fs ids all switched: {line}"
            ),
            "CapEff:" => assert_eq!(fields[1], "0000000000000000"),
            _ => {}
        }
    }
}

#[tokio::test]
async fn the_agent_keeps_its_own_identity() {
    let Some(_) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    exec_as(&platform, "true", USER).await;
    platform
        .fs_write(&v1::FsWriteRequest {
            path: "as-user".into(),
            content: "x".into(),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("write as user");
    platform
        .fs_write(&v1::FsWriteRequest {
            path: "as-agent".into(),
            content: "x".into(),
            ..Default::default()
        })
        .await
        .expect("write as agent");
    assert_eq!(owner(&dir.path().join("as-agent")), (0, 0));
    let reply = exec_as(&platform, "id -u", "").await;
    assert_eq!(String::from_utf8_lossy(&reply.stdout).trim(), "0");
    assert!(run_as::supported(), "the agent process is still root");
}

#[tokio::test]
async fn unknown_users_fail_with_their_typed_error() {
    let Some(_) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let error = platform
        .exec(&v1::ExecRequest {
            command: vec!["true".to_string()],
            run_as: "opengeni-no-such-user".into(),
            ..Default::default()
        })
        .await
        .expect_err("unknown user");
    assert!(matches!(error, PlatformError::RunAsUnknownUser(_)));
    let error = platform
        .fs_stat(&v1::FsStatRequest {
            path: String::new(),
            run_as: "4000000000".into(),
        })
        .await
        .expect_err("unknown uid");
    assert_eq!(error.code(), v1::ErrorCode::RunAsUnknownUser);
}

#[tokio::test]
async fn file_operations_create_user_owned_files_and_respect_permissions() {
    let Some(user) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let ours = (user.uid, user.gid);

    platform
        .fs_write(&v1::FsWriteRequest {
            path: "nested/dir/file.txt".into(),
            content: "hello".into(),
            create_parents: true,
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("write");
    assert_eq!(owner(&dir.path().join("nested")), ours);
    assert_eq!(owner(&dir.path().join("nested/dir/file.txt")), ours);

    platform
        .fs_mkdir(&v1::FsMkdirRequest {
            path: "made/deep".into(),
            parents: true,
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("mkdir");
    assert_eq!(owner(&dir.path().join("made/deep")), ours);

    platform
        .fs_move(&v1::FsMoveRequest {
            from: "nested/dir/file.txt".into(),
            to: "made/deep/moved.txt".into(),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("move");
    let read = platform
        .fs_read(&v1::FsReadRequest {
            path: "made/deep/moved.txt".into(),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("read");
    assert_eq!(&read.content[..], b"hello");
    let listed = platform
        .fs_list(&v1::FsListRequest {
            path: "made".into(),
            recursive: true,
            run_as: USER.into(),
        })
        .await
        .expect("list");
    assert_eq!(listed.entries.len(), 2);

    // The kernel applies the user's permissions, not the agent's.
    let private = private_dir(dir.path());
    std::fs::write(private.join("secret"), b"root only").unwrap();
    let private_path = private.to_string_lossy().into_owned();
    let denied = platform
        .fs_read(&v1::FsReadRequest {
            path: format!("{private_path}/secret"),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect_err("read denied");
    assert_eq!(denied.code(), v1::ErrorCode::Os, "{denied}");
    platform
        .fs_write(&v1::FsWriteRequest {
            path: format!("{private_path}/new"),
            content: "x".into(),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect_err("write denied");
    platform
        .fs_remove(&v1::FsRemoveRequest {
            path: format!("{private_path}/secret"),
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect_err("remove denied");
    assert!(private.join("secret").exists());

    platform
        .fs_remove(&v1::FsRemoveRequest {
            path: "made".into(),
            recursive: true,
            run_as: USER.into(),
        })
        .await
        .expect("remove own tree");
    assert!(!dir.path().join("made").exists());
}

#[test]
fn transactional_writes_stage_and_publish_as_the_user() {
    let Some(user) = identity() else { return };
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let content = b"transactional";
    let request = |path: String| v1::FsWriteBegin {
        path,
        content_digest: blake3::hash(content).to_hex().to_string(),
        content_size: Some(content.len() as u64),
        expected_absent: true,
        run_as: USER.into(),
        ..Default::default()
    };
    let target = dir.path().join("published");
    let mut write = platform
        .fs_write_begin(&request(target.to_string_lossy().into_owned()))
        .expect("begin");
    write.append(content).expect("append");
    write.commit(&|| true).expect("commit");
    assert_eq!(std::fs::read(&target).unwrap(), content);
    assert_eq!(owner(&target), (user.uid, user.gid));

    let private = private_dir(dir.path());
    assert!(platform
        .fs_write_begin(&request(private.join("x").to_string_lossy().into_owned()))
        .is_err());
    assert_eq!(std::fs::read_dir(&private).unwrap().count(), 0);
}

#[tokio::test]
async fn git_runs_as_the_user() {
    let Some(user) = identity() else { return };
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipped: git is not installed");
        return;
    }
    let dir = shared_dir();
    let platform = NativePlatform::with_root(dir.path());
    let reply = platform
        .git(&v1::GitRequest {
            op: v1::GitOp::Raw as i32,
            args: vec!["init".into(), "-q".into(), "repo".into()],
            run_as: USER.into(),
            ..Default::default()
        })
        .await
        .expect("git init");
    assert_eq!(reply.exit_code, 0, "{:?}", reply.stderr);
    assert_eq!(owner(&dir.path().join("repo/.git")), (user.uid, user.gid));
}

#[test]
fn pty_children_run_as_the_user_and_own_their_terminal() {
    use std::io::Read as _;

    let Some(user) = identity() else { return };
    let mut process = spawn_pty(
        &v1::PtyOpenRequest {
            command: vec![
                "/bin/sh".into(),
                "-c".into(),
                "echo \"$(id -u) $USER $(stat -c %u \"$(tty)\") $(pwd)\"".into(),
            ],
            run_as: USER.into(),
            ..Default::default()
        },
        &["/bin/sh".to_string()],
    )
    .expect("spawn pty");
    let mut reader = process.take_reader().expect("reader");
    let mut output = Vec::new();
    let mut chunk = [0_u8; 256];
    // Read until the child's line arrives; the master reports EIO at exit.
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            break;
        }
        output.extend_from_slice(&chunk[..read]);
        if output.contains(&b'\n') {
            break;
        }
    }
    let text = String::from_utf8_lossy(&output);
    // With no cwd the terminal starts in the user's home, or `/` without one.
    let start = if user.home.is_dir() {
        user.home.display().to_string()
    } else {
        "/".to_string()
    };
    assert_eq!(
        text.trim(),
        format!("{} {} {} {start}", user.uid, user.name, user.uid)
    );
}
