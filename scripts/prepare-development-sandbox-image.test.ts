import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  developmentSandboxDiskPolicy,
  planDevelopmentSandboxImageRetention,
  processOwnsLease,
} from "./prepare-development-sandbox-image";

const image = (id: string, createdAt: string, tags: string[], managed = false) => ({
  id,
  createdAt,
  tags,
  managed,
});
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("development sandbox image disk policy", () => {
  test("uses a dedicated bounded builder and a small source-image history by default", () => {
    expect(developmentSandboxDiskPolicy({})).toEqual({
      cacheLimit: "6gb",
      imageRetention: 3,
    });
  });

  test("rejects ambiguous or unbounded policy values", () => {
    expect(() =>
      developmentSandboxDiskPolicy({ OPENGENI_DEV_SANDBOX_IMAGE_RETENTION: "0" }),
    ).toThrow("positive integer");
    expect(() =>
      developmentSandboxDiskPolicy({ OPENGENI_DEV_SANDBOX_IMAGE_RETENTION: "03" }),
    ).toThrow("positive integer");
    expect(() =>
      developmentSandboxDiskPolicy({ OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX: "unbounded" }),
    ).toThrow("positive byte size");
  });

  test("keeps the current, newest, and container-owned images while retiring only source tags", () => {
    const plan = planDevelopmentSandboxImageRetention(
      [
        image("sha256:current", "2026-08-21T08:00:00Z", [
          "opengeni-sandbox:local-aaaaaaaaaaaa-current",
        ]),
        image("sha256:newest", "2026-08-21T09:00:00Z", [
          "opengeni-sandbox:local-bbbbbbbbbbbb-newest",
        ]),
        image("sha256:container", "2026-08-20T09:00:00Z", [
          "opengeni-sandbox:local-cccccccccccc-container",
        ]),
        image("sha256:old", "2026-08-19T09:00:00Z", ["opengeni-sandbox:local-dddddddddddd-old"]),
        image("sha256:manual", "2026-08-18T09:00:00Z", ["opengeni-sandbox:local"]),
        image("sha256:foreign", "2026-08-17T09:00:00Z", ["another/image:local-eeeeeeeeeeee"]),
        image("sha256:dangling-managed", "2026-08-16T09:00:00Z", [], true),
        image("sha256:dangling-foreign", "2026-08-15T09:00:00Z", []),
      ],
      new Set(["sha256:container"]),
      "opengeni-sandbox:local-aaaaaaaaaaaa-current",
      2,
    );

    expect(plan.keepImageIds).toEqual(["sha256:container", "sha256:current", "sha256:newest"]);
    expect(plan.removeImageIds).toEqual(["sha256:dangling-managed"]);
    expect(plan.removeTags).toEqual(["opengeni-sandbox:local-dddddddddddd-old"]);
  });

  test("can free one history slot before a build without deleting an in-use image", () => {
    const plan = planDevelopmentSandboxImageRetention(
      [
        image("sha256:new", "2026-08-21T09:00:00Z", ["opengeni-sandbox:local-111111111111-new"]),
        image("sha256:old", "2026-08-20T09:00:00Z", ["opengeni-sandbox:local-222222222222-old"]),
      ],
      new Set(["sha256:old"]),
      "opengeni-sandbox:local-333333333333-current",
      0,
    );
    expect(plan.keepImageIds).toEqual(["sha256:old"]);
    expect(plan.removeImageIds).toEqual([]);
    expect(plan.removeTags).toEqual(["opengeni-sandbox:local-111111111111-new"]);
  });

  test("always builds through the fixed serialized builder and converges cache on both sides", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-sandbox-image-test-"));
    temporaryRoots.push(root);
    const log = join(root, "docker.log");
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$*" = "buildx inspect opengeni-development-sandbox" ]; then exit 1; fi
exit 0
`,
    );
    await chmod(docker, 0o755);
    const script = new URL("./prepare-development-sandbox-image.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        "bun",
        script,
        "--repository-root",
        new URL("..", import.meta.url).pathname,
        "--image",
        "opengeni-sandbox:local-aaaaaaaaaaaa-test-stack",
        "--runtime-bundle",
        ".opengeni/no-artifact-runtime-for-this-source",
        "--source-sha",
        "a".repeat(40),
        "--lease-id",
        "test-stack",
        "--lease-pid",
        String(process.pid),
        "--lease-token",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ],
      {
        env: {
          ...Bun.env,
          PATH: `${root}:${Bun.env.PATH ?? ""}`,
          TMPDIR: root,
          FAKE_DOCKER_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const calls = await Bun.file(log).text();
    expect(calls).toContain("buildx create --name opengeni-development-sandbox");
    expect(calls).toContain("buildx inspect opengeni-development-sandbox --bootstrap");
    expect(calls.match(/buildx prune/g)).toHaveLength(2);
    expect(calls).toContain("buildx build --builder opengeni-development-sandbox --load");
    expect(calls).toContain("buildx stop opengeni-development-sandbox");
    expect(calls).not.toContain("image inspect opengeni-sandbox");
  });

  test("still converges the dedicated cache and stops the builder after a failed build", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-sandbox-image-failure-test-"));
    temporaryRoots.push(root);
    const log = join(root, "docker.log");
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$*" = "buildx inspect opengeni-development-sandbox" ]; then exit 1; fi
case "$*" in buildx\\ build\\ *) exit 27 ;; esac
exit 0
`,
    );
    await chmod(docker, 0o755);
    const script = new URL("./prepare-development-sandbox-image.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        "bun",
        script,
        "--repository-root",
        new URL("..", import.meta.url).pathname,
        "--image",
        "opengeni-sandbox:local-bbbbbbbbbbbb-failed-stack",
        "--runtime-bundle",
        ".opengeni/no-artifact-runtime-for-this-source",
        "--source-sha",
        "b".repeat(40),
        "--lease-id",
        "failed-stack",
        "--lease-pid",
        String(process.pid),
        "--lease-token",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
      {
        env: {
          ...Bun.env,
          PATH: `${root}:${Bun.env.PATH ?? ""}`,
          TMPDIR: root,
          FAKE_DOCKER_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await child.exited;
    expect(exitCode).not.toBe(0);
    const calls = await Bun.file(log).text();
    expect(calls.match(/buildx prune/g)).toHaveLength(2);
    expect(calls).toContain("buildx stop opengeni-development-sandbox");
  });

  test("rejects a reused PID unless the exact process-incarnation token is still present", async () => {
    const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const child = Bun.spawn(
      ["bun", "-e", "await Bun.sleep(30_000)", `--opengeni-dev-stack-token=${token}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      expect(await processOwnsLease(child.pid, token)).toBe(true);
      expect(await processOwnsLease(child.pid, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(await processOwnsLease(child.pid, token)).toBe(false);
  });

  test("serializes two contenders and leaves one exact live replacement lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-sandbox-image-contention-test-"));
    temporaryRoots.push(root);
    const log = join(root, "docker.log");
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
if [ "$*" = "buildx inspect opengeni-development-sandbox" ]; then exit 1; fi
case "$*" in
  buildx\\ build\\ *)
    printf 'BEGIN %s\\n' "$*" >> "$FAKE_DOCKER_LOG"
    sleep 0.2
    printf 'END %s\\n' "$*" >> "$FAKE_DOCKER_LOG"
    ;;
esac
exit 0
`,
    );
    await chmod(docker, 0o755);
    const tokens = [
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ] as const;
    const holders = tokens.map((token) =>
      Bun.spawn(["bun", "-e", "await Bun.sleep(30_000)", `--opengeni-dev-stack-token=${token}`], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const script = new URL("./prepare-development-sandbox-image.ts", import.meta.url).pathname;
    const contenders = tokens.map((token, index) =>
      Bun.spawn(
        [
          "bun",
          script,
          "--repository-root",
          new URL("..", import.meta.url).pathname,
          "--image",
          `opengeni-sandbox:local-${index === 0 ? "c" : "d"}${"a".repeat(11)}-shared-stack`,
          "--runtime-bundle",
          ".opengeni/no-artifact-runtime-for-this-source",
          "--source-sha",
          (index === 0 ? "c" : "d").repeat(40),
          "--lease-id",
          "shared-stack",
          "--lease-pid",
          String(holders[index]!.pid),
          "--lease-token",
          token,
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${root}:${Bun.env.PATH ?? ""}`,
            TMPDIR: root,
            FAKE_DOCKER_LOG: log,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    try {
      expect(await Promise.all(contenders.map((child) => child.exited))).toEqual([0, 0]);
      const phases = (await Bun.file(log).text())
        .split("\n")
        .filter((line) => /^(?:BEGIN|END) /u.test(line))
        .map((line) => line.split(" ", 1)[0]);
      expect(phases).toEqual(["BEGIN", "END", "BEGIN", "END"]);
      const lease = (await Bun.file(
        join(root, "opengeni-development-sandbox-maintenance", "leases", "shared-stack.json"),
      ).json()) as { pid: number; token: string };
      expect(tokens).toContain(lease.token as (typeof tokens)[number]);
      expect(await processOwnsLease(lease.pid, lease.token)).toBe(true);
    } finally {
      for (const child of [...contenders, ...holders]) child.kill();
      await Promise.all([...contenders, ...holders].map((child) => child.exited));
    }
  });
});
