// Deepest sleep: the sandbox lives only in object storage (no RAM, no local disk).
// Measures what it costs to store and how long a wake takes when the host must
// first fetch the snapshot.
//
//   sudo -E bun exp-blob.ts
//
// Environment:
//   BLOB_KIND=gcs   BLOB_BASE=https://storage.googleapis.com/<bucket>  BLOB_TOKEN=<oauth bearer>
//   BLOB_KIND=azure BLOB_BASE=https://<account>.blob.core.windows.net/<container>  BLOB_SAS=<sas query>
import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { GUEST_DROP_CACHES, LAB, PROBE, Vm, WORKLOAD, ensureCgroupRoot, now, record, sh, sleep } from "./fc";

const kind = process.env.BLOB_KIND;
const base = process.env.BLOB_BASE;
if (!kind || !base) throw new Error("BLOB_KIND and BLOB_BASE are required");
const reps = Number(process.env.REPS ?? 3);
const BLOCK = 4096;

function putCmd(file: string, key: string): string {
  if (kind === "gcs") {
    return `curl -sf -X PUT -T ${file} -H "Authorization: Bearer $BLOB_TOKEN" "${base}/${key}" -o /dev/null`;
  }
  return `curl -sf -X PUT -T ${file} -H "x-ms-blob-type: BlockBlob" "${base}/${key}?$BLOB_SAS" -o /dev/null`;
}

function getUrl(key: string): string {
  return kind === "gcs" ? `${base}/${key}` : `${base}/${key}?$BLOB_SAS`;
}

function getAuth(): string {
  return kind === "gcs" ? `-H "Authorization: Bearer $BLOB_TOKEN"` : "";
}

/** Write the 4 KiB blocks of `file` that differ from `baseFile` as offset-tagged records. */
function diffBlocks(file: string, baseFile: string, out: string): { changedMiB: number } {
  const a = openSync(file, "r");
  const b = openSync(baseFile, "r");
  const o = openSync(out, "w");
  const chunk = 4 * 1024 * 1024;
  const ba = Buffer.alloc(chunk);
  const bb = Buffer.alloc(chunk);
  const header = Buffer.alloc(8);
  let pos = 0;
  let changed = 0;
  const size = statSync(file).size;
  while (pos < size) {
    const n = readSync(a, ba, 0, chunk, pos);
    readSync(b, bb, 0, chunk, pos);
    for (let off = 0; off < n; off += BLOCK) {
      if (ba.compare(bb, off, off + BLOCK, off, off + BLOCK) !== 0) {
        header.writeBigUInt64LE(BigInt(pos + off));
        writeSync(o, header);
        writeSync(o, ba, off, BLOCK);
        changed++;
      }
    }
    pos += n;
  }
  closeSync(a);
  closeSync(b);
  closeSync(o);
  return { changedMiB: Math.round(((changed * BLOCK) / 1024 / 1024) * 10) / 10 };
}

/** Rebuild a disk image from a reflink copy of the base plus the recorded blocks. */
function applyBlocks(diff: string, target: string) {
  const d = openSync(diff, "r");
  const t = openSync(target, "r+");
  const rec = Buffer.alloc(8 + BLOCK);
  let pos = 0;
  for (;;) {
    const n = readSync(d, rec, 0, rec.length, pos);
    if (n < rec.length) break;
    writeSync(t, rec, 8, BLOCK, Number(rec.readBigUInt64LE(0)));
    pos += n;
  }
  closeSync(d);
  closeSync(t);
}

ensureCgroupRoot();
const vm = new Vm("blob");
try {
  await vm.boot();
  await vm.exec(WORKLOAD);
  await vm.exec(PROBE);
  await vm.exec(GUEST_DROP_CACHES);
  await sleep(8000);
  for (let i = 0; i < reps; i++) {
    // Sleep: snapshot, compress memory and disk changes, upload, delete local copies.
    const t0 = now();
    await vm.snapshotAndStop(false);
    const snapMs = now() - t0;
    const dir = vm.dir;
    // Firecracker writes every guest page, including the zero pages the guest
    // already handed back. Punching holes shows what a local snapshot really costs.
    const memBefore = vm.diskUsageMiB("mem.snap");
    const th = now();
    sh(`fallocate --dig-holes ${dir}/mem.snap`);
    const digHolesMs = now() - th;
    const memAfter = vm.diskUsageMiB("mem.snap");
    const t1 = now();
    const { changedMiB } = diffBlocks(`${dir}/rootfs.ext4`, `${LAB}/base.ext4`, `${dir}/disk.diff`);
    const diffMs = now() - t1;
    const t2 = now();
    sh(`cd ${dir} && tar -cf - vm.snap mem.snap disk.diff | zstd -q -1 -T8 -o sandbox.tar.zst -f`);
    const compressMs = now() - t2;
    const packedMiB = Math.round((statSync(`${dir}/sandbox.tar.zst`).size / 1024 / 1024) * 10) / 10;
    const key = `blob-${process.pid}-${i}.tar.zst`;
    const t3 = now();
    sh(putCmd(`${dir}/sandbox.tar.zst`, key));
    const uploadMs = now() - t3;
    sh(`cd ${dir} && rm -f vm.snap mem.snap disk.diff sandbox.tar.zst rootfs.ext4`);
    sh(`sync && echo 3 > /proc/sys/vm/drop_caches`);

    // Wake: stream download and decompress, rebuild disk, restore, run the first command.
    const w0 = now();
    sh(`cd ${dir} && curl -sf ${getAuth()} "${getUrl(key)}" | zstd -q -d -T4 | tar -xf -`);
    const fetchMs = now() - w0;
    const w1 = now();
    sh(`cp --reflink=always ${LAB}/base.ext4 ${dir}/rootfs.ext4`);
    applyBlocks(`${dir}/disk.diff`, `${dir}/rootfs.ext4`);
    const rebuildMs = now() - w1;
    const w2 = now();
    const { loadMs } = await vm.restore();
    const r = await vm.exec(PROBE);
    if (!r.out.includes("function")) throw new Error(`probe failed: ${r.out}`);
    const restoreAndCommandMs = now() - w2;
    record("blob", {
      kind,
      rep: i,
      sleep: {
        snapMs: Math.round(snapMs),
        digHolesMs: Math.round(digHolesMs),
        diffMs: Math.round(diffMs),
        compressMs: Math.round(compressMs),
        uploadMs: Math.round(uploadMs),
      },
      stored: {
        memFileApparentMiB: memBefore.apparentMiB,
        memFileAllocatedMiB: memBefore.allocatedMiB,
        memFileAfterDigHolesMiB: memAfter.allocatedMiB,
        diskChangedMiB: changedMiB,
        packedMiB,
      },
      wake: {
        fetchAndUnpackMs: Math.round(fetchMs),
        rebuildDiskMs: Math.round(rebuildMs),
        loadMs: Math.round(loadMs),
        restoreAndCommandMs: Math.round(restoreAndCommandMs),
        totalMs: Math.round(now() - w0),
      },
    });
  }
} finally {
  await vm.destroy();
}
