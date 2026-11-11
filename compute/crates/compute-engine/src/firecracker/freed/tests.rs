use super::*;

const PAGE: u64 = 4096;

fn file() -> Mapped {
    Mapped {
        major: 7,
        minor: 1,
        inode: 807_645_260,
    }
}

/// Entries from a map of address to entry; pages not named are absent.
fn entries(present: &[u64]) -> impl FnMut(u64, usize) -> io::Result<Vec<u64>> + '_ {
    move |start, count| {
        Ok((0..count as u64)
            .map(|index| {
                if present.contains(&(start + index * PAGE)) {
                    PRESENT
                } else {
                    0
                }
            })
            .collect())
    }
}

#[test]
fn a_discard_between_parts_of_a_region_reads_as_zeros_where_nothing_was_written() {
    // Region at file offset 3 GiB mapped below the one at 0, as
    // Firecracker places them; a discard of four pages in the first,
    // one of them written since, and one of two pages in the second.
    let maps = "\
7f0000000000-7f0000004000 rw-p c0000000 07:01 807645260                  /vm.mem
7f0000004000-7f0000008000 rw-p 00000000 00:00 0 
7f0000008000-7f0000010000 rw-p c0008000 07:01 807645260                  /vm.mem
7f0000010000-7f0000011000 rw-p 00000000 00:00 0 
7f1000000000-7f1000002000 rw-p 00000000 07:01 807645260                  /vm.mem
7f1000002000-7f1000004000 rw-p 00000000 00:00 0 
7f1000004000-7f1000005000 rw-p 00004000 07:01 807645260                  /vm.mem
7f2000000000-7f2000100000 rw-p 00000000 00:00 0                          [heap]
";
    let written = [0x7f00_0000_5000];
    let zeros = zeroed(maps, &file(), PAGE, entries(&written)).unwrap();
    assert_eq!(
        zeros,
        vec![
            0x2000..0x4000,
            0xc000_4000..0xc000_5000,
            0xc000_6000..0xc000_8000,
        ],
        "only discarded pages nothing wrote since, at their file offsets; \
         the anonymous memory after the last part is not the file's"
    );
}

#[test]
fn swapped_pages_and_other_files_are_never_zeros() {
    let maps = "\
7f0000000000-7f0000001000 rw-p 00000000 07:01 807645260                  /vm.mem
7f0000001000-7f0000003000 rw-p 00000000 00:00 0 
7f0000003000-7f0000004000 rw-p 00003000 07:01 807645260                  /vm.mem
7f0000004000-7f0000005000 rw-p 00000000 07:01 99                         /other
7f0000005000-7f0000006000 rw-p 00000000 00:00 0 
7f0000006000-7f0000007000 rw-p 00000000 07:01 99                         /other
";
    let swapped = |start: u64, count: usize| -> io::Result<Vec<u64>> {
        Ok((0..count as u64)
            .map(|index| {
                if start + index * PAGE == 0x7f00_0000_1000 {
                    SWAPPED
                } else {
                    0
                }
            })
            .collect())
    };
    let zeros = zeroed(maps, &file(), PAGE, swapped).unwrap();
    assert_eq!(zeros, vec![0x2000..0x3000]);
}

#[test]
fn memory_not_mapped_from_the_file_has_no_zeros() {
    let maps = "\
7f8e95c00000-7f9295c00000 rw-p 00000000 00:00 0 
";
    let zeros = zeroed(maps, &file(), PAGE, entries(&[])).unwrap();
    assert_eq!(zeros, Vec::<Range<u64>>::new());
}

/// On this kernel: a private mapping of a file with a range discarded
/// the way Firecracker discards one, part of it written since. Only the
/// discarded pages nothing wrote read as zeros, and they are named.
#[test]
fn a_discarded_range_of_a_mapped_file_is_found_in_this_process() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory");
    let page = rustix::param::page_size();
    let pages = 16;
    std::fs::write(&path, vec![0xa5_u8; page * pages]).unwrap();
    let file = File::open(&path).unwrap();
    // SAFETY: a fresh private mapping of a file this test owns.
    let base = unsafe {
        rustix::mm::mmap(
            std::ptr::null_mut(),
            page * pages,
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::PRIVATE,
            &file,
            0,
        )
    }
    .unwrap()
    .cast::<u8>();
    // SAFETY: pages 4 to 8 lie inside the mapping made above, which
    // MAP_FIXED replaces with zeros, as Firecracker's discard does.
    unsafe {
        rustix::mm::mmap_anonymous(
            base.add(page * 4).cast(),
            page * 4,
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::PRIVATE
                | rustix::mm::MapFlags::FIXED
                | rustix::mm::MapFlags::NORESERVE,
        )
        .unwrap();
        // The guest takes page 5 again and writes it; page 6 is read.
        base.add(page * 5).write_volatile(1);
        let _ = base.add(page * 6).read_volatile();
    }
    let found = freed(|name| File::open(format!("/proc/self/{name}")), &path).unwrap();
    // A read may map the shared zero page, which counts as present: it
    // is left out, never wrongly named.
    let length = page * pages;
    let page = page as u64;
    assert!(
        found == vec![page * 4..page * 5, page * 6..page * 8]
            || found == vec![page * 4..page * 5, page * 7..page * 8],
        "{found:?}"
    );
    // SAFETY: the mapping made above, no longer used.
    unsafe { rustix::mm::munmap(base.cast(), length).unwrap() };
}

/// Two regions as a pager-served VMM holds them: anonymous memory, the
/// kernel's view split where the guest's discards and huge pages fell.
fn served() -> Vec<Region> {
    vec![
        Region {
            address: 0x7f00_0000_0000,
            size: 0x8000,
            offset: 0,
        },
        Region {
            address: 0x7f00_0001_0000,
            size: 0x4000,
            offset: 0xc000_0000,
        },
    ]
}

#[test]
fn every_absent_page_of_unbacked_regions_reads_as_zeros_at_its_image_offset() {
    let maps = "\
7f0000000000-7f0000003000 rw-p 00000000 00:00 0 
7f0000003000-7f0000008000 rw-p 00000000 00:00 0 
7f0000010000-7f0000014000 rw-p 00000000 00:0f 4021                       /anon_hugepage (deleted)
7f2000000000-7f2000100000 rw-p 00000000 00:00 0                          [heap]
";
    let present = [0x7f00_0000_0000, 0x7f00_0000_5000, 0x7f00_0001_1000];
    let zeros = unbacked(maps, &served(), PAGE, entries(&present)).unwrap();
    assert_eq!(
        zeros,
        vec![
            0x1000..0x5000,
            0x6000..0x8000,
            0xc000_0000..0xc000_1000,
            0xc000_2000..0xc000_4000,
        ],
        "absent pages at their image offsets, across the kernel's split; \
         memory outside the regions is not the guest's"
    );
}

#[test]
fn a_region_not_wholly_unbacked_memory_gives_nothing() {
    // The first region has a page of a file in it, the second is shared:
    // an absent page of either reads from what backs it.
    let maps = "\
7f0000000000-7f0000004000 rw-p 00000000 00:00 0 
7f0000004000-7f0000005000 rw-p 00000000 07:01 99                         /other
7f0000005000-7f0000008000 rw-p 00000000 00:00 0 
7f0000010000-7f0000014000 rw-s 00000000 00:01 7                          /memfd:guest_mem (deleted)
";
    let zeros = unbacked(maps, &served(), PAGE, entries(&[])).unwrap();
    assert_eq!(zeros, Vec::<Range<u64>>::new());
    // Nor does one the kernel maps only part of.
    let maps = "\
7f0000000000-7f0000004000 rw-p 00000000 00:00 0 
7f0000005000-7f0000008000 rw-p 00000000 00:00 0 
7f0000010000-7f0000013000 rw-p 00000000 00:00 0 
";
    let zeros = unbacked(maps, &served(), PAGE, entries(&[])).unwrap();
    assert_eq!(zeros, Vec::<Range<u64>>::new());
}

#[test]
fn a_swapped_page_of_unbacked_memory_is_never_zeros() {
    let maps = "\
7f0000000000-7f0000008000 rw-p 00000000 00:00 0 
";
    let swapped = |_: u64, count: usize| -> io::Result<Vec<u64>> {
        Ok((0..count as u64)
            .map(|index| if index % 2 == 0 { SWAPPED } else { PRESENT })
            .collect())
    };
    let zeros = unbacked(maps, &served()[..1], PAGE, swapped).unwrap();
    assert_eq!(zeros, Vec::<Range<u64>>::new());
}

/// On this kernel: anonymous memory as a pager leaves it, partly written,
/// partly discarded since. Every page nothing holds is named, at the
/// region's image offset.
#[test]
fn absent_pages_of_unbacked_memory_are_found_in_this_process() {
    let page = rustix::param::page_size();
    let pages = 16;
    let length = page * pages;
    // SAFETY: a fresh private anonymous mapping this test owns.
    let base = unsafe {
        rustix::mm::mmap_anonymous(
            std::ptr::null_mut(),
            length,
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::PRIVATE | rustix::mm::MapFlags::NORESERVE,
        )
    }
    .unwrap()
    .cast::<u8>();
    // SAFETY: pages 0 to 8 lie inside the mapping made above; 2 and 3 are
    // then discarded as Firecracker discards anonymous memory.
    unsafe {
        for at in 0..8 {
            base.add(page * at).write_volatile(1);
        }
        rustix::mm::madvise(
            base.add(page * 2).cast(),
            page * 2,
            rustix::mm::Advice::LinuxDontNeed,
        )
        .unwrap();
    }
    let region = Region {
        address: base as u64,
        size: length as u64,
        offset: 1 << 30,
    };
    let found = freed_unbacked(|name| File::open(format!("/proc/self/{name}")), &[region]).unwrap();
    let page = page as u64;
    let at = |index: u64| (1 << 30) + page * index;
    assert_eq!(found, vec![at(2)..at(4), at(8)..at(16)]);
    // SAFETY: the mapping made above, no longer used.
    unsafe { rustix::mm::munmap(base.cast(), length).unwrap() };
}
