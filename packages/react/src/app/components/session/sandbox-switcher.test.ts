import { t } from "../../lib/console-text";
import { describe, expect, test } from "bun:test";
import { machineNameTwinLabel } from "../../../sandbox-label-model";
import { machineDisplayName, sessionSandboxLabel } from "./sandbox-switcher";

describe("session compute labels", () => {
  test("managed providers read as a neutral cloud sandbox, never a vendor name", () => {
    for (const backend of ["modal", "daytona", "e2b", "vercel", "opensandbox"] as const) {
      expect(sessionSandboxLabel(t, backend)).toBe("Cloud sandbox");
    }
    expect(sessionSandboxLabel(t, "docker")).toBe("Local sandbox");
    expect(sessionSandboxLabel(t, "local")).toBe("this computer");
    expect(sessionSandboxLabel(t, "none")).toBe("No sandbox");
  });

  test("the session's own box hides its vendor while Connected Machines keep their names", () => {
    expect(machineDisplayName(t, { isSessionGroup: true, kind: "modal", name: "Modal" })).toBe(
      "Cloud sandbox",
    );
    expect(
      machineDisplayName(t, { isSessionGroup: false, kind: "selfhosted", name: "Build box" }),
    ).toBe("Build box");
  });

  test("machines that share a name say who can use them; unique names stay plain", () => {
    const personal = {
      sandboxId: "personal",
      isSessionGroup: false,
      kind: "selfhosted",
      name: "build-box",
      scope: "user",
    } as const;
    const shared = { ...personal, sandboxId: "shared", scope: "workspace" } as const;
    const other = { ...personal, sandboxId: "other", name: "laptop" } as const;
    const listed = [personal, shared, other];
    expect(machineNameTwinLabel(t, personal, listed)).toBe("Only me");
    expect(machineNameTwinLabel(t, shared, listed)).toBe("Workspace");
    expect(machineNameTwinLabel(t, other, listed)).toBeUndefined();
    expect(machineNameTwinLabel(t, personal, [personal, other])).toBeUndefined();
  });
});
