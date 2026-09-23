import { describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import {
  connectedMachinePathWithinRoot,
  connectedMachineWorkspaceRootsEqual,
  isConnectedMachineAbsolutePath,
  normalizeConnectedMachineWorkspaceRoot,
  relativeConnectedMachinePath,
  resolveConnectedMachinePath,
  resolveConnectedMachineWorkspaceRoot,
} from "../src/sandbox";

describe("Connected Machine workspace path normalization", () => {
  test("normalizes POSIX roots and relative children without inventing aliases", () => {
    const root = normalizeConnectedMachineWorkspaceRoot("/home/user/repo/./src/..", "linux");
    expect(root).toBe("/home/user/repo");
    expect(resolveConnectedMachinePath(root, undefined)).toBe("/home/user/repo");
    expect(resolveConnectedMachinePath(root, "packages/runtime")).toBe(
      "/home/user/repo/packages/runtime",
    );
    expect(resolveConnectedMachinePath(root, "/workspace")).toBe("/workspace");
  });

  test("normalizes Windows drive roots to a host-valid portable spelling", () => {
    const root = normalizeConnectedMachineWorkspaceRoot(
      String.raw`C:\work\repo\.\packages\..`,
      "windows",
    );
    expect(root).toBe("C:/work/repo");
    expect(resolveConnectedMachinePath(root, String.raw`src\index.ts`)).toBe(
      "C:/work/repo/src/index.ts",
    );
    expect(resolveConnectedMachinePath(root, String.raw`D:\scratch\x.txt`)).toBe(
      "D:/scratch/x.txt",
    );
    expect(connectedMachineWorkspaceRootsEqual("C:/Work/Repo", "c:/work/repo")).toBe(true);
  });

  test("supports UNC roots and rejects ambiguous or privileged Windows forms", () => {
    expect(normalizeConnectedMachineWorkspaceRoot(String.raw`\\server\share\repo`, "windows")).toBe(
      "//server/share/repo",
    );
    expect(() =>
      normalizeConnectedMachineWorkspaceRoot(String.raw`\\?\C:\repo`, "windows"),
    ).toThrow("device-namespace");
    expect(() => resolveConnectedMachinePath("C:/repo", "D:relative")).toThrow("drive-relative");
  });

  test("classifies and confines host-native absolute paths across operating systems", () => {
    expect(isConnectedMachineAbsolutePath("/srv/repo/src/app.ts")).toBe(true);
    expect(isConnectedMachineAbsolutePath(String.raw`C:\repo\src\app.ts`)).toBe(true);
    expect(isConnectedMachineAbsolutePath(String.raw`\\server\share\repo\app.ts`)).toBe(true);
    expect(isConnectedMachineAbsolutePath("src/app.ts")).toBe(false);

    expect(connectedMachinePathWithinRoot("/srv/repo", "/srv/repo/src/app.ts")).toBe(true);
    expect(connectedMachinePathWithinRoot("/srv/repo", "/srv/other/app.ts")).toBe(false);
    expect(connectedMachinePathWithinRoot("C:/Work/Repo", "c:/work/repo/src/app.ts")).toBe(true);
    expect(connectedMachinePathWithinRoot("C:/Work/Repo", "D:/work/repo/src/app.ts")).toBe(false);
    expect(
      connectedMachinePathWithinRoot(
        "//server/share/repo",
        String.raw`\\SERVER\SHARE\repo\src\app.ts`,
      ),
    ).toBe(true);
    expect(relativeConnectedMachinePath("C:/Work/Repo", "c:/work/repo/src/app.ts")).toBe(
      "src/app.ts",
    );
  });

  test("configured cwd is absolute or relative to Hello root; tilde is never guessed", () => {
    expect(resolveConnectedMachineWorkspaceRoot("/srv/repo", "packages/api")).toBe(
      "/srv/repo/packages/api",
    );
    expect(resolveConnectedMachineWorkspaceRoot("/srv/repo", "/opt/project")).toBe("/opt/project");
    expect(() => resolveConnectedMachineWorkspaceRoot("/srv/repo", "~/project")).toThrow(
      '"~" is not supported',
    );
  });

  test("the patched SDK Manifest accepts truthful drive and UNC roots", () => {
    expect(new Manifest({ root: "C:/work/repo", entries: {} }).root).toBe("C:/work/repo");
    expect(new Manifest({ root: "//server/share/repo", entries: {} }).root).toBe(
      "//server/share/repo",
    );
  });
});
