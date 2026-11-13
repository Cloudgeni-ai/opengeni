//! Every boot copies the guest kernel from the agent's own copy of it on
//! the state root (ADR 39), which the agent makes as it starts: on the
//! sandboxes' filesystem, so each boot's copy can share its extents rather
//! than write the whole kernel again. Each jail still gets a file of its own.

use std::os::unix::fs::MetadataExt;
use std::sync::Arc;

use compute_core::{HostPolicy, Priority};
use compute_host::protocol::SandboxConfig;
use compute_host::{HostAgent, NoStore};

use super::{Delays, Fake, Lab, NEVER, id};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn boots_copy_the_agents_own_copy_of_the_kernel() {
    let root = Lab::root();
    let config = Lab::config(&root, HostPolicy::default());
    let state = config.root.clone();
    let world = Arc::default();
    let engine = Fake {
        world: Arc::clone(&world),
        delays: Delays::default(),
    };
    let (handle, _agent) = HostAgent::start(config, engine, NoStore).await.unwrap();

    let staged = state.join("kernel/vmlinux");
    assert_eq!(
        std::fs::read(&staged).expect("the agent's copy of the kernel"),
        b"kernel"
    );
    handle
        .create(id(1), SandboxConfig::new(1, 128, NEVER))
        .await
        .unwrap();
    // A fresh boot links the kernel into the jail.
    let _lease = handle
        .acquire(id(1), None, Priority::Interactive)
        .await
        .unwrap();
    let jailed = state
        .join("vm/firecracker")
        .join(id(1).to_string())
        .join("root/vmlinux");
    assert_eq!(std::fs::read(&jailed).unwrap(), b"kernel");
    let (staged, jailed) = (
        std::fs::metadata(&staged).unwrap(),
        std::fs::metadata(&jailed).unwrap(),
    );
    assert_eq!(staged.dev(), jailed.dev());
    assert_ne!(
        staged.ino(),
        jailed.ino(),
        "a jail's kernel is its own file"
    );
}
