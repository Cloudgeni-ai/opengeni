//! The guest programs' digest is the one a host's `install.sh` names its
//! base image by, so images built for a guest and hosts running it agree.

use std::fs;
use std::os::unix::fs::symlink;
use std::process::Command;

use compute_image::assemble::guest_digest;

/// The same files through `install.sh`'s pipeline: nested ones, names
/// that sort by byte, and a symlink, which neither counts.
#[test]
fn the_guest_digest_is_the_one_install_names_the_base_image_by() {
    let guest = tempfile::tempdir().unwrap();
    for name in ["init", "envd", "bash"] {
        fs::write(guest.path().join(name), name).unwrap();
    }
    fs::create_dir(guest.path().join("lib")).unwrap();
    fs::write(guest.path().join("lib/z"), "z").unwrap();
    fs::write(guest.path().join("Upper"), "upper").unwrap();
    symlink("envd", guest.path().join("link")).unwrap();
    let shell = Command::new("sh")
        .arg("-c")
        .arg(
            "find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum \
             | cut -d' ' -f1",
        )
        .current_dir(guest.path())
        .output()
        .unwrap();
    assert!(shell.status.success(), "{shell:?}");
    let expected = format!("sha256:{}", String::from_utf8(shell.stdout).unwrap().trim());
    assert_eq!(guest_digest(guest.path()).unwrap(), expected);
}
