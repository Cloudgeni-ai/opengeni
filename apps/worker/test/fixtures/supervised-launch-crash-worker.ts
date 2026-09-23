// Real child process used only by the crash-boundary regression. The parent
// owns PostgreSQL and the native provider process; killing this client cannot
// destroy either durable system.
import { ModalCommandControl } from "../../../../packages/runtime/src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../../../../packages/runtime/src/sandbox/providers/modal-command-session";
import { RoutingSandboxSession } from "../../../../packages/runtime/src/sandbox/routing/routing-session";
import type { ProviderCommandSession } from "../../../../packages/runtime/src/sandbox/provider-command-session";
import type { ChannelASession } from "../../../../packages/runtime/src/sandbox/channel-a";

const endpoint = process.env.TEST_SUPERVISION_ENDPOINT!;
const sandboxId = process.env.TEST_SUPERVISION_SANDBOX!;
async function call(path: string, body: unknown) {
  const result = await fetch(`${endpoint}/${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!result.ok) throw new Error(`Test provider rejected ${path}`);
  return result.json();
}
const control = ModalCommandControl.forSandbox({
  version: () => "0.9.0",
  cpClient: { sandboxGetTaskId: async () => ({ taskId: "ta-crash" }) },
} as never, sandboxId, "/workspace");
// Capability is independently covered against the real authenticated wire.
// Here the parent has compiled the exact supervisor used by the provider seam.
control.verifySupervisionCapability = async () => ({ sandboxId, taskId: "ta-crash" });
Object.defineProperty(control, "withRouter", { value: async (_task: string, _signal: unknown, run: (router: unknown) => Promise<unknown>) => run({
  start: async (request: unknown) => {
    await call("start", request);
    // This is the old crash window: provider accepted launch, but start has
    // not returned to routing's former post-dispatch promotion point.
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  },
}) });
const session = {} as ChannelASession & ProviderCommandSession;
installModalCommandSession(session, control);
const backend = { session, sandboxId: null, kind: "modal", activeEpoch: 0, providerInstanceId: sandboxId };
let retained: any = null;
const routed = new RoutingSandboxSession({
  defaultResolved: backend,
  readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
  resolveActiveBackend: async () => backend,
  providerSupervisionReady: async () => true,
  providerCommandHandle: () => 71,
  beforeMutation: async () => "exact-test-admission",
  afterMutation: async ({ retainedProcess }) => {
    if (!retainedProcess) throw new Error("Crash fixture requires pre-dispatch retention");
    await call("reserve", retainedProcess);
    retained = retainedProcess.providerCommand;
  },
  providerCommandPersistence: () => ({
    load: async () => retained,
    acknowledge: async (command) => command,
    reserveInput: async () => { throw new Error("No stdin during launch"); },
  }),
});
await routed.execCommand({ cmd: `touch ${process.env.TEST_SUPERVISION_MARKER!}` });
throw new Error("Crash fixture unexpectedly returned");