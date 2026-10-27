//! Work that may fit on disk once the next reading shows what bookings
//! that ended wrote: it waits for that reading, which lets it in or
//! refuses it, and a host registering again refuses it unstarted, since
//! with no lease held no reading comes. The tests give the agent its disk
//! readings one at a time, so each is decided exactly when they say.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{DiskPolicy, DiskSpace, HostPolicy};
use compute_engine::Writes;
use compute_host::fleet::{LeaseGate, boot_now};
use compute_host::protocol::{DiskStatus, Id, ImageId, LevelName, SandboxConfig};
use compute_host::{Directory, DiskGauge, Handle, HostAgent, HostError};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

use super::{Delays, Fake, Lab, NEVER, id};

/// More bytes than anything here books, so only inodes are ever short.
const PLENTY: u64 = 1 << 50;

/// How long work that waits for a reading is watched not to finish:
/// several samples, none of which takes a reading.
const WAITS: Duration = Duration::from_millis(300);

struct Host {
    handle: Handle,
    gauge: DiskGauge,
    /// An image only the store has.
    image: ImageId,
    _root: PathBuf,
}

impl Host {
    async fn start(lease: Option<LeaseGate>) -> Self {
        let root = Lab::root();
        let store = Directory::new(root.join("store"));
        let file = root.join("image.ext4");
        std::fs::write(&file, b"an image").unwrap();
        let image = store.put_rootfs(&file).await.unwrap();
        let policy = HostPolicy {
            disk: Some(DiskPolicy {
                reserve: 0,
                reserve_inodes: 0,
            }),
            ..HostPolicy::default()
        };
        let gauge = DiskGauge::default();
        let mut config = Lab::config(&root, policy);
        config.disk_reading = Some(gauge.clone());
        config.lease = lease;
        let engine = Fake {
            world: Arc::default(),
            delays: Delays::default(),
        };
        let (handle, _agent) = HostAgent::start(config, engine, store).await.unwrap();
        Self {
            handle,
            gauge,
            image,
            _root: root,
        }
    }

    /// Has the agent read `inodes` free, and plenty of bytes, then tells
    /// what its disk book holds.
    async fn read(&self, inodes: u64) -> DiskStatus {
        self.gauge.give(DiskSpace {
            bytes: PLENTY,
            inodes,
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.gauge.taken() {
            assert!(Instant::now() < deadline, "no sample took the reading");
            sleep(Duration::from_millis(5)).await;
        }
        self.disk().await
    }

    async fn disk(&self) -> DiskStatus {
        let status = self.handle.status().await.unwrap();
        status.disk.expect("a disk policy")
    }

    fn create(&self, id: Id, image: Option<ImageId>) -> JoinHandle<Result<(), HostError>> {
        let handle = self.handle.clone();
        let mut config = SandboxConfig::new(1, 128, NEVER);
        if let Some(image) = image {
            config = config.with_image(image);
        }
        tokio::spawn(async move { handle.create(id, config).await })
    }

    /// Creates sandbox `id` with room to spare and measures, in inodes,
    /// what a new sandbox's first files book until a reading shows them,
    /// and what its next save books from its create on, for its first
    /// wake.
    async fn measure(&self, id: Id) -> (u64, u64) {
        self.read(PLENTY).await;
        self.create(id, None).await.unwrap().unwrap();
        let with_first = self.disk().await.inodes_booked;
        let save = self.read(PLENTY).await.inodes_booked;
        let first = with_first - save;
        assert!(first > 2, "first files {first}, save {save}");
        (first, save)
    }
}

/// A create short of inodes by no more than what an earlier create's
/// files booked waits for the next reading: one that shows room lets it
/// in, one that shows none refuses it and frees its id.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_that_may_fit_waits_for_the_reading_that_decides_it() {
    let host = Host::start(None).await;
    let (first, save) = host.measure(id(1)).await;

    // One sandbox more leaves room for half another's first files, until
    // a reading shows what its own wrote.
    host.read(2 * save + first + first / 2).await;
    host.create(id(2), None).await.unwrap().unwrap();
    assert_eq!(host.disk().await.inodes_free, first / 2);
    let waiting = host.create(id(3), None);
    sleep(WAITS).await;
    assert!(!waiting.is_finished(), "it waits for a reading");

    // The reading shows room: it goes on, and leaves the next one waiting
    // in turn.
    host.read(3 * save + first + first / 2).await;
    waiting.await.unwrap().unwrap();
    let refused = host.create(id(4), None);
    sleep(WAITS).await;
    assert!(!refused.is_finished(), "it waits for a reading");

    // This one shows none: it is refused, and its id is free again.
    host.read(3 * save + first / 2).await;
    let refused = refused.await.unwrap();
    assert!(
        matches!(refused, Err(HostError::HostFull { .. })),
        "{refused:?}"
    );
    host.read(PLENTY).await;
    host.create(id(4), None).await.unwrap().unwrap();
}

/// With no lease held no reading comes, so a host registering again
/// refuses the creates and image fetches waiting for one, unstarted,
/// rather than wait for them to settle: the service asks again under the
/// new registration, and they go on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registering_host_refuses_work_waiting_for_a_disk_reading() {
    let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
    let host = Host::start(Some(gate.clone())).await;
    let (first, save) = host.measure(id(1)).await;

    // Two sandboxes more leave room neither for another's first files and
    // first wake nor for the image's fetch, until a reading shows what
    // their first files wrote.
    host.read(3 * save + 2 * first + 1).await;
    host.create(id(2), None).await.unwrap().unwrap();
    host.create(id(5), None).await.unwrap().unwrap();
    let create = host.create(id(3), None);
    let fetch = host.create(id(4), Some(host.image));
    sleep(WAITS).await;
    assert!(!create.is_finished() && !fetch.is_finished());

    gate.set(boot_now());
    let listed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match host.handle.inventory().await.unwrap() {
                Ok(listed) => break listed,
                Err(_) => sleep(Duration::from_millis(5)).await,
            }
        }
    })
    .await
    .expect("the list does not wait for work only a reading could decide");
    let mut held: Vec<Id> = listed.sandboxes.iter().map(|held| held.id).collect();
    held.sort_unstable();
    assert_eq!(held, [id(1), id(2), id(5)]);
    for refused in [create.await.unwrap(), fetch.await.unwrap()] {
        assert!(
            matches!(refused, Err(HostError::NotAdmitted)),
            "{refused:?}"
        );
    }

    // Renewed, the same creates go on.
    gate.set(boot_now() + Duration::from_secs(60));
    host.read(PLENTY).await;
    host.create(id(3), None).await.unwrap().unwrap();
    host.create(id(4), Some(host.image)).await.unwrap().unwrap();
}

/// What the guest of the tests below writes to its disk.
const WRITTEN: u64 = 64 << 20;

/// A lab whose agent takes the disk readings `gauge` gives it, with one
/// awake sandbox whose disk holds [`WRITTEN`] bytes: its disk's path, and
/// what more wakes may book once a reading shows them written.
async fn awake_with_written_disk(gauge: &DiskGauge) -> (Lab, PathBuf, u64) {
    let reading = gauge.clone();
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        move |config| {
            // A base image as long as what the guest writes, so its
            // sandbox's disk is, and books, that length.
            std::fs::File::create(&config.base_image)
                .unwrap()
                .set_len(WRITTEN)
                .unwrap();
            config.policy.disk = Some(DiskPolicy {
                reserve: 0,
                reserve_inodes: 0,
            });
            config.disk_reading = Some(reading);
            // Far enough apart that only the sample taking a reading
            // finds what each test does as it is read.
            config.sample_every = Duration::from_millis(500);
            // Its guest is asked to write its disks out before it pauses.
            config.restore_notice_port = Some(53);
        },
    )
    .await;
    let sandbox = id(1);
    read_free(gauge, &lab, None).await;
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set awake"]).await;
    let disk = lab.sandbox_dir(sandbox).join("root/disk.ext4");
    write_again(&disk);
    let written = read_free(gauge, &lab, None).await;
    (lab, disk, written)
}

/// [`WRITTEN`] bytes no file system compresses or skips as zeros.
fn ones() -> Vec<u8> {
    vec![1_u8; usize::try_from(WRITTEN).unwrap()]
}

/// Frees all [`WRITTEN`] bytes of `disk`, as a guest's trim does.
fn trim(disk: &Path) {
    let file = std::fs::OpenOptions::new().write(true).open(disk).unwrap();
    rustix::fs::fallocate(
        &file,
        rustix::fs::FallocateFlags::PUNCH_HOLE | rustix::fs::FallocateFlags::KEEP_SIZE,
        0,
        WRITTEN,
    )
    .unwrap();
}

/// Writes all [`WRITTEN`] bytes of `disk` again in one call, as a guest's
/// VMM does.
fn write_again(disk: &Path) {
    use std::os::unix::fs::FileExt;

    let file = std::fs::OpenOptions::new().write(true).open(disk).unwrap();
    file.write_all_at(&ones(), 0).unwrap();
    file.sync_all().unwrap();
}

/// Asserts that a reading after `written`, which left `raced` for more
/// wakes, booked the disk's [`WRITTEN`] bytes for its guest again.
fn assert_booked_again(written: u64, raced: u64) {
    assert!(
        written - raced >= WRITTEN - (1 << 20),
        "space the guest may take was left for others: {written} then {raced}"
    );
}

/// Asserts that `read`, a reading taken once the disk holds its
/// [`WRITTEN`] bytes again, leaves as much for more wakes as `written`
/// did, the blocks that map the disk aside. Those are the disk's too, and
/// a filesystem lays them out anew with each write: a fragmented ext4
/// splits the same bytes into more or fewer extents, mapped by more or
/// fewer blocks. The disk's bound allows [`WRITTEN`]/256 for them.
fn assert_taken_again(written: u64, read: u64) {
    assert!(
        read.abs_diff(written) <= WRITTEN / 256,
        "the disk's space was not booked as before: {written} then {read}"
    );
}

/// Space a guest frees while the agent reads the disk, as its trim before
/// a pause may, stays booked for that guest: its disk is read after the
/// reading, which shows the space free, so the space is not left for
/// other sandboxes while the guest may take it back at once. A later
/// reading, showing it taken again, ends that.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_a_guest_frees_while_the_disk_is_read_stays_booked_for_it() {
    let gauge = DiskGauge::default();
    let (lab, disk, written) = awake_with_written_disk(&gauge).await;

    // The guest frees all it wrote as the disk is read, and writes it
    // all again at once.
    let freed = disk.clone();
    let raced = read_free(&gauge, &lab, Some(Box::new(move || trim(&freed)))).await;
    write_again(&disk);
    assert_booked_again(written, raced);

    // Readings of the disk alone keep it booked, until a disk reading
    // shows it taken again. Its map may hold a block less meanwhile, as
    // its filesystem merges the extents of what it writes back, and that
    // block is booked too.
    sleep(Duration::from_millis(1100)).await;
    let status = lab.status().await.disk.unwrap();
    assert!(
        status.free.abs_diff(raced) <= WRITTEN / 256,
        "it stays booked until a reading: {raced} then {}",
        status.free
    );
    assert_taken_again(written, read_free(&gauge, &lab, None).await);
    lab.assert_clean();
}

/// A guest that frees space just before the disk reading and writes it
/// again just after, before the agent reads its disk, leaves the disk
/// holding as much as before while the reading shows the space free. What
/// its VMM wrote meanwhile is counted, so the space stays booked for it
/// all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_a_guest_frees_and_takes_again_as_the_disk_is_read_stays_booked_for_it() {
    let gauge = DiskGauge::default();
    let (lab, disk, written) = awake_with_written_disk(&gauge).await;

    let world = Arc::clone(&lab.world);
    let rewritten = disk.clone();
    let race = move || {
        trim(&rewritten);
        write_again(&rewritten);
        let mut counted = world.written.lock().unwrap();
        *counted = Writes {
            bytes: counted.bytes + WRITTEN,
            calls: counted.calls + 1,
            dirtied: counted.dirtied,
        };
    };
    let raced = read_free(&gauge, &lab, Some(Box::new(race))).await;
    assert_booked_again(written, raced);
    assert_taken_again(written, read_free(&gauge, &lab, None).await);
    lab.assert_clean();
}

/// A guest that frees space just before the disk reading and takes it
/// again with no write call, as discards over part of shared blocks do
/// (the file system copies each such block to a new one), leaves the disk
/// holding as much as before while the reading shows the space free. The
/// pages its VMM dirtied meanwhile are counted, so the space stays booked
/// for it all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_a_guest_takes_again_with_no_write_call_stays_booked_for_it() {
    let gauge = DiskGauge::default();
    let (lab, disk, written) = awake_with_written_disk(&gauge).await;

    let world = Arc::clone(&lab.world);
    let rewritten = disk.clone();
    let race = move || {
        trim(&rewritten);
        write_again(&rewritten);
        world.written.lock().unwrap().dirtied += WRITTEN;
    };
    let raced = read_free(&gauge, &lab, Some(Box::new(race))).await;
    assert_booked_again(written, raced);
    assert_taken_again(written, read_free(&gauge, &lab, None).await);
    lab.assert_clean();
}

/// Space a guest frees as it trims its disk before a pause stays booked
/// for it: the pause holds the VM, so no reading of its disk comes until
/// the pause ends, and the guest may take the space again before it
/// pauses, or once it wakes. A reading of its disk after it woke ends
/// that.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn space_a_guest_trims_as_it_pauses_stays_booked_for_it() {
    let gauge = DiskGauge::default();
    let (lab, disk, written) = awake_with_written_disk(&gauge).await;
    let sandbox = id(1);

    lab.world.syncs_held.store(true, Ordering::SeqCst);
    let asked = lab.world.syncs.load(Ordering::SeqCst);
    let trims = async {
        let deadline = Instant::now() + Duration::from_secs(5);
        while lab.world.syncs.load(Ordering::SeqCst) == asked {
            assert!(
                Instant::now() < deadline,
                "the pause never asked for a sync"
            );
            sleep(Duration::from_millis(5)).await;
        }
        // The guest trims as the disk reading is taken, and writes it all
        // again before it answers.
        let freed = disk.clone();
        let raced = read_free(&gauge, &lab, Some(Box::new(move || trim(&freed)))).await;
        write_again(&disk);
        lab.world.syncs_held.store(false, Ordering::SeqCst);
        raced
    };
    let (_, raced) = tokio::join!(lab.sleep_to(sandbox, LevelName::Paused), trims);
    assert_booked_again(written, raced);

    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.wake(sandbox).await;
    lab.wait_level(sandbox, LevelName::Running).await;
    sleep(Duration::from_millis(1100)).await;
    assert_taken_again(written, read_free(&gauge, &lab, None).await);
    lab.assert_clean();
}

/// A disk that cannot be read as the disk reading is taken, or whose VM's
/// writes do not return in time, books all it may take for that reading:
/// what its guest freed may be taken again, and nothing tells how much
/// it did.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disk_not_read_whole_books_all_it_may_take() {
    let gauge = DiskGauge::default();
    let (lab, disk, written) = awake_with_written_disk(&gauge).await;

    // Freed as the disk reading is taken, and gone when the disk is read.
    let (freed, away) = (disk.clone(), disk.with_extension("away"));
    let hide = move || {
        trim(&freed);
        std::fs::rename(&freed, away).unwrap();
    };
    let raced = read_free(&gauge, &lab, Some(Box::new(hide))).await;
    std::fs::rename(disk.with_extension("away"), &disk).unwrap();
    write_again(&disk);
    assert_booked_again(written, raced);
    assert_taken_again(written, read_free(&gauge, &lab, None).await);

    // Read whole, but by a VM whose writes do not return in time: what it
    // wrote after the disk reading cannot be counted.
    lab.world.unsettled.store(true, Ordering::SeqCst);
    let raced = read_free(&gauge, &lab, None).await;
    lab.world.unsettled.store(false, Ordering::SeqCst);
    assert_booked_again(written, raced);
    assert_taken_again(written, read_free(&gauge, &lab, None).await);
    lab.assert_clean();
}

/// Has the agent of `lab` read plenty free on its disk, just after
/// `change` is made if one is given, and tells what more wakes may book.
async fn read_free(gauge: &DiskGauge, lab: &Lab, change: Option<Box<dyn FnOnce() + Send>>) -> u64 {
    let plenty = DiskSpace {
        bytes: PLENTY,
        inodes: PLENTY,
    };
    match change {
        Some(change) => gauge.give_after(change, plenty),
        None => gauge.give(plenty),
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !gauge.taken() {
        assert!(Instant::now() < deadline, "no sample took the reading");
        sleep(Duration::from_millis(5)).await;
    }
    lab.status().await.disk.expect("a disk policy").free
}
