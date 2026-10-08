import { ComputerDriver } from "../computer-driver";
import type { ComputerSupervisorDriverContext } from "../computer-supervisor";
import { CuaComputerBackend } from "./backend";
import { createCuaRuntime } from "./sdk";

// One physical desktop has one runtime. Separate cursor overlays do not make
// simultaneous input into the same desktop safe.
let occupied = false;

export async function createCuaComputerDriver(
  context: ComputerSupervisorDriverContext,
): Promise<ComputerDriver> {
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error(
      "CUA computer pilot currently requires macOS or an interactive Windows desktop",
    );
  if (occupied) throw new Error("CUA desktop runtime is already owned by another ComputerSession");
  occupied = true;
  try {
    // Lazy loading keeps the browser engine and normal native backend independent
    // of CUA's Node-API runtime. Never expose CUA browser tools or its raw SDK.
    const sdk = await createCuaRuntime();
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
            occupied = false;
          }
        },
      },
      process.platform === "win32" ? "windows" : "macos",
    );
    return new ComputerDriver({
      computerSessionId: context.computerSessionId,
      controllerGeneration: context.controllerGeneration,
      client: backend,
      // No automatic SDK reconstruction after an ambiguous native failure.
      // A new ComputerSession establishes new observations/capture authority.
    });
  } catch (error) {
    occupied = false;
    throw error;
  }
}
