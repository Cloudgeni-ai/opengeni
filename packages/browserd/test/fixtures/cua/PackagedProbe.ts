import { createCuaRuntime } from "../../../src/cua/sdk";

const sdk = await createCuaRuntime();
let workerPid: number | undefined;
try {
  const result = await sdk.callTool(
    "check_permissions",
    JSON.stringify({ prompt: false, probe_direct_capture: false }),
  );
  if (result.isError || result.errorCode) throw new Error("Packaged CUA permission read failed");
  const status = JSON.parse(result.structuredJson ?? result.text);
  if (typeof status.accessibility !== "boolean" || typeof status.screen_recording !== "boolean")
    throw new Error("Packaged CUA permission result is malformed");
  workerPid = status.source?.pid;
  if (!Number.isInteger(workerPid) || workerPid === process.pid)
    throw new Error("Packaged CUA did not start a separate worker");
  const cursor = await sdk.callTool("get_agent_cursor_state", "{}");
  if (cursor.isError || JSON.parse(cursor.structuredJson ?? "{}").enabled !== true)
    throw new Error("Packaged CUA cursor facility is unavailable");
} finally {
  await sdk.shutdown();
  if ("uniffiDestroy" in sdk && typeof sdk.uniffiDestroy === "function") sdk.uniffiDestroy();
}
let stopped = false;
try {
  process.kill(workerPid!, 0);
} catch (error) {
  stopped = (error as NodeJS.ErrnoException).code === "ESRCH";
}
if (!stopped) throw new Error("Packaged CUA worker survived SDK shutdown");
console.log(JSON.stringify({ permissionsRead: true, cursorEnabled: true, workerStopped: true }));
