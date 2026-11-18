import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { matchLinuxBrowserArguments } from "../packages/browserd/src/linux-process-identity";

const wrapper = resolve(import.meta.dir, "..", "docker/desktop/opengeni-browser.sh");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Runs the desktop browser wrapper against a stub engine and returns the
 * arguments the engine received. */
async function engineArguments(args: readonly string[]): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-browser-wrapper-"));
  directories.push(directory);
  const received = join(directory, "argv");
  const engine = join(directory, "engine");
  await writeFile(engine, `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(received)}\n`);
  await chmod(engine, 0o755);
  const child = Bun.spawn(["bash", wrapper, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENGENI_BROWSER_BIN: engine,
      OPENGENI_BROWSER_PROFILE: join(directory, "default-profile"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const raw = await readFile(received, "utf8");
  return raw.split("\0").slice(0, -1);
}

describe("desktop browser wrapper", () => {
  test("keeps a caller's own profile as the only profile switch", async () => {
    const profile = join(tmpdir(), "managed-session", "profile");
    const args = await engineArguments(["--remote-debugging-port=0", `--user-data-dir=${profile}`]);

    expect(args.filter((argument) => argument.startsWith("--user-data-dir"))).toEqual([
      `--user-data-dir=${profile}`,
    ]);
    // The managed browser controller identifies its browser by this exact
    // command line; a second profile switch made every launch unprovable.
    expect(
      matchLinuxBrowserArguments({
        argv: ["/opt/browser/chrome", ...args],
        profileDirectory: profile,
        executablePath: "/opt/browser/chrome",
      }),
    ).toBe("arguments");
  });

  test("still gives a plain desktop launch its writable default profile", async () => {
    const args = await engineArguments(["https://example.com"]);

    const profiles = args.filter((argument) => argument.startsWith("--user-data-dir"));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toEndWith("/default-profile");
    expect(args).toContain("--no-sandbox");
    expect(args.at(-1)).toBe("https://example.com");
  });
});
