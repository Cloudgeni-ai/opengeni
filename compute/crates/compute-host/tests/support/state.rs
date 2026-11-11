//! A test host's state lives where only root may enter, as a real host's
//! does (`install.sh` makes `/var/lib/compute/state` `0700`): a process
//! that drops to a sandbox's user and still reaches the sandbox's files by
//! path fails here as it would there.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// Creates `dir`, which only its owner may enter.
pub fn private_dir(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
}
