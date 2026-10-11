import { createCuaRuntime } from "../../../src/cua/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = process.platform === "linux" ? await mkdtemp(join(tmpdir(), "cua-probe-")) : null;
const sdk = await createCuaRuntime(directory ? { ...process.env, HOME: directory, XDG_RUNTIME_DIR: directory } : process.env);
let workerPid: number | undefined;
try {
  const result = await sdk.callTool(
    "check_permissions",
    JSON.stringify(process.platform === "darwin" ? { prompt: false, probe_direct_capture: false } : {}),
  );
  if (result.isError || result.errorCode) throw new Error("Packaged CUA permission read failed");
  const status = JSON.parse(result.structuredJson ?? result.text);
  if (process.platform === "linux"
    ? typeof status.x11 !== "boolean" || typeof status.atspi !== "boolean"
    : typeof status.accessibility !== "boolean" || typeof status.screen_recording !== "boolean")
    throw new Error("Packaged CUA permission result is malformed");
  workerPid = (await sdk.metadata()).pid;
  if (!Number.isInteger(workerPid) || workerPid === process.pid)
    throw new Error("Packaged CUA did not start a separate worker");
  const cursor = await sdk.callTool("get_agent_cursor_state", "{}");
  if (cursor.isError || typeof JSON.parse(cursor.structuredJson ?? "{}").enabled !== "boolean")
    throw new Error("Packaged CUA cursor facility is unavailable");
} finally {
  await sdk.shutdown();
  if ("uniffiDestroy" in sdk && typeof sdk.uniffiDestroy === "function") sdk.uniffiDestroy();
  if (directory) await rm(directory, { recursive: true, force: true });
}
let stopped = false;
try {
  process.kill(workerPid!, 0);
} catch (error) {
  stopped = (error as NodeJS.ErrnoException).code === "ESRCH";
}
if (!stopped) throw new Error("Packaged CUA worker survived SDK shutdown");
console.log(JSON.stringify({ permissionsRead: true, cursorAvailable: true, workerStopped: true }));
