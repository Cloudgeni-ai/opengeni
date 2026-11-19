//! A test that fails part way must fail alone. Its VMs are processes of
//! their own, which outlive the agent that started them as they do on a
//! host (an agent restarting adopts them), so ending its agent leaves them
//! running: the next tests would count them as theirs, find their names
//! and networks taken, and share the machine's memory with them.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Ends every VM under the cgroup `parent`, the VMM and whatever else is
/// in its group, and waits up to 10 s for them to be gone: a process the
/// kernel was told to kill still counts until it has exited.
pub fn end_vms(parent: &Path) {
    let Ok(vms) = std::fs::read_dir(parent) else {
        return;
    };
    let vms: Vec<PathBuf> = vms
        .flatten()
        .map(|vm| vm.path())
        .filter(|vm| vm.is_dir())
        .collect();
    for vm in &vms {
        let _ = std::fs::write(vm.join("cgroup.kill"), "1");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline
        && vms.iter().any(|vm| {
            std::fs::read_to_string(vm.join("cgroup.events"))
                .is_ok_and(|events| events.contains("populated 1"))
        })
    {
        std::thread::sleep(Duration::from_millis(50));
    }
}
