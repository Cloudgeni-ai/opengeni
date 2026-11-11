import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerPullFailureSummary,
  filesystemCapacity,
  installFailureSummary,
} from "../src/acquisition-diagnostics";

const script = new URL("../src/acquisition-diagnostics.ts", import.meta.url).pathname;
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const lock = JSON.stringify({
  packages: {
    fixture: ["fixture@1.0.0", "", {}, integrity],
    scoped: ["@fixture/package@2.0.0", "", {}, integrity],
    unrelated: ["other-fixture@1.0.0", "", {}, integrity],
  },
});
const prefix = "[acquisition-diagnostic] ";

describe("acquisition failure diagnostics", () => {
  test("reports only lock candidates and never fabricates original archive observations", () => {
    const diagnostic = installFailureSummary(
      "error: IntegrityCheckFailed extracting tarball for fixture\nerror: failed to extract @fixture/package@2.0.0\nhttps://user:SECRET@example.test/file?token=SECRET\nAuthorization: Bearer SECRET",
      lock,
    );
    expect(diagnostic.packages).toEqual([
      { identity: "fixture@1.0.0", expectedIntegrity: integrity },
      { identity: "@fixture/package@2.0.0", expectedIntegrity: integrity },
    ]);
    expect(diagnostic.observedIntegrity).toBeNull();
    expect(diagnostic.receivedBytes).toBeNull();
    expect(diagnostic.httpStatus).toBeNull();
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
    expect(JSON.stringify(diagnostic)).not.toContain("https:");
    expect(diagnostic.originalArchiveObservation).toContain("no-refetch");
    expect(installFailureSummary("error: HTTP/1.1 503", lock).httpStatus).toBe(503);
    expect(installFailureSummary("error: HTTP/1.1 503; status 403", lock).httpStatus).toBeNull();
  });

  test("supports JSONC locks, missing evidence, multiple versions and bounded candidates", () => {
    expect(
      installFailureSummary("error: fixture failed", lock.replace(/}$/, ",}")).lockObservation,
    ).toBe("read");
    expect(installFailureSummary("error: fixture failed", null).lockObservation).toBe(
      "unavailable",
    );
    expect(installFailureSummary("error: fixture failed", "not JSON").packages).toEqual([]);
    expect(installFailureSummary("error: fixture-extra failed", lock).packages).toEqual([]);
    const versions = JSON.stringify({
      packages: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [String(i), [`fixture@1.0.${i}`, "", {}, integrity]]),
      ),
    });
    expect(installFailureSummary("error: fixture failed", versions).packages).toHaveLength(20);
  });

  test("Docker reports explicit phase/status only, without replaying registry messages", () => {
    const diagnostic = dockerPullFailureSummary(
      "failed to fetch anonymous token: unexpected status 403 for https://fixture.test/?token=SECRET",
    );
    expect(diagnostic.rejectionPhase).toBe("token");
    expect(diagnostic.httpStatus).toBe(403);
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
    expect(dockerPullFailureSummary("unauthorized: authentication required").rejectionPhase).toBe(
      "unavailable",
    );
    expect(dockerPullFailureSummary("denied").httpStatus).toBeNull();
    expect(dockerPullFailureSummary("manifest unauthorized HTTP/1.1 401").rejectionPhase).toBe(
      "manifest",
    );
    expect(
      dockerPullFailureSummary("failed to download layer: status code: 403").rejectionPhase,
    ).toBe("layer");
    expect(dockerPullFailureSummary("status 401; status 403").httpStatus).toBeNull();
    expect(diagnostic.daemonDiskObservation).toContain("unavailable");
  });

  test("filesystem failures omit paths and distinguish local capacity from daemon storage", () => {
    expect(filesystemCapacity("/nonexistent/fixture/SECRET")).toEqual({
      availableBytes: null,
      freeInodes: null,
      observation: "unavailable",
    });
    expect(filesystemCapacity(tmpdir()).availableBytes).toMatch(/^\d+$/);
  });

  for (const exitCode of [0, 23]) {
    test(`fixture subprocess preserves exit ${exitCode}, stdout/stderr and single execution`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "acquisition-diagnostic-"));
      try {
        await writeFile(join(dir, "bun.lock"), lock);
        await writeFile(
          join(dir, "fixture.ts"),
          `console.log("fixture-stdout"); console.error("error: fixture failed"); process.exit(${exitCode});`,
        );
        await writeFile(
          join(dir, "runner.ts"),
          `import {observeInstall} from ${JSON.stringify(script)}; await observeInstall([process.execPath, "fixture.ts"]);`,
        );
        const child = Bun.spawn([process.execPath, "runner.ts"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(exitCode);
        expect(stdout).toBe("fixture-stdout\n");
        expect(stderr.match(/error: fixture failed/g)).toHaveLength(1);
        const records = stderr.split("\n").filter((line) => line.startsWith(prefix));
        expect(records).toHaveLength(exitCode === 0 ? 0 : 1);
        if (exitCode !== 0) {
          expect(JSON.parse(records[0]!.slice(prefix.length))).toMatchObject({
            exitCode,
            packages: [{ identity: "fixture@1.0.0", expectedIntegrity: integrity }],
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("CLI preserves real Bun argument failure and does not attempt a second install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acquisition-diagnostic-"));
    try {
      const flag = "--fixture-invalid-install-option";
      const run = async (command: string[]) => {
        const child = Bun.spawn(command, { cwd: dir, stdout: "pipe", stderr: "pipe" });
        return Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
      };
      const original = await run([process.execPath, "install", flag]);
      const observed = await run([process.execPath, script, "--", "bun", "install", flag]);
      expect(original[0]).not.toBe(0);
      expect(observed[0]).toBe(original[0]);
      expect(observed[2]).toContain(prefix);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounded stderr excludes earlier candidates and does not expose environment paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acquisition-diagnostic-"));
    try {
      await writeFile(join(dir, "bun.lock"), lock);
      await writeFile(
        join(dir, "fixture.ts"),
        'console.error("error: fixture failed"); console.error("x".repeat(100_000)); console.error("error: @fixture/package failed"); process.exit(17);',
      );
      await writeFile(
        join(dir, "runner.ts"),
        `import {observeInstall} from ${JSON.stringify(script)}; await observeInstall([process.execPath, "fixture.ts"]);`,
      );
      const child = Bun.spawn([process.execPath, "runner.ts"], {
        cwd: dir,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, "SECRET") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(17);
      const record = stderr.split("\n").find((line) => line.startsWith(prefix))!;
      expect(record).not.toContain("SECRET");
      expect(record).not.toContain(dir);
      expect(JSON.parse(record.slice(prefix.length))).toMatchObject({
        stderrTruncated: true,
        cachePathClass: "environment-override",
        packages: [{ identity: "@fixture/package@2.0.0", expectedIntegrity: integrity }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves child signal termination rather than reporting success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acquisition-diagnostic-"));
    try {
      await writeFile(
        join(dir, "runner.ts"),
        `import {observeInstall} from ${JSON.stringify(script)}; await observeInstall([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);`,
      );
      const child = Bun.spawn([process.execPath, "runner.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(child.signalCode).toBe("SIGTERM");
      expect(stderr).toContain('"signal":"SIGTERM"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("selected canonical install paths retain frozen flags and pre-install helper availability", async () => {
    const root = new URL("../../../", import.meta.url);
    const invocation =
      "bun packages/testing/src/acquisition-diagnostics.ts -- bun install --frozen-lockfile";
    for (const path of [".github/workflows/open-version-pr.yml", ".github/workflows/ci.yml"]) {
      expect(await Bun.file(new URL(path, root)).text()).toContain(invocation);
    }
    const dockerfile = await Bun.file(new URL("docker/sandbox.Dockerfile", root)).text();
    expect(dockerfile.split(invocation)).toHaveLength(3);
    expect(dockerfile.indexOf("COPY packages/testing/src/acquisition-diagnostics.ts")).toBeLessThan(
      dockerfile.indexOf(invocation),
    );
  });
});
