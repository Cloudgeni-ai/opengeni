import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseOpenSandboxConformanceArgs } from "./opensandbox-conformance";
import { executeBounded, parseOpenSandboxLoadArgs, percentile } from "./opensandbox-load-profile";
import {
  forbiddenEnvironmentNames,
  parseOpenSandboxClusterVerificationArgs,
} from "./verify-opensandbox-cluster";

const IMAGE = `registry.example.test/sandbox@sha256:${"a".repeat(64)}`;

describe("OpenSandbox operator harnesses", () => {
  test("parses immutable conformance and bounded load inputs", () => {
    expect(
      parseOpenSandboxConformanceArgs(["--api-key", "key", "--image", IMAGE], {}),
    ).toMatchObject({ ttlSeconds: 3600, image: IMAGE });
    expect(
      parseOpenSandboxLoadArgs(
        ["--profile", "500", "--tier", "cold-node", "--api-key", "key", "--image", IMAGE],
        {},
      ),
    ).toMatchObject({ profile: "500", count: 500, tier: "cold-node" });
    expect(() =>
      parseOpenSandboxLoadArgs(["--api-key", "key", "--image", "moving:latest"], {}),
    ).toThrow("immutable OCI digest");
    expect(
      parseOpenSandboxLoadArgs(
        [
          "--tier",
          "warm-pool",
          "--pool-ref",
          "opengeni-warm",
          "--api-key",
          "key",
          "--image",
          IMAGE,
        ],
        {},
      ),
    ).toMatchObject({ tier: "warm-pool", poolRef: "opengeni-warm" });
    expect(() =>
      parseOpenSandboxLoadArgs(["--tier", "warm-pool", "--api-key", "key", "--image", IMAGE], {}),
    ).toThrow("requires --pool-ref");
    expect(() =>
      parseOpenSandboxLoadArgs(
        ["--pool-ref", "opengeni-warm", "--api-key", "key", "--image", IMAGE],
        {},
      ),
    ).toThrow("requires --tier warm-pool");
  });

  test("bounds load concurrency and computes nearest-rank percentiles", async () => {
    let active = 0;
    let peak = 0;
    await executeBounded(31, 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active -= 1;
    });
    expect(peak).toBe(4);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
  });

  test("detects forbidden control-plane credentials in sandbox Pod env", () => {
    expect(
      forbiddenEnvironmentNames({
        items: [
          {
            spec: {
              containers: [{ env: [{ name: "SAFE" }, { name: "OPENGENI_DATABASE_URL" }] }],
            },
          },
        ],
      }),
    ).toEqual(["OPENGENI_DATABASE_URL"]);
    expect(parseOpenSandboxClusterVerificationArgs(["--expect-zero"])).toMatchObject({
      expectZero: true,
      namespace: "opensandbox",
    });
  });

  test("chart preparation reserves stdout for the packaged chart path", async () => {
    const script = await readFile(resolve(import.meta.dir, "prepare-opensandbox-chart.sh"), "utf8");

    expect(script.match(/sha256sum -c - >&2/g)).toHaveLength(5);
    expect(script).toContain('helm lint "$chart_dir" >&2');
    expect(script.trimEnd()).toEndWith("printf '%s\\n' \"$chart_archive\"");
  });
});
