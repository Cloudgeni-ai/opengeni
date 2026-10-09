import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanedHostArchiveTemporaryDirectories } from "../src/sandbox/host-archive-temporary";

const SPOOL_MODULE = join(import.meta.dir, "../src/sandbox/host-archive-spool.ts");
const TEMPORARY_MODULE = join(import.meta.dir, "../src/sandbox/host-archive-temporary.ts");
const DOWNLOAD_MODULE = join(import.meta.dir, "../../storage/src/workspace-archive-spool.ts");
const fixtures: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "host-archive-temporary-test-"));
  fixtures.push(base);
  const temporary = join(base, "tmp");
  const workspace = join(base, "workspace");
  await mkdir(temporary);
  await mkdir(workspace);
  await writeFile(join(workspace, "large.bin"), Buffer.alloc(512 * 1024, 7));
  await writeFile(join(workspace, "notes.txt"), "workspace bytes");
  return { temporary, workspace };
}

/** A worker stand-in: capture a workspace spool exactly as the reaper drain and
 * warm checkpoint paths do, report it, then hold it as if its object-storage
 * upload were still in flight, or exit normally when asked. */
function captureInChild(
  temporary: string,
  workspace: string,
  after: "hold" | "exit",
): Promise<{ child: ReturnType<typeof spawn>; spoolPath: string }> {
  const script = `
    const { captureHostWorkspaceArchive } = await import(${JSON.stringify(SPOOL_MODULE)});
    const { spool } = await captureHostWorkspaceArchive(${JSON.stringify(workspace)}, []);
    console.log("SPOOL " + spool.path);
    if (${JSON.stringify(after)} === "exit") process.exit(0);
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, TMPDIR: temporary },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const match = /SPOOL (\S+)/.exec(output);
      if (match) resolve({ child, spoolPath: match[1]! });
    });
    child.once("exit", (code) => {
      if (!/SPOOL /.test(output)) reject(new Error(`capture child exited ${code}: ${output}`));
    });
  });
}

/** An API/worker stand-in restoring a workspace: the object-storage download
 * spool has written its first range when the process is killed. */
function downloadInChild(temporary: string): Promise<ReturnType<typeof spawn>> {
  const script = `
    const { downloadWorkspaceArchiveSpool } = await import(${JSON.stringify(DOWNLOAD_MODULE)});
    const { workspaceArchiveDownloadTemporaryDirectory } = await import(${JSON.stringify(TEMPORARY_MODULE)});
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1).fill(9);
    let ranges = 0;
    const storage = {
      headObject: async () => ({ ContentLength: bytes.length, VersionToken: "v1" }),
      getObjectRange: async (input) => {
        if (ranges++ > 0) {
          console.log("DOWNLOADING");
          await new Promise(() => {});
        }
        return { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v1" };
      },
    };
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await downloadWorkspaceArchiveSpool(storage, "archives/key.tar", { bytes: bytes.length, sha256 }, {
      temporaryDirectory: workspaceArchiveDownloadTemporaryDirectory,
    });
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, TMPDIR: temporary },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("DOWNLOADING")) resolve(child);
    });
    child.once("exit", (code) => {
      if (!output.includes("DOWNLOADING"))
        reject(new Error(`download child exited ${code}: ${output}`));
    });
  });
}

function exited(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

async function entries(directory: string) {
  return (await readdir(directory)).sort();
}

async function pidNamespace() {
  return /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))![1]!;
}

describe.skipIf(process.platform !== "linux")("host archive spool ownership", () => {
  test("a worker killed with a live spool leaves it only until the next process sweeps it", async () => {
    const { temporary, workspace } = await fixture();
    const { child, spoolPath } = await captureInChild(temporary, workspace, "hold");
    const directory = join(spoolPath, "..");
    expect(directory.startsWith(join(temporary, "opengeni-host-archive-o"))).toBe(true);
    expect(await entries(directory)).toEqual(["archive.json"]);

    // While the owner is alive, a peer sharing this TMPDIR must not touch it.
    expect(await sweepOrphanedHostArchiveTemporaryDirectories([temporary])).toEqual([]);
    expect(await entries(directory)).toEqual(["archive.json"]);

    // The stack stops mid-upload: no dispose() or finally block runs.
    child.kill("SIGKILL");
    await exited(child);
    expect(await entries(temporary)).toEqual([directory.slice(temporary.length + 1)]);

    expect(await sweepOrphanedHostArchiveTemporaryDirectories([temporary])).toEqual([directory]);
    expect(await entries(temporary)).toEqual([]);
  });

  test("a worker that exits normally removes its live spool", async () => {
    const { temporary, workspace } = await fixture();
    const { child } = await captureInChild(temporary, workspace, "exit");
    await exited(child);
    expect(child.exitCode).toBe(0);
    expect(await entries(temporary)).toEqual([]);
  });

  test("the next capture reclaims a dead owner's spool before creating its own", async () => {
    const { temporary, workspace } = await fixture();
    const first = await captureInChild(temporary, workspace, "hold");
    first.child.kill("SIGKILL");
    await exited(first.child);
    const leaked = join(first.spoolPath, "..");

    const second = await captureInChild(temporary, workspace, "hold");
    expect(await entries(temporary)).toEqual([
      join(second.spoolPath, "..").slice(temporary.length + 1),
    ]);
    expect((await stat(leaked).catch(() => null)) === null).toBe(true);
  });

  test("a process killed mid-download leaves its download spool only until the next sweep", async () => {
    const { temporary } = await fixture();
    const child = await downloadInChild(temporary);
    const [name] = await entries(temporary);
    expect(name).toMatch(/^opengeni-workspace-archive-o\d+\.\d+\.\d+-[A-Za-z0-9]{6}$/);
    expect(await entries(join(temporary, name!))).toEqual(["archive.tar"]);
    expect(await sweepOrphanedHostArchiveTemporaryDirectories([temporary])).toEqual([]);

    child.kill("SIGKILL");
    await exited(child);
    expect(await entries(temporary)).toEqual([name]);
    expect(await sweepOrphanedHostArchiveTemporaryDirectories([temporary])).toEqual([
      join(temporary, name!),
    ]);
    expect(await entries(temporary)).toEqual([]);
  });

  test("only provably dead owners in this PID namespace are swept", async () => {
    const { temporary } = await fixture();
    const namespace = await pidNamespace();
    const name = (ns: string, pid: number, start: string, suffix: string) =>
      `opengeni-host-archive-o${ns}.${pid}.${start}-${suffix}`;
    // This process with a different start time is a reused PID: owner gone.
    const reused = name(namespace, process.pid, "1", "aaaaaa");
    // Another PID namespace's PIDs are not comparable: never swept, even if absent here.
    const otherNamespace = name(String(Number(namespace) + 1), 999_999_999, "1", "bbbbbb");
    const legacy = "opengeni-host-archive-cccccc";
    const unrelated = "something-else";
    // The download spool shares the ownership rule; its legacy names stay too.
    const reusedDownload = `opengeni-workspace-archive-o${namespace}.${process.pid}.1-eeeeee`;
    const legacyDownload = "opengeni-workspace-archive-ffffff";
    for (const directory of [
      reused,
      otherNamespace,
      legacy,
      unrelated,
      reusedDownload,
      legacyDownload,
    ]) {
      await mkdir(join(temporary, directory));
      await writeFile(join(temporary, directory, "archive.json"), "{}");
    }
    // A symlink with an owner-marked name is never followed or removed.
    const target = join(temporary, "..", "symlink-target");
    await mkdir(target);
    await writeFile(join(target, "keep"), "keep");
    const linked = name(namespace, 999_999_999, "1", "dddddd");
    await symlink(target, join(temporary, linked));

    expect((await sweepOrphanedHostArchiveTemporaryDirectories([temporary])).sort()).toEqual(
      [join(temporary, reused), join(temporary, reusedDownload)].sort(),
    );
    expect(await entries(temporary)).toEqual(
      [legacy, otherNamespace, linked, unrelated, legacyDownload].sort(),
    );
    expect(await entries(target)).toEqual(["keep"]);
  });
});
