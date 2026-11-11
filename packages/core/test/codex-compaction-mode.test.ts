import { describe, expect, test } from "bun:test";
import { resolveWorkspaceCodexCompactionDefault } from "@opengeni/contracts";
import { sessionNeedsPortableModelSwitch } from "../src/domain/sessions";

describe("resolveWorkspaceCodexCompactionDefault", () => {
  test("defaults to remote_v2 when unset", () => {
    expect(resolveWorkspaceCodexCompactionDefault({})).toBe("remote_v2");
    expect(resolveWorkspaceCodexCompactionDefault(null)).toBe("remote_v2");
    expect(resolveWorkspaceCodexCompactionDefault(undefined)).toBe("remote_v2");
  });

  test("honors explicit portable and remote_v2", () => {
    expect(resolveWorkspaceCodexCompactionDefault({ codexCompactionDefault: "portable" })).toBe(
      "portable",
    );
    expect(resolveWorkspaceCodexCompactionDefault({ codexCompactionDefault: "remote_v2" })).toBe(
      "remote_v2",
    );
  });
});

describe("sessionNeedsPortableModelSwitch", () => {
  test("portable sessions never need a switch", () => {
    expect(sessionNeedsPortableModelSwitch({ codexCompactionMode: "portable" }, "gpt-5")).toBe(
      false,
    );
  });

  test("Codex models keep remote_v2 sessions as they are", () => {
    expect(
      sessionNeedsPortableModelSwitch({ codexCompactionMode: "remote_v2" }, "codex/gpt-5.4"),
    ).toBe(false);
    expect(sessionNeedsPortableModelSwitch({ codexCompactionMode: "remote_v2" }, null)).toBe(false);
  });

  test("a non-Codex model on a remote_v2 session converts it instead of failing", () => {
    expect(sessionNeedsPortableModelSwitch({ codexCompactionMode: "remote_v2" }, "gpt-5")).toBe(
      true,
    );
  });
});
