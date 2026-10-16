//! A small disk: every VM whose state is not saved yet books what its next
//! save may write, a wake the disk cannot book is refused at once as host
//! full, saying so, and goes through once another VM's state is saved. A
//! save that cannot be written shows in the sandbox's status and succeeds
//! once there is room.

use super::*;

const MIB: u64 = 1 << 20;

/// What one save of a lab sandbox books where files share extents: its
/// 512 MiB of memory and 64 MiB for the rest.
const SAVE: u64 = 576 * MIB;

fn run(command: &mut Command) {
    let status = command.status().unwrap();
    assert!(status.success(), "{command:?}: {status}");
}

/// A loop-mounted XFS filesystem of a few GiB holding an agent's state and
/// a copy of the base image, so new disks share its extents.
struct SmallDisk {
    image: PathBuf,
    mount: PathBuf,
}

impl SmallDisk {
    fn mount(lab: &Path, root: &Path, gib: u64) -> Self {
        let image = root.join("disk.img");
        let mount = root.join("fs");
        std::fs::create_dir_all(&mount).unwrap();
        run(Command::new("truncate")
            .arg(format!("--size={gib}G"))
            .arg(&image));
        run(Command::new("mkfs.xfs").arg("-q").arg(&image));
        run(Command::new("mount")
            .args(["-o", "loop"])
            .arg(&image)
            .arg(&mount));
        run(Command::new("cp")
            .arg("--sparse=always")
            .arg(lab.join("base.ext4"))
            .arg(mount.join("base.ext4")));
        Self { image, mount }
    }

    /// Fills the filesystem until only `leave` bytes are available.
    fn fill(&self, leave: u64) -> PathBuf {
        let stat = rustix::fs::statvfs(&self.mount).unwrap();
        let available = stat.f_bavail * stat.f_frsize;
        let hog = self.mount.join("hog");
        run(Command::new("fallocate")
            .arg(format!("--length={}", available - leave))
            .arg(&hog));
        hog
    }
}

impl Drop for SmallDisk {
    fn drop(&mut self) {
        let _ = Command::new("umount")
            .arg("--lazy")
            .arg(&self.mount)
            .status();
        let _ = std::fs::remove_file(&self.image);
    }
}

fn find(status: &HostStatus, sandbox: Id) -> &SandboxStatus {
    status
        .sandboxes
        .iter()
        .find(|found| found.id == sandbox)
        .unwrap()
}

async fn sleep_to_saved(agent: &Agent, sandbox: Id) {
    let request = Request::Sleep {
        id: sandbox,
        generation: None,
        level: LevelName::Saved,
    };
    assert_eq!(agent.client.call(&request).await.unwrap(), Reply::Done);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_small_disk_books_saves_and_reports_a_save_it_cannot_write() {
    let Some(lab) = lab() else {
        return;
    };
    let host = Host::new(&lab, "disk", &["--disk-reserve-mib", "256"]);
    let disk = SmallDisk::mount(&lab, &host.root, 4);
    let host = host.with_state(disk.mount.join("state"), disk.mount.join("base.ext4"));
    let agent = host.start().await;
    agent
        .wait_until("a disk reading", |status| status.disk.is_some())
        .await;

    // Sandboxes wake until the disk cannot book one more save.
    let mut awake = Vec::new();
    let (refused, message, refusal) = loop {
        let sandbox = id(awake.len());
        agent.create(sandbox, NEVER).await;
        let begin = Instant::now();
        match super::admission::connect(&agent.client, sandbox).await {
            Ok(_) => awake.push(sandbox),
            Err(message) => break (sandbox, message, begin.elapsed()),
        }
        assert!(awake.len() < 8, "never ran out of disk");
    };
    assert!(awake.len() >= 2, "{message}");
    assert!(
        message.contains("disk"),
        "says what it is short of: {message}"
    );
    assert!(
        message.contains(&SAVE.to_string()),
        "and how much: {message}"
    );
    let booked = agent.status().await.disk.unwrap();
    assert_eq!(booked.booked, SAVE * awake.len() as u64);
    assert!(booked.free < SAVE, "{booked:?}");
    eprintln!(
        "{} awake booked {} MiB; the next refused in {refusal:?}: {message}",
        awake.len(),
        booked.booked / MIB
    );

    // Once one VM's state is saved it books nothing, and the refused wake
    // goes through.
    let begin = Instant::now();
    sleep_to_saved(&agent, awake[0]).await;
    agent
        .wait_until("the first saved", |status| {
            find(status, awake[0]).level == LevelName::Saved
        })
        .await;
    let saved = begin.elapsed();
    super::admission::connect(&agent.client, refused)
        .await
        .expect("wakes once a save freed its booking");
    eprintln!("saved the first in {saved:?}; the refused one then woke");

    // A save the disk cannot hold shows in the status and is retried.
    let hog = disk.fill(16 * MIB);
    sleep_to_saved(&agent, awake[1]).await;
    agent
        .wait_until("the failed save to show", |status| {
            find(status, awake[1]).failed_step.is_some()
        })
        .await;
    let status = agent.status().await;
    let failed = find(&status, awake[1]).failed_step.clone().unwrap();
    assert_eq!(failed.step, "save");
    assert!(
        failed.error.contains("No space left"),
        "says why: {}",
        failed.error
    );
    eprintln!("the save failed: {}", failed.error);
    std::fs::remove_file(hog).unwrap();
    agent
        .wait_until("the save to succeed once there is room", |status| {
            let sandbox = find(status, awake[1]);
            sandbox.level == LevelName::Saved && sandbox.failed_step.is_none()
        })
        .await;
    assert!(find(&agent.status().await, awake[1]).memory_saved);

    agent.remove_all().await;
    agent.kill();
    drop(disk);
    host.finish("small-disk");
}
