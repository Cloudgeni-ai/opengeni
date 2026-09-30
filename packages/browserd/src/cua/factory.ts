import { ComputerDriver } from "../computer-driver";
import type { ComputerSupervisorDriverContext } from "../computer-supervisor";
import { CuaComputerBackend } from "./backend";

// The released SDK owns process-global native state. One physical desktop has
// one runtime; never let closing one session shut down another session's SDK.
let occupied = false;

export async function createCuaComputerDriver(
  context: ComputerSupervisorDriverContext,
): Promise<ComputerDriver> {
  if (process.platform !== "darwin")
    throw new Error(
      "CUA computer pilot currently requires macOS; Linux and Windows acceptance is pending",
    );
  if (occupied) throw new Error("CUA desktop runtime is already owned by another ComputerSession");
  occupied = true;
  try {
    // Lazy loading keeps the browser engine and normal native backend independent
    // of CUA's Node-API runtime. Never expose CUA browser tools or its raw SDK.
    const { CuaDriver } = await import("@trycua/cua-driver");
    const sdk = CuaDriver.create(undefined);
    let closed = false;
    const backend = await CuaComputerBackend.open({
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
    });
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
