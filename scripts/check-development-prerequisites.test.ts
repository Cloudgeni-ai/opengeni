import { describe, expect, test } from "bun:test";
import { developmentPrerequisiteErrors } from "./check-development-prerequisites";

const ready = {
  bunVersion: "1.4.0",
  requiredBunVersion: "1.4.0",
  platform: "linux",
  which: (command: string) => `/usr/bin/${command}`,
};

describe("development prerequisites", () => {
  test("accepts supported hosts without requiring Docker or model credentials", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(developmentPrerequisiteErrors({ ...ready, platform })).toEqual([]);
    }
    expect(developmentPrerequisiteErrors({ ...ready, bunVersion: "1.5.0" })).toEqual([
      expect.stringContaining("pinned Bun 1.4.0"),
    ]);
  });

  test("reports an older Bun before the frozen install fails", () => {
    expect(developmentPrerequisiteErrors({ ...ready, bunVersion: "1.3.5" })).toEqual([
      expect.stringContaining("pinned Bun 1.4.0"),
    ]);
  });

  test("collects missing native build tools with installation instructions", () => {
    const errors = developmentPrerequisiteErrors({
      ...ready,
      which: (command) => (command === "rustup" || command === "cc" ? null : `/usr/bin/${command}`),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("https://rustup.rs");
    expect(errors[1]).toContain("Xcode Command Line Tools");
  });

  test("directs native Windows users to WSL2", () => {
    expect(developmentPrerequisiteErrors({ ...ready, platform: "win32" })).toEqual([
      expect.stringContaining("WSL2"),
    ]);
  });
});
