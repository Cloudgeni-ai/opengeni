import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { UnsettledCleanupError } from "../cleanup-error";

/** Give the private worker and ordinary launched descendants one owned group.
 * This is lifecycle containment, not a same-user security sandbox: applications
 * that deliberately detach into another session remain outside this group. */
export async function linuxWorkerLauncher(binary: string, environment: NodeJS.ProcessEnv) {
  const directory = environment.XDG_RUNTIME_DIR;
  if (!directory || !isAbsolute(directory) || !isAbsolute(binary))
    throw new Error("Linux CUA needs an allocated runtime directory and absolute worker path");
  const setsid = Bun.which("setsid", { PATH: environment.PATH ?? "" });
  if (!setsid || !isAbsolute(setsid))
    throw new Error("Linux CUA requires setsid on the allocated environment PATH");
  const launcher = join(directory, "cua-worker-launcher");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    launcher,
    `#!/bin/sh\nunset WAYLAND_DISPLAY XAUTHORITY AT_SPI_BUS_ADDRESS\nexec ${quote(setsid)} -- ${quote(binary)} "$@"\n`,
    {
      mode: 0o700,
      flag: "wx",
    },
  );
  return launcher;
}

type ProcessIdentity = {
  pid: number;
  group: number;
  session: number;
  started: string;
  state: string;
};
async function identity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return {
      pid,
      group: Number(fields[2]),
      session: Number(fields[3]),
      started: fields[19]!,
      state: fields[0]!,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ownLinuxWorkerGroup(pid: number): Promise<() => Promise<void>> {
  const owner = await identity(pid);
  if (!owner || owner.group !== pid || owner.session !== pid)
    throw new Error("CUA worker did not enter its own Linux process group");
  const members = async () => {
    const current = await identity(pid);
    if (current && current.started !== owner.started)
      throw new Error("CUA worker PID was reused; refusing process-group cleanup");
    const entries = await readdir("/proc");
    const processes = await Promise.all(
      entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => identity(Number(entry))),
    );
    return processes.filter(
      (process) => process?.group === pid && process.session === pid && process.state !== "Z",
    );
  };
  return async () => {
    try {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if ((await members()).length === 0) return;
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        for (let i = 0; i < 20; i++) {
          if ((await members()).length === 0) return;
          await Bun.sleep(50);
        }
      }
      throw new Error("CUA worker descendants did not exit");
    } catch (error) {
      throw new UnsettledCleanupError([error], "Linux CUA process-group cleanup did not settle");
    }
  };
}
