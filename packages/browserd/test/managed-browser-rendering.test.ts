import { describe, expect, test } from "bun:test";
import {
  managedChromiumSoftwareLaunchArguments,
  resolveManagedHeadedSoftwareRenderingPolicy,
} from "../src/managed-browser-rendering";
import { browserLaunchArguments } from "../src/runner";

describe("managed headed browser compositor policy", () => {
  test("automatically uses software rendering only on an allocated isolated Linux display", () => {
    const policy = resolveManagedHeadedSoftwareRenderingPolicy(
      undefined,
      "isolated_linux",
      "linux",
    );
    expect(policy).toBe("allocated_linux");
    const launch = (allocatedDisplay: boolean) =>
      managedChromiumSoftwareLaunchArguments({
        policy,
        headed: true,
        managedChromium: true,
        allocatedDisplay,
      });
    expect(browserLaunchArguments("linux", launch(true))).toContain("--disable-gpu");
    expect(launch(false)).toEqual([]);
    expect(
      managedChromiumSoftwareLaunchArguments({
        policy,
        headed: false,
        managedChromium: true,
        allocatedDisplay: true,
      }),
    ).toEqual([]);
    expect(
      managedChromiumSoftwareLaunchArguments({
        policy,
        headed: true,
        managedChromium: false,
        allocatedDisplay: true,
      }),
    ).toEqual([]);
  });

  test("existing seats stay unchanged unless a Linux operator explicitly opts in", () => {
    expect(resolveManagedHeadedSoftwareRenderingPolicy(undefined, "existing", "linux")).toBe(
      "disabled",
    );
    expect(resolveManagedHeadedSoftwareRenderingPolicy(undefined, "isolated_linux", "darwin")).toBe(
      "disabled",
    );
    const policy = resolveManagedHeadedSoftwareRenderingPolicy("true", "existing", "linux");
    expect(policy).toBe("operator_enabled");
    expect(
      managedChromiumSoftwareLaunchArguments({
        policy,
        headed: true,
        managedChromium: true,
        allocatedDisplay: false,
      }),
    ).toEqual(["--disable-gpu"]);
    expect(resolveManagedHeadedSoftwareRenderingPolicy("false", "isolated_linux", "linux")).toBe(
      "disabled",
    );
    expect(() => resolveManagedHeadedSoftwareRenderingPolicy("yes", "existing", "linux")).toThrow(
      "is invalid",
    );
    expect(() => resolveManagedHeadedSoftwareRenderingPolicy("true", "existing", "win32")).toThrow(
      "Linux only",
    );
  });
});
