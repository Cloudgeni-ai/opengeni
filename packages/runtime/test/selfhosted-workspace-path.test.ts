import { describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import {
  connectedMachinePathWithinRoot,
  connectedMachineWorkspaceRootsEqual,
  isConnectedMachineAbsolutePath,
  isUnusableConnectedMachineWorkspace,
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

  test("a filesystem root or Windows system directory never becomes the working directory", () => {
    expect(resolveConnectedMachineWorkspaceRoot("/Users/a", "/")).toBe("/Users/a");
    expect(resolveConnectedMachineWorkspaceRoot("/home/u", "../..")).toBe("/home/u");
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "C:/WINDOWS/system32")).toBe(
      "C:/Users/a",
    );
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "c:\\Windows\\System32\\")).toBe(
      "C:/Users/a",
    );
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "\\Windows\\System32")).toBe(
      "C:/Users/a",
    );
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "D:\\")).toBe("C:/Users/a");
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "\\")).toBe("C:/Users/a");
    // Ordinary chosen directories, including look-alikes, are kept.
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "D:/work")).toBe("D:/work");
    expect(resolveConnectedMachineWorkspaceRoot("C:/Users/a", "C:/WindowsApps")).toBe(
      "C:/WindowsApps",
    );
    expect(resolveConnectedMachineWorkspaceRoot("/home/u", "/windows")).toBe("/windows");
    expect(resolveConnectedMachineWorkspaceRoot("/home/u", "/opt/project")).toBe("/opt/project");
  });

  test("unusable workspace detection", () => {
    expect(isUnusableConnectedMachineWorkspace("/", "/home/u")).toBe(true);
    expect(isUnusableConnectedMachineWorkspace("C:/", "C:/Users/a")).toBe(true);
    expect(isUnusableConnectedMachineWorkspace("C:/Windows/Temp", "C:/Users/a")).toBe(true);
    expect(isUnusableConnectedMachineWorkspace("/Windows/System32", "C:/Users/a")).toBe(true);
    expect(isUnusableConnectedMachineWorkspace("/home/u", "/home/u")).toBe(false);
    expect(isUnusableConnectedMachineWorkspace("//server/share", "C:/Users/a")).toBe(false);
  });

  test("the patched SDK Manifest accepts truthful drive and UNC roots", () => {
    expect(new Manifest({ root: "C:/work/repo", entries: {} }).root).toBe("C:/work/repo");
    expect(new Manifest({ root: "//server/share/repo", entries: {} }).root).toBe(
      "//server/share/repo",
    );
  });
});
