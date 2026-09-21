import { describe, expect, test } from "bun:test";
import type { ResumedTurnSandbox } from "../src/sandbox-resume";
import type { SandboxRuntimeState } from "../src/activities/agent-turn/turn-context";
import {
  ownedTurnSandboxForAgent,
  resolveTurnSandboxAccess,
} from "../src/activities/agent-turn/turn-sandbox-access";

type TurnSandboxAccessState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

function resumedSandbox(session: object, leaseEpoch: number): ResumedTurnSandbox {
  return {
    established: { session },
    leaseEpoch,
  } as unknown as ResumedTurnSandbox;
}

describe("turn sandbox access", () => {
  test("model-stream binding uses the same routed-owner selector", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    expect(source).toContain("const ownedEstablished = ownedTurnSandboxForAgent(sandboxState)");
    expect(source).not.toContain(
      "sandboxState.resolvedSandbox?.established ?? sandboxState.lazyOwnedSandbox",
    );
  });

  test("agent keeps the routed owner after early lazy provisioning resolves the physical box", async () => {
    const calls: string[] = [];
    const raw = {
      execCommand: async () => {
        calls.push("raw");
        return "setup handle";
      },
    };
    const routed = {
      execCommand: async () => {
        calls.push("routed");
        return "durable command";
      },
    };
    const lazy = { session: routed, client: { backendId: "modal" } } as never;
    const state: TurnSandboxAccessState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: lazy,
      turnSandboxProvisioner: null,
    };
    expect(ownedTurnSandboxForAgent(state)).toBe(lazy);
    state.resolvedSandbox = resumedSandbox(raw, 19);
    const owned = ownedTurnSandboxForAgent(state)!;
    expect(owned).toBe(lazy);
    expect(await (owned.session as unknown as typeof routed).execCommand()).toBe("durable command");
    const access = await resolveTurnSandboxAccess(state, null, "unavailable");
    expect(access.session).toBe(routed);
    expect(access.sandbox?.established.session).toBe(raw);
    expect(access.leaseEpoch).toBe(19);
    expect(calls).toEqual(["routed"]);
  });

  test("agent selection preserves eager ownership and absent legacy ownership", () => {
    const state: TurnSandboxAccessState = {
      resolvedSandbox: resumedSandbox({ kind: "eager-routing-session" }, 23),
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: null,
    };
    expect(ownedTurnSandboxForAgent(state)).toBe(state.resolvedSandbox!.established);
    state.resolvedSandbox = null;
    expect(ownedTurnSandboxForAgent(state)).toBeUndefined();
  });

  test("waits for lazy provisioning and uses the routed session with the provisioned epoch", async () => {
    const routedSession = { kind: "lazy-routing-session" };
    const provisioned = resumedSandbox({ kind: "raw-provider-session" }, 17);
    let completeProvisioning!: (sandbox: ResumedTurnSandbox) => void;
    const provisioning = new Promise<ResumedTurnSandbox>((resolve) => {
      completeProvisioning = resolve;
    });
    let provisions = 0;
    const sandboxState: TurnSandboxAccessState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: { session: routedSession } as never,
      turnSandboxProvisioner: {
        get: async () => {
          provisions += 1;
          return await provisioning;
        },
        hasStarted: () => provisions > 0,
        waitForSettled: async () => await provisioning,
      },
    };

    let settled = false;
    const pending = resolveTurnSandboxAccess(sandboxState, null, "unavailable").then((access) => {
      settled = true;
      return access;
    });
    await Promise.resolve();

    expect(provisions).toBe(1);
    expect(settled).toBe(false);
    completeProvisioning(provisioned);
    const resolved = await pending;
    expect(resolved.sandbox).toBe(provisioned);
    expect(resolved.session).toBe(routedSession);
    expect(resolved.leaseEpoch).toBe(17);
  });

  test("reuses an already resolved eager or machine sandbox without starting the provisioner", async () => {
    const routedSession = { kind: "resolved-routing-session" };
    const resolvedSandbox = resumedSandbox(routedSession, 23);
    let provisions = 0;
    const sandboxState: TurnSandboxAccessState = {
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

    const resolved = await resolveTurnSandboxAccess(sandboxState, null, "unavailable");

    expect(provisions).toBe(0);
    expect(resolved.sandbox).toBe(resolvedSandbox);
    expect(resolved.session).toBe(routedSession);
    expect(resolved.leaseEpoch).toBe(23);
  });

  test("retains the SDK-owned legacy fallback when worker sandbox ownership is disabled", async () => {
    const sdkOwnedSession = { kind: "sdk-owned-session" };
    const sandboxState: TurnSandboxAccessState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: null,
    };

    const resolved = await resolveTurnSandboxAccess(sandboxState, sdkOwnedSession, "unavailable");

    expect(resolved.sandbox).toBeNull();
    expect(resolved.session).toBe(sdkOwnedSession);
    expect(resolved.leaseEpoch).toBe(0);
  });

  test("fails before I/O when no current sandbox session can be established", async () => {
    const sandboxState: TurnSandboxAccessState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: null,
    };

    await expect(
      resolveTurnSandboxAccess(sandboxState, null, "reference unavailable"),
    ).rejects.toThrow("reference unavailable");
  });
});
