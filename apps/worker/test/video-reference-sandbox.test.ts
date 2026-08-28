import { describe, expect, test } from "bun:test";
import type { ResumedTurnSandbox } from "../src/sandbox-resume";
import type { SandboxRuntimeState } from "../src/activities/agent-turn/turn-context";
import { resolveVideoReferenceSandboxAccess } from "../src/activities/agent-turn/video-reference-sandbox";

type VideoReferenceSandboxState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

function resumedSandbox(session: object, leaseEpoch: number): ResumedTurnSandbox {
  return {
    established: { session },
    leaseEpoch,
  } as unknown as ResumedTurnSandbox;
}

describe("video reference sandbox access", () => {
  test("does not start a sandbox for text-to-video", async () => {
    const provisioned = resumedSandbox({ kind: "raw-provider-session" }, 29);
    let provisions = 0;
    const sandboxState: VideoReferenceSandboxState = {
      resolvedSandbox: null,
      lazyOwnedSandbox: null,
      turnSandboxProvisioner: {
        get: async () => {
          provisions += 1;
          return provisioned;
        },
        hasStarted: () => false,
        waitForSettled: async () => provisioned,
      },
    };

    const access = await resolveVideoReferenceSandboxAccess(
      { prompt: "A quiet landscape", source: { mode: "text" } },
      sandboxState,
      null,
    );

    expect(access).toBeNull();
    expect(provisions).toBe(0);
  });

  test("joins lazy provisioning and uses the active routed session for a source reference", async () => {
    const routedSession = { kind: "lazy-routing-session" };
    const provisioned = resumedSandbox({ kind: "raw-provider-session" }, 31);
    let provisions = 0;
    const sandboxState: VideoReferenceSandboxState = {
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

    const access = await resolveVideoReferenceSandboxAccess(
      {
        prompt: "Animate this frame",
        source: {
          mode: "first_frame",
          imagePath: "/workspace/generated-images/frame.png",
        },
      },
      sandboxState,
      null,
    );

    expect(provisions).toBe(1);
    expect(access?.sandbox).toBe(provisioned);
    expect(access?.session).toBe(routedSession);
    expect(access?.leaseEpoch).toBe(31);
  });
});
