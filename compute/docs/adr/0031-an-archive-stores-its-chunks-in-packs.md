# 31. An archive stores its chunks in packs

Status: Accepted, 2026-11-04; amended 2026-11-05 to drop the forced
migration of chunk objects into packs. Amends
[7](0007-never-delete-the-only-good-copy.md) (how a stored copy is proven),
[25](0025-pointers-in-the-control-service-and-objects-by-day.md) (what a
name is), [28](0028-stored-objects-carry-their-hour.md) (what an archive
carries) and [29](0029-a-sweep-lists-each-period-once.md) (what a sweep
lists).

## Context

Every 256 KiB chunk is its own object, about 68 KB once compressed. One
archive stores about 5,000 objects. A fleet of three storage nodes came to
hold 3.84 million objects (260 GiB) and 4.8 million blocks, and a day's
garbage was 1.5 million objects. Each node keeps 6 to 7.5 million object
rows counting tombstones, with millions of Merkle updates, block checks
and GC entries queued. It drains tens a second without being short of CPU
or disk. So a small write takes 0.7 to 7 s, a delete 0.1 to 1.2 s, and the
store falls further behind. On a cloud store the count is the bill: about
31,000 PUTs an hour is about $110 a month at GCS class A rates.

The cost is per object, not per byte. Fewer, larger objects fix it.

## Decision

- **An archive writes each file's new chunks as a stream of packs.** The
  chunks it stores for the disk, state and memory files, compressed as now
  and in file order, go end to end into packs. A pack is closed once it
  holds 16 MiB, so it is 16 MiB plus at most one chunk; a file's last pack
  may be smaller. Chunks of different files never share a pack. A pack is
  one PUT, never multipart, sent with its checksums as a chunk is now. The
  profile and working-set parts stay objects of their own: they are 1 to
  8 MiB each already, about 20 an archive.
- **A pack is named by its period and its content**:
  `packs/v1/<period>/<blake3 of its bytes>`. Its period is the hour it was
  written, as for every name (ADR 28). Nothing writes a name with other
  bytes, so a PUT tried again, or held up, writes the same object.
- **A chunk reference says where its chunk is.** `ChunkRef` gets
  `pack: { digest, offset, len }`: the pack's digest, the chunk's offset in
  it, and the pack's length. `day` is the pack's period, and `checksums`
  are the pack's, not the chunk's. A reference without `pack` names a
  chunk object, as every reference written before does. Manifests keep
  their extents as they are.
- **Chunks are read with range reads**, and chunks that follow one another
  in a pack with one. A fetch of a file reads each run of consecutive
  chunks, up to 4 MiB, with one ranged GET. A wake's demand fetch and its
  readahead (four chunks after a fault, as now) are one ranged GET when
  they are consecutive in a pack. Demand order is kept, and every chunk is
  still checked against its own stored hash and hash. When a run's read
  fails its checks, each chunk is read on its own, which finds the bad
  one.
- **A pack is proven with one metadata request**: its length, and its MD5
  (S3's entity tag of a single PUT) or CRC32C (GCS). That proves every
  chunk in it. A copy is verified, and its local files evicted (ADR 7),
  with one request per pack it names, not per chunk.
- **Reuse is unchanged**: an archive names what its earlier copy holds at
  the same offset, and what the image its disk was made from holds,
  wherever that is stored. Within one archive the same bytes are packed
  once. An archive tried again packs the same bytes into the same packs,
  so it finds them by digest: stored this hour, it checks each with one
  metadata request; stored in an earlier hour, it carries each with one
  copy (ADR 28). ADR 28's held chunks become held packs.
- **An archive does not keep a pack alive for a few chunks.** When the
  chunks a new copy would reuse from a pack add up to less than half that
  pack's length, the archive stores them again from the local bytes, after
  its new chunks, instead of naming the old pack. When the local bytes are
  gone or have changed, it names the old pack. A pack the image its disk
  was made from names is exempt: the image keeps it anyway.
- **The sweep deletes a pack as it deletes a chunk**: once no pointer
  names a chunk in it, and its period ended `CLOCK_SKEW` before the sweep
  began (ADR 28). A sweep lists `packs/` by period alongside chunks and
  manifests (ADR 29), and a pack is one name however many chunks of it a
  copy names. A sweep never repacks.
- **The hour carries over unchanged.** An archive in flight carries each
  pack it stored and has not published into each new hour with a
  server-side copy, checked by one metadata request (ADR 28), and
  publishes references under the newest name. The fence is unchanged.
- **Copies get format 5**, whose references may name packs. A host reads
  3, 4 and 5, and states in its capacity that it reads packs. A host in a
  fleet sends a header with its pointer reads and writes saying it reads
  packs, and the control service answers such a request with whether
  every host not given up on reads them, asked again every 30 seconds. A
  host writes 5 only while that answer is yes. The answer goes only to a
  host that sent the header, since an earlier release refuses fields it
  does not know. A host on its own writes 5 at once.
- **Control goes first.** The control service, whose sweep reads format 5,
  rolls out before any host that writes it. A sweep that finds a copy in a
  format it does not know refuses the run and deletes nothing, so a sweep
  of an earlier release never deletes a pack a copy names.
- **What was stored before stays readable and sweepable.** A reference
  without `pack` reads its chunk object as now, and a sweep lists and
  deletes `chunks/` and `manifests/` as now.
- **A chunk object is a pack of one chunk.** A copy that names it names
  all of it, so under the half rule it is reused where it is, never
  stored again. New and changed chunks go into packs. The old objects
  leave only as a sandbox's data changes and the sweep takes the ones no
  copy names any more.

  This replaces a forced migration, which stored a chunk object again in
  packs from the local bytes at a sandbox's next archive. That freed the
  old objects within about two hours only on a store that frees bytes
  when an object is deleted. Garage does not: it frees a block only when
  each node's resync worker deletes it, later. On the three-node store
  above (replication 3), block deletes ran at 0.1 to 1 a second on a node
  bound by its drive, 6 to 14 on another, and 0 on a third whose worker
  was busy fetching blocks it lacked. Meanwhile about 25 new blocks a
  second arrived at peak, 5 to 6 GB an hour per node. Each node already
  held 90 to 176 GB of garbage not yet freed, and had 23 to 86 GB free.
  Storing every sandbox again would add about the live bytes (225 GiB)
  on every node before any old block was freed. At 1 MiB blocks that is
  about 230,000 block deletes per node: about 4.5 hours at 14 a second,
  64 hours at 1 a second, and 27 days at 0.1 a second. It would fill
  every disk first.

## Why it is safe

Only the unit of storage changes. Every name is still written in its
writer's current hour, never written with other bytes, and deleted only
once no pointer after the fence names it and its hour ended `CLOCK_SKEW`
before the sweep began. ADR 25, 28 and 29's argument holds with "pack" for
"chunk": a pointer names a pack exactly when it names a chunk in it.

- A pack is written whole or not at all: a single PUT is atomic on every
  store this runs on. A crash mid-archive leaves packs no pointer names,
  which the sweep takes. A manifest is written after every pack it names
  is stored and checked, and the pointer last, as now.
- A pack is deleted only when no chunk in it is named, so no named chunk
  goes with a pack. Storing a chunk again adds a name. The old copy keeps
  the old pack until the new pointer replaces it.
- A bad pack fails its check, so the copy is not evicted. The re-archive
  stores again, from the local copy, every chunk the copy names in it, as
  it does for a bad chunk now.
- Every chunk read is still checked against its hashes, so a range read
  that returns other bytes is caught.
- An earlier release never deletes a pack. Its sweep refuses a format 5
  copy, so it stops before deleting anything; a test checks this with a
  format newer than the sweep knows. A host of an earlier release refuses
  a format 5 copy instead of misreading it.

## Consequences

- **Objects.** A typical archive stores about 340 MB of new chunks: about
  21 packs, 3 manifests and its profile and working-set parts, where it
  was about 5,000 objects. A day of the workload above writes about 3,600
  packs and manifests (about 150 an hour) instead of about 744,000, and
  leaves about 7,500 objects of garbage, not 1.5 million. The store above
  would hold about 20,000 packs plus its manifests instead of 3.84 million
  objects. PUTs at GCS class A rates drop from about $110 to under $1 a
  month. Listing, deleting, verifying and carrying fall the same way,
  about 200 times.
- **Blocks.** On Garage, the block count follows bytes, not objects:
  about 270,000 at its default 1 MiB block size, against 4.8 million now.
- **Reads.** A wake's readahead of four chunks is one GET where it was
  four, and a fetch of a file reads up to 4 MiB a request. Each GET costs
  the store a metadata lookup, so reads fall about as writes do.
- **The same new bytes in two archives are stored twice.** Today two
  archives writing the same new bytes in the same hour share one object.
  With packs they do not: there is no index from a hash to a pack, and
  keeping one would be a second thing to keep right. What a copy reuses
  of its earlier copy and its image, where most sharing is, is
  unaffected.
- **Partly live packs waste a bounded amount.** Each pack a sandbox's copy
  names, other than its image's, is at least half named by it, so those
  packs hold at most twice what the copy names. Storing chunks again costs
  at most what was replaced, since a pack falls below half only once more
  than half of it was replaced. Packs an image names are kept by the
  image, as its chunks are now.
- **The change needs no extra space.** An archive after it stores only
  what changed, as before, now in packs. Nothing is stored twice to move
  it, so the store grows no faster than it did.
- **The old objects go slowly, as data changes.** The store above holds
  about 3.8 million of them. Each goes once no copy names it any more,
  when the chunk it holds is replaced, the way garbage went before. A
  sandbox whose data rarely changes keeps its chunk objects for as long
  as it lives, and reading those still costs a GET per chunk. Object
  counts fall to the figures above only as old sandboxes change or end.
- **Range reads on Garage read whole blocks.** A 68 KB range reads the one
  or two 1 MiB blocks around it from disk. A wake reads a pack's chunks
  in order, so a node's page cache serves most of that, but a cold read
  costs more disk than now. GCS and S3 charge a range read as a GET, as
  now.
- **An archive holds packs in memory while it uploads them**: one filling
  and two uploading per file, so about 48 MiB per file and about 96 MiB
  while the disk and memory files archive together. A failed PUT is sent
  again whole.
- **Rolling hosts back after packs were written** leaves format 5 copies
  unreadable on the old hosts until they roll forward again. They are
  refused, never misread or lost. Rolling the control image back only
  stops sweeps. A host of an earlier release that registers is told about
  within 30 seconds, and hosts write format 4 again from then on.
- **Chunk references grow** by about 90 bytes. A dense 64 GiB file's
  manifest still fits within the manifest limit.
