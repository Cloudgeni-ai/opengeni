import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("Proton Pass requires an explicitly configured absolute executable", () => {
  expect(getSettings({}).protonPassCliPath).toBeUndefined();
  expect(getSettings({ OPENGENI_PROTON_PASS_CLI_PATH: "/opt/proton/pass-cli" }).protonPassCliPath).toBe("/opt/proton/pass-cli");
  expect(getSettings({ OPENGENI_PROTON_PASS_CLI_PATH: "C:\\Tools\\pass-cli.exe" }).protonPassCliPath).toBe("C:\\Tools\\pass-cli.exe");
  expect(() => getSettings({ OPENGENI_PROTON_PASS_CLI_PATH: "pass-cli" })).toThrow();
  expect(() => getSettings({ OPENGENI_PROTON_PASS_CLI_PATH: "./pass-cli" })).toThrow();
});
