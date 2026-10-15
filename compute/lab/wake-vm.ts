import { Vm, now, sleep } from "./fc";
import { measuredExec } from "./wake-exec";

/** Agent readiness must not include a transport EOF/close grace period. */
export class TimedVm extends Vm {
  override async api(method: string, path: string, body?: unknown): Promise<any> {
    const deadline = now() + 10000;
    for (;;) {
      try { return await super.api(method, path, body); }
      catch (error) {
        // A bound Unix socket inode can appear before listen(). Only retry a
        // refused connection: no API request reached the server in that case.
        if ((error as { code?: string }).code !== "ECONNREFUSED" || this.proc?.exitCode !== null || now() > deadline) throw error;
        await sleep(2);
      }
    }
  }

  override async waitAgent(timeoutMs: number) {
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        const result = await measuredExec(this.vsock, "true", 2000, true);
        if (result.status !== 0) throw new Error("agent readiness command failed");
        return;
      } catch (error) {
        if (now() > deadline) throw new Error(`${this.id}: agent not ready: ${error}`);
        await sleep(20);
      }
    }
  }
}
