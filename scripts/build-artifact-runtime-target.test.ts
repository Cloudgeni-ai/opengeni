import { describe, expect, test } from "bun:test";

import { artifactRuntimeNativeCargoEnvironment } from "./build-artifact-runtime-target";

describe("artifact runtime native build environment", () => {
  test("builds both musl targets as loadable dynamic libraries", () => {
    for (const target of ["linux-x64-musl", "linux-arm64-musl"] as const) {
      expect(artifactRuntimeNativeCargoEnvironment(target)).toEqual({
        CARGO_ENCODED_RUSTFLAGS: "-Ctarget-feature=-crt-static",
      });
    }
  });

  test("does not alter GNU, Darwin, or Windows targets", () => {
    for (const target of [
      "linux-x64-gnu",
      "linux-arm64-gnu",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64-msvc",
    ] as const) {
      expect(artifactRuntimeNativeCargoEnvironment(target)).toEqual({});
    }
  });

  test("rejects the browser target", () => {
    expect(() => artifactRuntimeNativeCargoEnvironment("wasm-web")).toThrow(
      "Target wasm-web is not native",
    );
  });
});
