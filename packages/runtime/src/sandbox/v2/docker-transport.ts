import type { MachineExecTransport } from "./journal-client";

/** Ordinary Docker exec pinned to an immutable container ID. This adapter
 * cannot create, resume, replace or redirect a stopped/missing machine. Killing
 * the local observer never supplies a command outcome or cancels its journal. */
export class DockerMachineExecTransport implements MachineExecTransport {
  constructor(
    private readonly timeoutMs = 30_000,
    private readonly socketPath?: string,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error("Invalid Docker journal transport deadline");
    if (socketPath !== undefined && (!socketPath.startsWith("/") || socketPath.includes("\0")))
      throw new Error("Docker socket must be an absolute local path");
  }
  async exec(input: Parameters<MachineExecTransport["exec"]>[0]) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.instanceId) ||
      input.argv.length === 0 ||
      input.argv.some((value) => value.includes("\0"))
    )
      throw new Error("Invalid exact Docker exec binding");
    input.signal?.throwIfAborted();
    const child = Bun.spawn(
      [
        "docker",
        ...(this.socketPath ? ["--host", `unix://${this.socketPath}`] : []),
        "exec",
        "-i",
        input.instanceId,
        ...input.argv,
      ],
      {
        stdin: input.stdin?.slice() ?? "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const abort = () => child.kill("SIGKILL");
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    const pages: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const page of child.stdout) {
        size += page.byteLength;
        if (size > 3 * 1024 * 1024) throw new Error("Docker journal reply exceeds its byte limit");
        pages.push(page);
      }
      const exitCode = await child.exited;
      input.signal?.throwIfAborted();
      const stdout = new Uint8Array(size);
      let offset = 0;
      for (const page of pages) {
        stdout.set(page, offset);
        offset += page.byteLength;
      }
      return { exitCode, stdout };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }
}
