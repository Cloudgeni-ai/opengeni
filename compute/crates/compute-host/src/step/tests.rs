use super::*;

fn written(jail: &Path) -> SnapshotFiles {
    SnapshotFiles {
        state: jail.join("save.state"),
        memory: jail.join("save.mem"),
    }
}

#[test]
fn snapshot_outputs_must_be_plain_files_of_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let (jail, scratch) = (dir.path().join("jail"), dir.path().join("saving"));
    fs::create_dir(&jail).unwrap();
    let secret = dir.path().join("secret");
    fs::write(&secret, "host only").unwrap();
    let files = written(&jail);

    fs::write(&files.state, "state").unwrap();
    fs::write(&files.memory, "memory").unwrap();
    let taken = take_written(&files, &scratch).unwrap();
    assert_eq!(fs::read_to_string(&taken.memory).unwrap(), "memory");
    assert!(!files.memory.exists());

    // A link to a host file, by name or by inode, is refused.
    fs::write(&files.state, "state").unwrap();
    std::os::unix::fs::symlink(&secret, &files.memory).unwrap();
    assert!(take_written(&files, &scratch).is_err());
    // The refused link was moved out of the jail with the rest.
    assert!(fs::symlink_metadata(&files.memory).is_err());
    fs::hard_link(&secret, &files.memory).unwrap();
    fs::write(&files.state, "state").unwrap();
    assert!(take_written(&files, &scratch).is_err());
    assert_eq!(fs::read_to_string(&secret).unwrap(), "host only");
}

#[test]
fn syncing_a_jailed_file_follows_no_link_and_opens_no_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let disk = dir.path().join("disk.ext4");
    fs::write(&disk, "disk").unwrap();
    sync_jailed(&disk).unwrap();

    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&disk, &link).unwrap();
    assert!(sync_jailed(&link).is_err());

    let pipe = dir.path().join("pipe");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &pipe,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    assert!(sync_jailed(&pipe).is_err(), "a pipe must not block or pass");
}
