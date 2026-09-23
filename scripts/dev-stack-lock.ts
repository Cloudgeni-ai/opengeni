import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DevelopmentStackOwner = { token: string; repositoryRoot: string };

function recordedOwnerHint(ownerPath: string): string {
  try {
    const owner: DevelopmentStackOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
    const runtime = readFileSync(join(owner.repositoryRoot, ".env.runtime"), "utf8");
    const port = /^OPENGENI_WEB_PORT=(\d+)$/mu.exec(runtime)?.[1];
    const url =
      port && Number(port) > 0 && Number(port) <= 65535
        ? ` Recorded web URL: http://127.0.0.1:${port}/ (startup may still be in progress).`
        : "";
    return ` Checkout: ${owner.repositoryRoot}.${url}`;
  } catch {
    // The owner may still be writing its initial runtime environment.
    return "";
  }
}

function ownerIsRunning(owner: DevelopmentStackOwner): boolean {
  const result = Bun.spawnSync(["ps", "-axo", "args="], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Cannot verify the previous development stack owner");
  const argument = `--opengeni-dev-stack-token=${owner.token}`;
  return result.stdout
    .toString()
    .split("\n")
    .some((line) => line.trim().split(/\s+/u).includes(argument));
}

/** SQLite owns the OS lock: no expiry, PID reuse, or stale-lock deletion race. */
export function acquireDevelopmentStackLock(
  project: string,
  owner: DevelopmentStackOwner,
  options: { directory?: string } = {},
): () => void {
  const directory =
    options.directory ?? join(tmpdir(), `opengeni-dev-stack-locks-${process.getuid?.() ?? "user"}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(project).digest("hex");
  const databasePath = join(directory, `${key}.sqlite`);
  const ownerPath = join(directory, `${key}.owner.json`);
  const db = new Database(databasePath, { create: true });
  chmodSync(databasePath, 0o600);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") {
      throw new Error(
        `OpenGeni stack ${project} already has a launcher.${recordedOwnerHint(ownerPath)} Use its printed web URL or stop it before restarting.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    let previous: DevelopmentStackOwner | undefined;
    try {
      previous = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A killed supervisor releases SQLite, but its shell may still be alive.
    // Preserve that owner's services rather than rotating their credentials.
    if (previous && ownerIsRunning(previous)) {
      throw new Error(
        `OpenGeni stack ${project} is still running from ${previous.repositoryRoot}.${recordedOwnerHint(ownerPath)} Stop that launcher before restarting.`,
      );
    }
    // Publish the token before spawning, so even supervisor death during spawn
    // leaves enough identity to recognize the surviving shell on the next start.
    const pendingOwnerPath = `${ownerPath}.${owner.token}.tmp`;
    writeFileSync(pendingOwnerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    renameSync(pendingOwnerPath, ownerPath);
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
}
