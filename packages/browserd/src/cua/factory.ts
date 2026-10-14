import { ComputerDriver } from "../computer-driver";
import { join } from "node:path";
import type { ComputerSupervisorDriverContext } from "../computer-supervisor";
import { CuaComputerBackend } from "./backend";
import { createCuaRuntime } from "./sdk";

// One physical desktop has one runtime. Separate cursor overlays do not make
// simultaneous input into the same desktop safe.
let occupied = false;

export async function createCuaComputerDriver(
  context: ComputerSupervisorDriverContext,
): Promise<ComputerDriver> {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error(
      "CUA requires macOS, an isolated Linux seat, or an interactive Windows desktop",
    );
  const physical = process.platform !== "linux";
  if (
    !physical &&
    (context.seatId !== `linux-virtual:${context.computerSessionId}` ||
      !context.displayId ||
      context.environment.DISPLAY !== context.displayId ||
      !context.environment.DBUS_SESSION_BUS_ADDRESS ||
      context.environment.HOME !== join(context.sessionDirectory, "gui-home"))
  )
    throw new Error("CUA Linux requires an allocated display and accessibility bus");
  if (physical && occupied)
    throw new Error("CUA desktop runtime is already owned by another ComputerSession");
  if (physical) occupied = true;
  try {
    // Lazy loading keeps the browser engine and normal native backend independent
    // of CUA's Node-API runtime. Never expose CUA browser tools or its raw SDK.
    const environment = { ...context.environment };
    const sdk = await createCuaRuntime(environment);
    let closed = false;
    const backend = await CuaComputerBackend.open(
      {
        listToolsJson: () => sdk.listToolsJson(),
        callTool: (name, args) => sdk.callTool(name, args),
        shutdown: async () => {
          if (closed) return;
          closed = true;
          try {
            await sdk.shutdown();
          } finally {
            if ("uniffiDestroy" in sdk && typeof sdk.uniffiDestroy === "function")
              sdk.uniffiDestroy();
            if (physical) occupied = false;
          }
        },
      },
      process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos",
    );
    return new ComputerDriver({
      computerSessionId: context.computerSessionId,
      controllerGeneration: context.controllerGeneration,
      client: backend,
      // No automatic SDK reconstruction after an ambiguous native failure.
      // A new ComputerSession establishes new observations/capture authority.
    });
  } catch (error) {
    if (physical) occupied = false;
    throw error;
  }
}
