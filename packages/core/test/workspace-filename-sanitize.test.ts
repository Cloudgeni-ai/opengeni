import { describe, expect, test } from "bun:test";
import { sanitizeWorkspaceFilename } from "../src/domain/browser-retained-downloads";

describe("sanitizeWorkspaceFilename", () => {
  test("keeps names that only contain two dots", () => {
    expect(sanitizeWorkspaceFilename("notes..txt")).toBe("notes..txt");
    expect(sanitizeWorkspaceFilename("v1..2.csv")).toBe("v1..2.csv");
  });

  test("never returns a path segment the sandbox cannot write a file under", () => {
    for (const name of ["", " ", ".", "..", " .. ", "/", "\\"]) {
      const safe = sanitizeWorkspaceFilename(name);
      expect(safe).not.toBe(".");
      expect(safe).not.toBe("..");
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
      expect(safe.length).toBeGreaterThan(0);
    }
    expect(sanitizeWorkspaceFilename("..")).toBe("file");
    expect(sanitizeWorkspaceFilename("../etc/passwd")).toBe(".._etc_passwd");
    expect(sanitizeWorkspaceFilename("a\0b.txt")).toBe("a_b.txt");
  });
});
