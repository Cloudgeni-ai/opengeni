import { describe, expect, test } from "bun:test";
import type { ApiSandboxClient, ApiSandboxSession } from "@opengeni/core";
import { makeResumeBoxById, SandboxResumeError } from "../src/sandbox/access";

describe("makeResumeBoxById", () => {
  test("borrows a resumed box without inheriting the founding handle's ownership", async () => {
    const canonicalState = {
      sandboxId: "sb-owned",
      ownsSandbox: true,
      providerField: "preserved",
    };
    let resumedWith: Record<string, unknown> | undefined;
    const resumedSession: ApiSandboxSession = { state: { sandboxId: "sb-owned" } };
    const client: ApiSandboxClient = {
      backendId: "modal",
      deserializeSessionState: async (state) => {
        expect(state).toEqual(canonicalState);
        return state;
      },
      resume: async (state) => {
        resumedWith = state;
        return resumedSession;
      },
    };

    const result = await makeResumeBoxById(client)({
      backend: "modal",
      resumeState: canonicalState,
    });

    expect(result).toBe(resumedSession);
    expect(resumedWith).toEqual({
      sandboxId: "sb-owned",
      ownsSandbox: false,
      providerField: "preserved",
    });
    expect(canonicalState.ownsSandbox).toBe(true);
  });

  test("rejects a resume envelope for a different backend", async () => {
    const resume = makeResumeBoxById({ backendId: "modal" });
    expect(
      resume({ backend: "docker", resumeState: { sandboxId: "sb-cross" } }),
    ).rejects.toBeInstanceOf(SandboxResumeError);
  });

  test("rejects a backend without deserialize and resume support", async () => {
    const resume = makeResumeBoxById({ backendId: "modal" });
    expect(
      resume({ backend: "modal", resumeState: { sandboxId: "sb-unsupported" } }),
    ).rejects.toBeInstanceOf(SandboxResumeError);
  });
});
