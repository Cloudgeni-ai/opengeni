import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { acceptSessionUserMessage } from "../src/domain/sessions";

describe("explicit follow-up tool replacement rollout gate", () => {
  test("rejects before touching persistence while the two-phase rollout flag is off", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const grant: AccessGrant = {
      accountId: "00000000-0000-4000-8000-000000000001",
      workspaceId,
      subjectId: "user:replacement-gate",
      permissions: ["sessions:control"],
    };
    const deps = {
      settings: testSettings({ sessionTurnToolReplacementEnabled: false }),
      // Any access would prove the admission check ran too late.
      get db(): never {
        throw new Error("replacement gate touched persistence");
      },
    } as never;

    await expect(
      acceptSessionUserMessage(deps, grant, workspaceId, "00000000-0000-4000-8000-000000000003", {
        text: "replace tools",
        tools: [],
        toolsProvided: true,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message:
        "explicit follow-up tool replacement is temporarily unavailable until provenance-aware turn workers finish rolling out; omit tools to inherit the session policy and retry",
    });
  });
});
