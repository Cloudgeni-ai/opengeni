import { describe, expect, test } from "bun:test";
import type { ResumedTurnSandbox } from "../src/sandbox-resume";
import type { SandboxRuntimeState } from "../src/activities/agent-turn/turn-context";
import { resolveImageReferenceSandboxSession } from "../src/activities/agent-turn/image-reference-sandbox";

type ImageReferenceSandboxState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

function resumedSandbox(session: object, leaseEpoch: number): ResumedTurnSandbox {
  return {
    established: { session },
    leaseEpoch,
  } as unknown as ResumedTurnSandbox;
}

describe("image reference sandbox resolution", () => {
  test("joins lazy provisioning and uses the routed session with the provisioned epoch", async () => {
    const routedSession = { kind: "lazy-routing-session" };
    const provisioned = resumedSandbox({ kind: "raw-provider-session" }, 17);
    let provisions = 0;
    const sandboxState: ImageReferenceSandboxState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: { session: routedSession } as never,
      turnSandboxProvisioner: {
        get: async () => {
          provisions += 1;
          return provisioned;
        },
        hasStarted: () => provisions > 0,
        waitForSettled: async () => provisioned,
      },
    };

    const resolved = await resolveImageReferenceSandboxSession(sandboxState, null);

    expect(provisions).toBe(1);
    expect(resolved.session).toBe(routedSession);
    expect(resolved.leaseEpoch).toBe(17);
  });

  test("reuses an already resolved eager or machine sandbox without starting the provisioner", async () => {
    const routedSession = { kind: "resolved-routing-session" };
    const resolvedSandbox = resumedSandbox(routedSession, 23);
    let provisions = 0;
    const sandboxState: ImageReferenceSandboxState = {
      resolvedSandbox,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: {
        get: async () => {
          provisions += 1;
          return resolvedSandbox;
        },
        hasStarted: () => false,
        waitForSettled: async () => resolvedSandbox,
      },
    };

    const resolved = await resolveImageReferenceSandboxSession(sandboxState, null);

    expect(provisions).toBe(0);
    expect(resolved.session).toBe(routedSession);
    expect(resolved.leaseEpoch).toBe(23);
  });

  test("retains the SDK-owned legacy fallback when worker sandbox ownership is disabled", async () => {
    const sdkOwnedSession = { kind: "sdk-owned-session" };
    const sandboxState: ImageReferenceSandboxState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: null,
    };

    const resolved = await resolveImageReferenceSandboxSession(sandboxState, sdkOwnedSession);

    expect(resolved.session).toBe(sdkOwnedSession);
    expect(resolved.leaseEpoch).toBe(0);
  });

  test("fails before file I/O when no current sandbox session can be established", async () => {
    const sandboxState: ImageReferenceSandboxState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: null,
    };

    await expect(resolveImageReferenceSandboxSession(sandboxState, null)).rejects.toThrow(
      "Sandbox image reference is unavailable",
    );
  });
});
