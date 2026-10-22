import { expect, test } from "bun:test";
import { missingLinuxLibraryError } from "../src/cua/sdk";

test("names a library the loader could not find and how to install what CUA needs", () => {
  const error = new Error("CUA SDK failed to start", {
    cause: new Error(
      "dlopen failed: libX11.so.6: cannot open shared object file: No such file or directory",
    ),
  });
  expect(missingLinuxLibraryError(error)).toMatchObject({
    code: "resource_unavailable",
    retryable: false,
    message:
      "this machine can't start computer use because the system library libX11.so.6 can't be loaded. Computer use on Linux needs libX11, libXi and libxkbcommon. On Debian or Ubuntu, install with: sudo apt install libx11-6 libxi6 libxkbcommon0",
  });
});

test("leaves unrelated startup failures alone", () => {
  expect(missingLinuxLibraryError(new Error("CUA worker exited"))).toBeNull();
  expect(missingLinuxLibraryError("spawn failed")).toBeNull();
});
