import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  builderGcConfig,
  builderNodeName,
  developmentSandboxDiskPolicy,
  parseByteSize,
  planDevelopmentSandboxImageRetention,
  processOwnsLease,
  readBuiltImageDigests,
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
    // One full sandbox build keeps roughly 10-14 GB of BuildKit records; a cap
    // below that working set makes every start evict and rebuild the image.
    expect(developmentSandboxDiskPolicy({})).toEqual({
      cacheLimit: "24gb",
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

  async function runPrepare(
    fakeDockerBody: string,
    imageTag = "opengeni-sandbox:local-aaaaaaaaaaaa-test-stack",
    builderMissing = true,
  ) {
    const root = await mkdtemp(join(tmpdir(), "opengeni-sandbox-image-test-"));
    temporaryRoots.push(root);
    const log = join(root, "docker.log");
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
${builderMissing ? 'if [ "$*" = "buildx inspect opengeni-development-sandbox" ]; then exit 1; fi' : ""}
${fakeDockerBody}
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
        imageTag,
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
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = await Bun.file(log).text();
    return { exitCode, stdout, stderr, calls };
  }

  // The fake builder records the digests BuildKit reports for the cached
  // result whenever it is asked for a metadata file.
  const fakeMetadataBuild = `case "$*" in buildx\\ build\\ *--metadata-file\\ *)
  metadata="$(printf '%s\\n' "$*" | sed -E 's/.*--metadata-file ([^ ]+).*/\\1/')"
  printf '{"containerimage.digest":"sha256:%s","containerimage.config.digest":"sha256:%s"}' "$(printf '1%.0s' $(seq 1 64))" "$(printf '2%.0s' $(seq 1 64))" > "$metadata" ;;
esac`;

  test("always builds through the fixed serialized builder and converges cache on both sides", async () => {
    const { exitCode, stderr, calls } = await runPrepare(fakeMetadataBuild);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // A missing builder is created with the explicit GC policy for the cap.
    const node = builderNodeName({ cacheLimit: "24gb", imageRetention: 3 });
    expect(calls).toContain(
      `buildx create --name opengeni-development-sandbox --node ${node} --driver docker-container --buildkitd-config`,
    );
    expect(calls).not.toContain("buildx rm");
    expect(calls).toContain("buildx inspect opengeni-development-sandbox --bootstrap");
    expect(calls.match(/buildx prune/g)).toHaveLength(2);
    expect(calls).toContain(
      "buildx build --builder opengeni-development-sandbox --provenance=false --sbom=false",
    );
    expect(calls).toContain(
      "--output type=image,name=opengeni-sandbox:local-aaaaaaaaaaaa-test-stack,push=false --metadata-file",
    );
    expect(calls).toContain(
      "image inspect --format {{.Id}} opengeni-sandbox:local-aaaaaaaaaaaa-test-stack",
    );
    // The fake daemon holds no such image yet, so the exact result is exported.
    expect(calls).toContain("--load -t opengeni-sandbox:local-aaaaaaaaaaaa-test-stack .");
    expect(calls).toContain("buildx stop opengeni-development-sandbox");
  });

  test("skips the export when the daemon already holds the exact cached result", async () => {
    for (const [store, id] of [
      ["containerd", `sha256:${"1".repeat(64)}`],
      ["classic", `sha256:${"2".repeat(64)}`],
    ] as const) {
      const { exitCode, stdout, stderr, calls } = await runPrepare(
        `${fakeMetadataBuild}
case "$*" in image\\ inspect\\ --format\\ {{.Id}}\\ opengeni-sandbox:*) printf '%s\\n' "${id}" ;; esac`,
      );
      expect(stderr, store).toBe("");
      expect(exitCode, store).toBe(0);
      expect(calls, store).toContain("--metadata-file");
      expect(calls, store).not.toContain("--load");
      expect(stdout, store).toContain("already current");
      expect(calls.match(/buildx prune/g), store).toHaveLength(2);
      expect(calls, store).toContain("buildx stop opengeni-development-sandbox");
    }
  });

  test("exports again when the daemon holds a different image under the same tag", async () => {
    const { exitCode, calls } = await runPrepare(
      `${fakeMetadataBuild}
case "$*" in image\\ inspect\\ --format\\ {{.Id}}\\ opengeni-sandbox:*) printf 'sha256:%s\\n' "$(printf '3%.0s' $(seq 1 64))" ;; esac`,
    );
    expect(exitCode).toBe(0);
    expect(calls).toContain("--load -t opengeni-sandbox:local-aaaaaaaaaaaa-test-stack .");
  });

  test("keeps a builder whose node already carries the configured GC policy", async () => {
    const node = builderNodeName({ cacheLimit: "24gb", imageRetention: 3 });
    const { exitCode, stderr, calls } = await runPrepare(
      `case "$*" in "buildx inspect opengeni-development-sandbox") printf 'Name:          opengeni-development-sandbox\nDriver:        docker-container\n\nNodes:\nName:                  ${node}\nEndpoint:              desktop-linux\n'; exit 0 ;; esac`,
      undefined,
      false,
    );
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(calls).not.toContain("buildx create");
    expect(calls).not.toContain("buildx rm");
  });

  test("recreates a builder whose GC policy no longer matches the configured cap", async () => {
    const staleNode = builderNodeName({ cacheLimit: "6gb", imageRetention: 3 });
    const node = builderNodeName({ cacheLimit: "24gb", imageRetention: 3 });
    const { exitCode, stdout, calls } = await runPrepare(
      `case "$*" in "buildx inspect opengeni-development-sandbox") printf 'Name:          opengeni-development-sandbox\n\nNodes:\nName:                  ${staleNode}\n'; exit 0 ;; esac`,
      undefined,
      false,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recreating the OpenGeni sandbox builder");
    const removal = calls.indexOf("buildx rm --force opengeni-development-sandbox");
    const create = calls.indexOf(
      `buildx create --name opengeni-development-sandbox --node ${node}`,
    );
    expect(removal).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(removal);
  });

  test("falls back to the legacy --config flag on older buildx plugins", async () => {
    const { exitCode, stderr, calls } = await runPrepare(
      `${fakeMetadataBuild}
case "$*" in buildx\\ create\\ *--buildkitd-config\\ *) echo "unknown flag: --buildkitd-config" >&2; exit 125 ;; esac`,
    );
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const modern = calls.indexOf("--buildkitd-config");
    const legacy = calls.indexOf("--driver docker-container --config ");
    expect(modern).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(modern);
  });

  test("renders one explicit GC policy equal to the cap and parses go-units sizes", () => {
    const config = builderGcConfig({ cacheLimit: "24gb", imageRetention: 3 });
    expect(config).toContain("[worker.oci]");
    expect(config).toContain("gc = true");
    expect(config).toContain('reservedSpace = "24gb"');
    expect(config).toContain('maxUsedSpace = "24gb"');
    expect(builderNodeName({ cacheLimit: "24gb", imageRetention: 3 })).not.toBe(
      builderNodeName({ cacheLimit: "6gb", imageRetention: 3 }),
    );
    expect(parseByteSize("24gb")).toBe(24 * 1024 ** 3);
    expect(parseByteSize("512MiB")).toBe(512 * 1024 ** 2);
    expect(parseByteSize("1.5GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(() => parseByteSize("lots")).toThrow("Unsupported byte size");
  });

  test("reads only well-formed digests from the builder metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-sandbox-image-metadata-"));
    temporaryRoots.push(root);
    const metadataFile = join(root, "metadata.json");
    expect(await readBuiltImageDigests(metadataFile)).toEqual(new Set());
    await writeFile(metadataFile, "not json");
    expect(await readBuiltImageDigests(metadataFile)).toEqual(new Set());
    await writeFile(
      metadataFile,
      JSON.stringify({
        "containerimage.digest": `sha256:${"1".repeat(64)}`,
        "containerimage.config.digest": "sha256:short",
        "buildx.build.ref": "builder/node/ref",
      }),
    );
    expect(await readBuiltImageDigests(metadataFile)).toEqual(
      new Set([`sha256:${"1".repeat(64)}`]),
    );
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
      // Each contender resolves the cached result and then exports it (two
      // builder invocations); the maintenance lock keeps them from interleaving.
      expect(phases).toHaveLength(8);
      expect(phases.filter((_, index) => index % 2 === 0)).toEqual(Array(4).fill("BEGIN"));
      expect(phases.filter((_, index) => index % 2 === 1)).toEqual(Array(4).fill("END"));
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
