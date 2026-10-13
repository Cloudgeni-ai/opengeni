import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { Manifest } from "@openai/agents/sandbox";

/** Resolve the actual pinned SDK from its owning runtime package, not a new
 * production dependency of the core integration fixture. */
export function modalBrokerSdkFixture(input: {
  sandboxId: string;
  root: string;
  environment: Record<string, string>;
  readFile: (path: string) => Promise<Uint8Array>;
  modal?: unknown;
}) {
  return new ModalSandboxSession({
    modal: input.modal ?? {},
    app: {},
    ownsSandbox: false,
    sandbox: {
      sandboxId: input.sandboxId,
      exec: async () => { throw new Error("SDK TaskExec must not run"); },
      filesystem: { readBytes: input.readFile },
    },
    state: {
      sandboxId: input.sandboxId,
      manifest: new Manifest({ root: input.root }),
      environment: input.environment,
    },
  } as unknown as ConstructorParameters<typeof ModalSandboxSession>[0]);
}
