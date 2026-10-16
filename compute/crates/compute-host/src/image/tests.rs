use std::cell::Cell;

use super::*;

thread_local! {
    pub(super) static FAILPOINT: Cell<Option<&'static str>> = const { Cell::new(None) };
}

const PAGE: u64 = 4096;
const PAGE_BYTES: usize = 4096;
/// Small images keep the tests fast; three and a half chunks, so the
/// last chunk is partial.
const LEN: u64 = CHUNK_BYTES * 3 + CHUNK_BYTES / 2;

/// A deterministic pseudo-random sequence (xorshift), so failures replay.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("compute-image-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes a sparse diff: `pages` as (page number, fill byte), the rest holes.
fn write_diff(path: &Path, pages: &[(u64, u8)]) {
    let file = File::create(path).unwrap();
    file.set_len(LEN).unwrap();
    for (page, fill) in pages {
        file.write_all_at(&[*fill; PAGE_BYTES], page * PAGE)
            .unwrap();
    }
    file.sync_all().unwrap();
}

fn write_state(path: &Path, content: &[u8]) {
    fs::write(path, content).unwrap();
}

fn random_pages(rng: &mut Rng) -> Vec<(u64, u8)> {
    let pages = LEN / PAGE;
    let count = rng.below(12);
    (0..count)
        // Zero fills included: zeros a guest wrote must survive the merge.
        .map(|_| (rng.below(pages), u8::try_from(rng.below(4)).unwrap() * 85))
        .collect()
}

fn apply(model: &mut [u8], pages: &[(u64, u8)]) {
    for (page, fill) in pages {
        let at = usize::try_from(page * PAGE).unwrap();
        model[at..at + PAGE_BYTES].fill(*fill);
    }
}

fn content(images: &Images, generation: Generation) -> Vec<u8> {
    fs::read(images.memory(generation)).unwrap()
}

#[test]
fn merged_images_equal_their_base_with_the_diff_laid_over_it() {
    let dir = scratch("merge");
    let images = Images::new(dir.join("images"));
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut model = vec![0_u8; usize::try_from(LEN).unwrap()];
    let mut base = None;
    for round in 0..40 {
        let pages = random_pages(&mut rng);
        let diff = dir.join("diff");
        let state = dir.join("state");
        write_diff(&diff, &pages);
        write_state(&state, format!("state {round}").as_bytes());
        apply(&mut model, &pages);
        let image = match base {
            // The first diff stands on zeros: it is the whole image.
            None => images.publish(Parts::Whole {
                state: &state,
                memory: &diff,
                len: LEN,
            }),
            Some(base) => images.publish(Parts::Diff {
                base,
                state: &state,
                diff: &diff,
            }),
        }
        .unwrap();
        let generation = image.generation();
        assert_eq!(content(&images, generation), model, "round {round}");
        // The incrementally maintained chunk map equals a fresh one.
        images.verify(generation, Depth::Deep).unwrap();
        assert_eq!(images.current().unwrap(), Some(generation));
        assert!(!diff.exists(), "the diff is consumed");
        images.retire(&image, &[]).unwrap();
        assert_eq!(images.generations().unwrap(), vec![generation]);
        base = Some(generation);
    }
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_diff_of_the_wrong_length_is_refused() {
    let dir = scratch("length");
    let images = Images::new(dir.join("images"));
    let (diff, state) = (dir.join("diff"), dir.join("state"));
    write_diff(&diff, &[(1, 7)]);
    write_state(&state, b"s");
    let base = images
        .publish(Parts::Whole {
            state: &state,
            memory: &diff,
            len: LEN,
        })
        .unwrap();
    File::create(&diff).unwrap().set_len(LEN - PAGE).unwrap();
    write_state(&state, b"t");
    assert!(
        images
            .publish(Parts::Diff {
                base: base.generation(),
                state: &state,
                diff: &diff,
            })
            .is_err()
    );
    assert_eq!(images.current().unwrap(), Some(base.generation()));
    fs::remove_dir_all(&dir).unwrap();
}

/// A VMM decides what it writes into its jail. Memory of another length
/// than the sandbox's, or state far larger than any snapshot's, is refused
/// before anything is read or allocated for it: a sparse file a terabyte
/// long costs nothing to make.
#[test]
fn oversized_snapshot_files_are_refused_before_they_are_read() {
    let dir = scratch("oversized");
    let images = Images::new(dir.join("images"));
    let (memory, state) = (dir.join("memory"), dir.join("state"));
    write_diff(&memory, &[(1, 7)]);
    write_state(&state, b"s");
    let good = images
        .publish(Parts::Whole {
            state: &state,
            memory: &memory,
            len: LEN,
        })
        .unwrap()
        .generation();

    File::create(&memory).unwrap().set_len(1 << 40).unwrap();
    write_state(&state, b"t");
    let started = std::time::Instant::now();
    assert!(
        images
            .publish(Parts::Whole {
                state: &state,
                memory: &memory,
                len: LEN,
            })
            .is_err(),
        "memory longer than the sandbox's was published"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));

    write_diff(&memory, &[(1, 7)]);
    File::create(&state)
        .unwrap()
        .set_len(MAX_STATE_BYTES + 1)
        .unwrap();
    assert!(
        images
            .publish(Parts::Whole {
                state: &state,
                memory: &memory,
                len: LEN,
            })
            .is_err(),
        "state larger than any snapshot's was published"
    );
    assert_eq!(images.current().unwrap(), Some(good));
    images.verify(good, Depth::Deep).unwrap();
    fs::remove_dir_all(&dir).unwrap();
}

/// A stored state file that grew past what the image's description
/// records is damage, found without reading all of it.
#[test]
fn a_state_file_longer_than_recorded_is_damage() {
    let dir = scratch("long-state");
    let images = Images::new(dir.join("images"));
    let (memory, state) = (dir.join("memory"), dir.join("state"));
    write_diff(&memory, &[(1, 7)]);
    write_state(&state, b"s");
    let generation = images
        .publish(Parts::Whole {
            state: &state,
            memory: &memory,
            len: LEN,
        })
        .unwrap()
        .generation();
    let stored = images.state(generation);
    fs::set_permissions(&stored, fs::Permissions::from_mode(0o644)).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&stored)
        .unwrap()
        .set_len(1 << 40)
        .unwrap();
    assert!(matches!(
        images.verify(generation, Depth::Light),
        Err(Suspect::Damaged { .. })
    ));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn recovery_keeps_an_image_it_cannot_read_for_now() {
    if rustix::process::geteuid().is_root() {
        eprintln!("skipped: root reads files whatever their mode");
        return;
    }
    let dir = scratch("unreadable");
    let images = Images::new(dir.join("images"));
    let (memory, state) = (dir.join("memory"), dir.join("state"));
    write_diff(&memory, &[(1, 7)]);
    write_state(&state, b"s");
    let image = images
        .publish(Parts::Whole {
            state: &state,
            memory: &memory,
            len: LEN,
        })
        .unwrap();
    let generation = image.generation();
    let state = images.state(generation);
    fs::set_permissions(&state, fs::Permissions::from_mode(0o000)).unwrap();
    assert!(images.recover().is_err(), "unreadable is no verdict");
    assert_eq!(images.current().unwrap(), Some(generation));
    fs::set_permissions(&state, fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(
        images.recover().unwrap().map(|image| image.generation()),
        Some(generation)
    );
    // A missing part is a verdict: the image goes to quarantine.
    fs::remove_file(&state).unwrap();
    assert!(images.recover().unwrap().is_none());
    assert_eq!(images.current().unwrap(), None);
    fs::remove_dir_all(&dir).unwrap();
}

/// Simulates many save cycles in which the host crashes at any point of
/// publishing or retiring, and in which stored files get corrupted. After
/// every recovery, the current image is either exactly the last
/// committed state or, if that image was damaged, absent and kept in
/// quarantine; a damaged image is never used.
#[test]
fn crashes_and_corruption_never_lose_or_misuse_the_committed_image() {
    const POINTS: [Option<&str>; 5] = [
        None,
        Some("staged"),
        Some("renamed"),
        Some("pointed"),
        Some("retiring"),
    ];
    for seed in 1..=25_u64 {
        let dir = scratch(&format!("crash-{seed}"));
        let images = Images::new(dir.join("images"));
        let mut rng = Rng(seed.wrapping_mul(0x2545_f491_4f6c_dd1d) | 1);
        let mut model = vec![0_u8; usize::try_from(LEN).unwrap()];
        // The content `current` must have, if it exists.
        let mut committed: Option<Vec<u8>> = None;
        for _ in 0..30 {
            let pages = random_pages(&mut rng);
            let (diff, state) = (dir.join("diff"), dir.join("state"));
            write_diff(&diff, &pages);
            write_state(&state, b"state");
            let point = POINTS[usize::try_from(rng.below(POINTS.len() as u64)).unwrap()];
            FAILPOINT.with(|cell| cell.set(point));
            let base = images.current().unwrap();
            let result = match base {
                None => images.publish(Parts::Whole {
                    state: &state,
                    memory: &diff,
                    len: LEN,
                }),
                Some(base) => images.publish(Parts::Diff {
                    base,
                    state: &state,
                    diff: &diff,
                }),
            };
            let mut next = if base.is_some() {
                model.clone()
            } else {
                vec![0; model.len()]
            };
            apply(&mut next, &pages);
            match result {
                Ok(image) => {
                    committed = Some(next.clone());
                    model = next;
                    let _ = images.retire(&image, &[]);
                }
                // Crashed after the pointer moved: committed anyway.
                Err(_) if point == Some("pointed") => {
                    committed = Some(next.clone());
                    model = next;
                }
                Err(_) => {}
            }
            FAILPOINT.with(|cell| cell.set(None));
            // Now and then, damage the current image on disk.
            let mut damaged = false;
            if rng.below(6) == 0
                && let Some(generation) = images.current().unwrap()
            {
                let victim = images.path(generation).join(match rng.below(3) {
                    0 => STATE,
                    1 => CHUNKS,
                    _ => META,
                });
                let mut bytes = fs::read(&victim).unwrap();
                let at = usize::try_from(rng.below(bytes.len() as u64)).unwrap();
                bytes[at] ^= 0x5a;
                fs::set_permissions(&victim, fs::Permissions::from_mode(0o644)).unwrap();
                fs::write(&victim, bytes).unwrap();
                damaged = true;
            }
            let recovered = images.recover().unwrap();
            match (&committed, recovered) {
                (Some(_), None) => {
                    assert!(damaged, "seed {seed}: a good committed image was lost");
                    assert!(
                        fs::read_dir(images.dir().join(QUARANTINE)).unwrap().count() > 0,
                        "seed {seed}: damaged image deleted instead of quarantined"
                    );
                    committed = None;
                    model.fill(0);
                }
                (Some(expected), Some(image)) => {
                    assert!(!damaged, "seed {seed}: a damaged image was trusted");
                    assert_eq!(&content(&images, image.generation()), expected);
                    images.verify(image.generation(), Depth::Deep).unwrap();
                    assert_eq!(images.generations().unwrap(), vec![image.generation()]);
                }
                (None, None) => {}
                (None, Some(_)) => panic!("seed {seed}: an uncommitted image became current"),
            }
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn retiring_needs_a_newer_good_image_and_spares_images_in_use() {
    let all = [Generation(1), Generation(2), Generation(3), Generation(4)];
    assert_eq!(
        retirable(&all, Generation(3), &[Generation(1)]),
        vec![Generation(2)]
    );
    assert_eq!(retirable(&all, Generation(1), &[]), Vec::new());
    // Exhaustively: never the proven image, never anything newer.
    for newest in 1..=4 {
        for mask in 0..16_u32 {
            let in_use: Vec<_> = all
                .iter()
                .copied()
                .filter(|generation| mask & (1 << (generation.0 - 1)) != 0)
                .collect();
            for gone in retirable(&all, Generation(newest), &in_use) {
                assert!(gone.0 < newest && !in_use.contains(&gone));
            }
        }
    }
}

#[test]
fn remote_images_become_local_once_hydrated() {
    let dir = scratch("remote");
    let images = Images::new(dir.join("images"));
    let state = dir.join("state");
    write_state(&state, b"s");
    let mut chunks = ChunkMap::zeros(LEN);
    let fill = vec![9_u8; usize::try_from(CHUNK_BYTES).unwrap()];
    chunks.0[1] = *blake3::hash(&fill).as_bytes();
    let image = images
        .publish(Parts::Remote {
            state: &state,
            memory_len: LEN,
            chunks,
            manifest: b"{}",
            prefilled: None,
        })
        .unwrap();
    assert!(image.meta().remote);
    let generation = image.generation();
    assert!(images.remote(generation).exists());
    {
        let memory = images.memory(generation);
        fs::set_permissions(&memory, fs::Permissions::from_mode(0o644)).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&memory)
            .unwrap()
            .write_all_at(&fill, CHUNK_BYTES)
            .unwrap();
    }
    let local = images.mark_local(&image).unwrap();
    assert!(!local.meta().remote);
    assert!(!images.remote(generation).exists());
    images.verify(generation, Depth::Deep).unwrap();
    fs::remove_dir_all(&dir).unwrap();
}

/// A sandbox started from a template publishes the template's image as
/// its own: the same memory file. A later save of one sandbox merges
/// over it without touching the template or a sibling, and a sibling
/// that never saved keeps a whole image after the template is gone.
#[test]
fn a_shared_image_is_the_same_file_and_survives_its_source() {
    use std::os::unix::fs::MetadataExt;

    let dir = scratch("shared");
    let template = Images::new(dir.join("template"));
    let (memory, state) = (dir.join("memory"), dir.join("state"));
    write_diff(&memory, &[(1, 7), (40, 9)]);
    write_state(&state, b"template state");
    let source = template
        .publish(Parts::Whole {
            state: &state,
            memory: &memory,
            len: std::fs::metadata(&memory).unwrap().len(),
        })
        .unwrap();
    let before = content(&template, source.generation());

    let share = |name: &str| {
        let sandbox = Images::new(dir.join(name));
        let image = sandbox
            .publish(Parts::Shared {
                from: &template,
                image: &source,
            })
            .unwrap();
        (sandbox, image)
    };
    let (modified, image) = share("modified");
    let (untouched, kept) = share("untouched");
    assert_eq!(modified.current().unwrap(), Some(image.generation()));
    modified.verify(image.generation(), Depth::Deep).unwrap();
    let inode = |path: PathBuf| fs::metadata(path).unwrap().ino();
    for (sandbox, image) in [(&modified, &image), (&untouched, &kept)] {
        assert_eq!(
            inode(sandbox.memory(image.generation())),
            inode(template.memory(source.generation())),
            "one file, one page cache"
        );
    }

    let diff = dir.join("diff");
    write_diff(&diff, &[(2, 5)]);
    write_state(&state, b"sandbox state");
    let saved = modified
        .publish(Parts::Diff {
            base: image.generation(),
            state: &state,
            diff: &diff,
        })
        .unwrap();
    modified.retire(&saved, &[]).unwrap();
    assert_eq!(content(&template, source.generation()), before);
    assert_eq!(content(&untouched, kept.generation()), before);
    template.verify(source.generation(), Depth::Deep).unwrap();

    // The template is removed, as when it is rebuilt: the clone that
    // still shares its file loses nothing.
    fs::remove_dir_all(dir.join("template")).unwrap();
    untouched.verify(kept.generation(), Depth::Deep).unwrap();
    assert_eq!(content(&untouched, kept.generation()), before);
    modified.verify(saved.generation(), Depth::Deep).unwrap();
    fs::remove_dir_all(&dir).unwrap();
}
