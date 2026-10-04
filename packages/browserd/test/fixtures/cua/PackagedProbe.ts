import { loadCuaDriver } from "../../../src/cua/sdk";

const CuaDriver = await loadCuaDriver();
const sdk = CuaDriver.create(undefined);
try {
  const result = await sdk.callTool(
    "check_permissions",
    JSON.stringify({ prompt: false, probe_direct_capture: false }),
  );
  if (result.isError || result.errorCode) throw new Error("Packaged CUA permission read failed");
  const status = JSON.parse(result.structuredJson ?? result.text);
  if (typeof status.accessibility !== "boolean" || typeof status.screen_recording !== "boolean")
    throw new Error("Packaged CUA permission result is malformed");
  console.log(JSON.stringify({ permissionsRead: true }));
} finally {
  await sdk.shutdown();
  if ("uniffiDestroy" in sdk && typeof sdk.uniffiDestroy === "function") sdk.uniffiDestroy();
}
