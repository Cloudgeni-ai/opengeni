import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("native Codemode parses approval receipts and preserves its HTTP contract", async () => {
  const process = Bun.spawn(
    [
      "cargo",
      "test",
      "--locked",
      "--manifest-path",
      "agent/Cargo.toml",
      "-p",
      "opengeni-agent",
      "codemode",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  expect(await process.exited).toBe(0);
}, 600_000);
