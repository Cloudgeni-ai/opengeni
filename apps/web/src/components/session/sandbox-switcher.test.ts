import { describe, expect, test } from "bun:test";
import {
  machineDisplayName,
  sessionSandboxLabel,
  sessionSupportsFleetSwitching,
} from "./sandbox-switcher";

describe("sessionSupportsFleetSwitching", () => {
  test("offers fleet attachment whether or not the session has a home sandbox", () => {
    expect(sessionSupportsFleetSwitching("none")).toBe(true);
    expect(sessionSupportsFleetSwitching("modal")).toBe(true);
    expect(sessionSupportsFleetSwitching("selfhosted")).toBe(true);
  });
});

describe("session compute labels", () => {
  test("managed providers read as a neutral cloud sandbox, never a vendor name", () => {
    for (const backend of ["modal", "daytona", "e2b", "vercel", "opensandbox"] as const) {
      expect(sessionSandboxLabel(backend)).toBe("Cloud sandbox");
    }
    expect(sessionSandboxLabel("docker")).toBe("Local sandbox");
    expect(sessionSandboxLabel("local")).toBe("this computer");
    expect(sessionSandboxLabel("none")).toBe("No sandbox");
  });

  test("the session's own box hides its vendor while Connected Machines keep their names", () => {
    expect(machineDisplayName({ isSessionGroup: true, kind: "modal", name: "Modal" })).toBe(
      "Cloud sandbox",
    );
    expect(
      machineDisplayName({ isSessionGroup: false, kind: "selfhosted", name: "Build box" }),
    ).toBe("Build box");
  });
});
