import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshSdkMajor } from "./refresh-sdk-major";

test("refreshes only the snapshot sdkMajor line from the lockstep SDK version", () => {
  const snapshot =
    '{\n  "schemaVersion": 1,\n  "sdkMajor": 1,\n  "routes": [\n    { "sdkMajor": 9 }\n  ]\n}\n';
  expect(refreshSdkMajor(snapshot, "2.0.0")).toBe(
    '{\n  "schemaVersion": 1,\n  "sdkMajor": 2,\n  "routes": [\n    { "sdkMajor": 9 }\n  ]\n}\n',
  );
  expect(refreshSdkMajor(snapshot, "1.4.4")).toBe(snapshot);
  expect(() => refreshSdkMajor(snapshot, "next")).toThrow("invalid SDK version");
  expect(() => refreshSdkMajor("{}\n", "2.0.0")).toThrow("no top-level sdkMajor");
});

test("the committed snapshot already matches the committed SDK major", () => {
  const root = join(import.meta.dir, "..", "..");
  const snapshot = readFileSync(join(root, "scripts/public-api/surface.gen.json"), "utf8");
  const sdkVersion = (
    JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  expect(refreshSdkMajor(snapshot, sdkVersion)).toBe(snapshot);
});
