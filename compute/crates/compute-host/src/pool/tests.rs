//! Tests of the template pool.

use super::*;

fn shape(vcpus: u8, memory_mib: u32) -> Shape {
    Shape { vcpus, memory_mib }
}

fn template(shape: Shape) -> Template {
    Template {
        dir: PathBuf::from("/nowhere"),
        inputs: Inputs {
            format: FORMAT,
            shape,
            files: Vec::new(),
            boot_args: String::new(),
            networked: false,
            memory: String::new(),
            ready_port: 52,
        },
    }
}

#[test]
fn kept_shapes_parse_with_an_optional_ready_count() {
    let keep: Keep = "1x512:16".parse().unwrap();
    assert_eq!((keep.shape, keep.ready), (shape(1, 512), 16));
    assert_eq!("2x1024".parse::<Keep>().unwrap().ready, 0);
    for bad in ["1x512:", "1x512:-1", "1x512:a", "1x64:2"] {
        assert!(bad.parse::<Keep>().is_err(), "{bad}");
    }
}

/// A build books its copies of the base image and the kernel as well as
/// its snapshot, so inputs larger than guest memory are booked at the size
/// of their data; holes cost nothing.
#[test]
fn a_build_books_its_copies_of_the_base_image_and_kernel_and_its_snapshot() {
    const MIB: u64 = 1 << 20;
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("base.img");
    let file = fs::File::create(&image).unwrap();
    // 8 MiB written, then a 64 MiB hole.
    std::io::Write::write_all(&mut &file, &vec![7; 8 << 20]).unwrap();
    file.set_len(72 * MIB).unwrap();
    file.sync_all().unwrap();
    let kernel = dir.path().join("vmlinux");
    fs::write(&kernel, vec![9; 16 << 20]).unwrap();
    let booked = build_disk(shape(1, 1), &[&image, &kernel], 4096, 2, MIB).unwrap();
    assert!(
        (27 * MIB..36 * MIB).contains(&booked.bytes),
        "8 + 16 MiB copied, 2 x 1 MiB of memory and 1 MiB besides: {booked:?}"
    );
    assert!(booked.inodes > DiskSpace::save(0).inodes, "{booked:?}");
    let missing = dir.path().join("missing");
    assert!(build_disk(shape(1, 1), &[&image, &missing], 4096, 1, 0).is_err());
}

/// On a filesystem that allocates in large clusters, such as ext4 with
/// bigalloc, every data range of a sparse input takes whole clusters.
#[test]
fn sparse_copies_are_booked_in_whole_allocation_units() {
    const MIB: u64 = 1 << 20;
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("base.img");
    let file = fs::File::create(&image).unwrap();
    // Eight 4 KiB data ranges, 4 MiB apart.
    for range in 0..8 {
        std::os::unix::fs::FileExt::write_all_at(&file, &[7; 4096], range * 4 * MIB).unwrap();
    }
    file.set_len(32 * MIB).unwrap();
    file.sync_all().unwrap();
    let snapshot = DiskSpace::save(shape(1, 1).bytes()).bytes;
    let booked = build_disk(shape(1, 1), &[&image], MIB, 1, 0).unwrap();
    assert_eq!(
        booked.bytes - snapshot,
        8 * MIB,
        "one 1 MiB cluster per range"
    );
}

#[test]
fn shapes_parse_and_print_alike() {
    let parsed: Shape = "2x1024".parse().unwrap();
    assert_eq!(parsed, shape(2, 1024));
    assert_eq!(parsed.to_string(), "2x1024");
    for bad in ["2", "x1024", "0x1024", "2x64", "2x1024x1", "ax1024"] {
        assert!(bad.parse::<Shape>().is_err(), "{bad}");
    }
}

/// One build per shape at a time; a failed build waits before the next
/// try; a ready template is handed out until it turns out stale, and
/// only the template found stale is forgotten.
#[test]
fn the_pool_builds_each_shape_once_and_retries_after_a_pause() {
    let start = Instant::now();
    let small = shape(1, 512);
    let mut pool = Pool::new([]);
    assert!(pool.take(small, start).1, "first use builds");
    assert!(!pool.take(small, start).1, "already building");
    assert!(!pool.want(small, start));

    pool.built(small, Err("boom".into()), start);
    assert!(!pool.take(small, start).1, "failed just now");
    let later = start + RETRY_AFTER;
    assert!(pool.take(small, later).1, "tried again later");

    pool.built(small, Ok(template(small)), later);
    let (ready, build) = pool.take(small, later);
    let ready = ready.unwrap();
    assert!(!build);
    assert_eq!(pool.status()[0].state, TemplateState::Ready);

    // A newer template replaces the old one; the old one turning out
    // stale afterwards must not forget the newer.
    pool.built(small, Ok(template(small)), later);
    assert!(!pool.stale(&ready, later));
    assert!(pool.take(small, later).0.is_some());

    let newer = pool.take(small, later).0.unwrap();
    assert!(pool.stale(&newer, later), "stale: rebuild");
    let (none, build) = pool.take(small, later);
    assert!(none.is_none() && !build, "already building");
    assert_eq!(pool.status()[0].state, TemplateState::Building);
}

/// A file rewritten in place with its length and modification time
/// kept is another input; one only touched is not.
#[test]
fn inputs_follow_file_contents() {
    let dir = tempfile::tempdir().unwrap();
    let file = |name: &str, text: &str| {
        let path = dir.path().join(name);
        fs::write(&path, text).unwrap();
        path
    };
    let sources = Sources {
        kernel: file("vmlinux", "kernel"),
        base_image: file("base.img", "base one"),
        depends_on: Vec::new(),
        boot_args: String::new(),
        networked: false,
        memory: String::new(),
        ready_port: 52,
        hashes: Mutex::default(),
    };
    let small = shape(1, 512);
    let before = sources.inputs(small).unwrap();
    assert_eq!(sources.inputs(small).unwrap(), before);

    let modified = fs::metadata(&sources.base_image)
        .unwrap()
        .modified()
        .unwrap();
    fs::write(&sources.base_image, "base two").unwrap();
    fs::File::options()
        .write(true)
        .open(&sources.base_image)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let rewritten = sources.inputs(small).unwrap();
    assert_ne!(
        rewritten.key(),
        before.key(),
        "same length and mtime, new content"
    );

    fs::write(&sources.base_image, "base one").unwrap();
    assert_eq!(
        sources.inputs(small).unwrap(),
        before,
        "the same content again"
    );
}

#[test]
fn inputs_name_every_change() {
    let base = template(shape(1, 512)).inputs;
    let mut other = base.clone();
    other.boot_args = "quiet".into();
    assert_ne!(base.key(), other.key());
    let mut other = base.clone();
    other.ready_port = 53;
    assert_ne!(base.key(), other.key(), "another readiness contract");
    assert_eq!(base.key(), base.clone().key());
    assert!(base.dir_name().starts_with("1x512-"));
    assert!(base.vm_name().len() <= 64);
}

/// A retired template leaves its name before its removal runs, so a
/// build of the same inputs published meanwhile survives the removal;
/// what an agent that stopped first left behind is removed at start.
#[tokio::test]
async fn retiring_never_removes_a_template_published_after_it() {
    let root = tempfile::tempdir().unwrap();
    let mut retired = template(shape(1, 512));
    retired.dir = root.path().join(retired.inputs.dir_name());
    fs::create_dir_all(&retired.dir).unwrap();
    fs::write(retired.dir.join("old"), "old").unwrap();
    let removal = remove(&retired);
    fs::create_dir_all(&retired.dir).unwrap();
    fs::write(retired.dir.join("new"), "new").unwrap();
    removal.await;
    assert!(retired.dir.join("new").exists(), "the new template stays");
    let names: Vec<_> = fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, [retired.dir.file_name().unwrap()]);

    let left = remove(&retired);
    drop(left);
    let names: Vec<_> = fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        names.len() == 1 && names[0].ends_with(BUILDING),
        "an interrupted removal leaves an unfinished name: {names:?}"
    );
}
