import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import {
  checkAge,
  expectedFiles,
  nextIndex,
  obsoleteManifests,
  validateIndex,
  validateManifest,
  type BackupConfig,
  type BackupFile,
  type BackupIndex,
  type Manifest,
} from "./config";
import { run, type Command } from "./process";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pause = () => new Promise((resolve) => setTimeout(resolve, 2000));
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const file = await open(`${path}.tmp`, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(`${path}.tmp`, path);
}
async function remove(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
function pg(binary: string, service: string, args: string[]): Command {
  return { binary, args, env: { ...process.env, PGSERVICE: service, PGCONNECT_TIMEOUT: "15" } };
}

export class BackupRunner {
  constructor(readonly config: BackupConfig) {}
  private path(name: string): string {
    return join(this.config.stateDirectory, name);
  }
  private remote(key: string): string {
    return `${this.config.remote}/${key}`;
  }
  private async rc(...args: string[]): Promise<string> {
    return run([{ binary: "rclone", args }], { collect: true });
  }
  private async remoteJson(key: string): Promise<unknown> {
    return JSON.parse(await this.rc("cat", this.remote(key))) as unknown;
  }
  private async publish(key: string, value: unknown): Promise<void> {
    const path = this.path("upload.json");
    await atomicJson(path, value);
    await this.rc("copyto", path, this.remote(key));
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        if (same(await this.remoteJson(key), value)) return;
      } catch (error) {
        if (attempt === 14) throw error;
      }
      await pause();
    }
    throw Error(`Publication not confirmed: ${key}`);
  }
  async index(): Promise<BackupIndex | null> {
    const entries = JSON.parse(await this.rc("lsjson", this.remote(""), "--files-only")) as {
      Path: string;
    }[];
    return entries.some((entry) => entry.Path === "CURRENT.json")
      ? validateIndex(await this.remoteJson("CURRENT.json"), this.config)
      : null;
  }
  private async reconcile(): Promise<BackupIndex | null> {
    const index = await this.index();
    const checkpointRaw = await readJson(this.path("checkpoint.json"));
    const checkpoint = checkpointRaw ? validateIndex(checkpointRaw, this.config) : null;
    const pending = (await readJson(this.path("pending.json"))) as {
      previous: unknown;
      next: unknown;
    } | null;
    if (!index && (checkpoint || pending))
      throw Error("Remote index missing despite local history");
    if (pending) {
      const next = validateIndex(pending.next, this.config);
      const previous = pending.previous ? validateIndex(pending.previous, this.config) : null;
      if (!same(index, next))
        throw Error(
          "Unresolved index publication; retain all runs and investigate before retrying",
        );
      // Preserve GC intent even if publication succeeded just before process death.
      await atomicJson(this.path("cleanup.json"), obsoleteManifests(previous, next));
      await atomicJson(this.path("checkpoint.json"), next);
      await remove(this.path("pending.json"));
    } else if (checkpoint && !same(checkpoint, index)) {
      throw Error("Remote index differs from local checkpoint; refuse a stale overwrite");
    }
    return index;
  }
  async verifyFile(file: BackupFile, localPath?: string): Promise<void> {
    const source = localPath
      ? { binary: "cat", args: [localPath] }
      : { binary: "rclone", args: ["cat", this.remote(file.key)] };
    // One download: hash ciphertext while decrypting/parsing all archive contents.
    // age/pg_restore never execute SQL during verification.
    const hash = createHash("sha256");
    let bytes = 0;
    const hashPipe = new Transform({
      transform(chunk: Buffer, _encoding, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const consumers: Command[] = [
      { binary: "age", args: ["--decrypt", "--identity", this.config.ageIdentityFile] },
    ];
    if (file.key.endsWith(".dump.age"))
      consumers.push({ binary: "pg_restore", args: ["--file=/dev/null"] });
    // Propagate failure in either half to the other, including checksum sources.
    try {
      await Promise.all([
        run([source], { output: hashPipe }).catch((error) => {
          hashPipe.destroy(error as Error);
          throw error;
        }),
        run(consumers, { input: hashPipe }).catch((error) => {
          hashPipe.destroy(error as Error);
          throw error;
        }),
      ]);
    } finally {
      hashPipe.destroy();
    }
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
      throw Error(`Checksum mismatch: ${file.key}`);
  }
  private async verifyUploaded(file: BackupFile): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.verifyFile(file);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await pause();
      }
    }
  }
  async inspect(verify: boolean): Promise<BackupIndex> {
    const index = await this.reconcile();
    if (!index) throw Error("No complete backup exists");
    checkAge(index);
    for (const manifest of new Map([index.nightly, index.weekly].map((m) => [m.run, m])).values()) {
      for (const file of manifest.files) {
        const object = JSON.parse(await this.rc("lsjson", this.remote(file.key), "--stat")) as {
          Size: number;
        };
        if (object.Size !== file.bytes) throw Error(`Missing/truncated backup: ${file.key}`);
        if (verify) await this.verifyFile(file);
      }
    }
    return index;
  }
  private async cleanup(manifests: Manifest[], retained: BackupIndex | null): Promise<void> {
    for (const raw of manifests) {
      const manifest = validateManifest(raw, this.config);
      if ([retained?.nightly.run, retained?.weekly.run].includes(manifest.run))
        throw Error("Cleanup refers to a retained run");
      for (const file of manifest.files) await this.rc("deletefile", this.remote(file.key));
      await this.rc("deletefile", this.remote(`${manifest.run}/COMPLETE.json`));
    }
  }
  async backup(): Promise<BackupIndex> {
    const previous = await this.reconcile();
    const retired = (await readJson(this.path("cleanup.json"))) as Manifest[] | null;
    if (retired) {
      await this.cleanup(retired, previous);
      await remove(this.path("cleanup.json"));
    }
    const started = new Date();
    const id = `runs/${started
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")}-${randomUUID()}`;
    const manifest: Manifest = {
      run: id,
      startedAt: started.toISOString(),
      finishedAt: "",
      files: [],
    };
    const scratch = this.path("current.dump.age");
    const attempted: string[] = [];
    let publishing = false;
    try {
      for (const name of expectedFiles(this.config)) {
        console.log(`Dumping ${name}`);
        const db = this.config.databases.find((d) => `${d.name}.dump.age` === name);
        const command = db
          ? pg("pg_dump", db.service, ["--format=custom", "--compress=6", "--no-owner"])
          : pg("pg_dumpall", this.config.rolesService!, ["--roles-only"]);
        await run(
          [
            command,
            { binary: "age", args: ["--encrypt", "--recipient", this.config.ageRecipient] },
          ],
          {
            output: createWriteStream(scratch, { mode: 0o600 }),
          },
        );
        const file = {
          key: `${id}/${name}`,
          bytes: (await stat(scratch)).size,
          sha256: await fileHash(scratch),
        };
        attempted.push(file.key);
        await this.rc("copyto", scratch, this.remote(file.key), "--immutable");
        await this.verifyUploaded(file);
        console.log(`Verified ${name}: ${file.bytes} encrypted bytes`);
        manifest.files.push(file);
        await remove(scratch);
      }
      manifest.finishedAt = new Date().toISOString();
      const next = nextIndex(previous, manifest, this.config);
      await this.publish(`${id}/COMPLETE.json`, manifest);
      await atomicJson(this.path("pending.json"), { previous, next });
      publishing = true;
      await this.publish("CURRENT.json", next);
      await atomicJson(this.path("checkpoint.json"), next);
      const displaced = obsoleteManifests(previous, next);
      await atomicJson(this.path("cleanup.json"), displaced);
      await remove(this.path("pending.json"));
      await this.cleanup(displaced, next);
      await remove(this.path("cleanup.json"));
      console.log(
        JSON.stringify({
          status: "COMPLETE",
          run: id,
          bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
        }),
      );
      return next;
    } catch (error) {
      if (!publishing) {
        for (const key of [...attempted, `${id}/COMPLETE.json`]) {
          await this.rc("deletefile", this.remote(key)).catch(() =>
            console.error(`Unreferenced upload needs cleanup: ${key}`),
          );
        }
      }
      throw error;
    } finally {
      await remove(scratch);
    }
  }
  async restore(slot: "nightly" | "weekly", name: string, targetService: string): Promise<void> {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(targetService)) throw Error("Invalid target service");
    if (
      this.config.databases.some((db) => db.service === targetService) ||
      this.config.rolesService === targetService
    ) {
      throw Error("Restore target must not be a configured source service");
    }
    const index = await this.index();
    if (!index) throw Error("No complete backup exists");
    const manifest = index[slot];
    const file = manifest.files.find((f) => f.key === `${manifest.run}/${name}.dump.age`);
    if (!file) throw Error("Database not present in selected recovery point");
    const scratch = this.path("restore.dump.age");
    try {
      await this.rc("copyto", this.remote(file.key), scratch);
      await this.verifyFile(file, scratch);
      const empty = await run(
        [
          pg("psql", targetService, [
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema';",
          ]),
        ],
        { collect: true },
      );
      if (empty.trim() !== "0") throw Error("Restore requires an empty isolated target database");
      await run([
        { binary: "age", args: ["--decrypt", "--identity", this.config.ageIdentityFile, scratch] },
        pg("pg_restore", targetService, [
          "--exit-on-error",
          "--single-transaction",
          `--dbname=service=${targetService}`,
        ]),
      ]);
      console.log(
        `Restored ${name} from ${slot}; validate the application before enabling writers`,
      );
    } finally {
      await remove(scratch);
    }
  }
}

export async function prepareState(config: BackupConfig): Promise<void> {
  process.umask(0o077);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
}
