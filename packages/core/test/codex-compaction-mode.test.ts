import { describe, expect, test } from "bun:test";
import { resolveWorkspaceCodexCompactionDefault } from "@opengeni/contracts";
import {
  assertSessionAllowsProductModel,
  CodexCompactionV2ProviderLockedError,
  CODEX_COMPACTION_V2_PROVIDER_LOCKED,
} from "../src/domain/sessions";

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

describe("assertSessionAllowsProductModel", () => {
  test("allows any model on portable sessions", () => {
    expect(() =>
      assertSessionAllowsProductModel({ codexCompactionMode: "portable" }, "gpt-5"),
    ).not.toThrow();
  });

  test("allows Codex models on remote_v2 sessions", () => {
    expect(() =>
      assertSessionAllowsProductModel({ codexCompactionMode: "remote_v2" }, "codex/gpt-5.4"),
    ).not.toThrow();
  });

  test("rejects non-Codex models on remote_v2 sessions", () => {
    expect(() =>
      assertSessionAllowsProductModel({ codexCompactionMode: "remote_v2" }, "gpt-5"),
    ).toThrow(CodexCompactionV2ProviderLockedError);
    try {
      assertSessionAllowsProductModel({ codexCompactionMode: "remote_v2" }, "gpt-5");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexCompactionV2ProviderLockedError);
      expect((error as CodexCompactionV2ProviderLockedError).code).toBe(
        CODEX_COMPACTION_V2_PROVIDER_LOCKED,
      );
    }
  });
});
