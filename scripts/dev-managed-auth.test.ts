import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

test("local managed signing secrets persist without exposing or rotating them", async () => {
  const root = await mkdtemp(join(import.meta.dir, ".managed-auth-test-"));
  const envFile = join(root, "runtime.env");
  try {
    const run = async (environment: string) => {
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          'set -euo pipefail; source "$1"; [ ! -f "$2" ] || source "$2"; opengeni_ensure_local_managed_auth "$2"',
          "bash",
          join(import.meta.dir, "dev-managed-auth.sh"),
          envFile,
        ],
        {
          env: {
            ...process.env,
            OPENGENI_ENVIRONMENT: environment,
            OPENGENI_PRODUCT_ACCESS_MODE: "managed",
            OPENGENI_BETTER_AUTH_SECRET: "",
            OPENGENI_DELEGATION_SECRET: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(error).toBe("");
      return output;
    };
    expect(await run("production")).toBe("");
    expect(await Bun.file(envFile).exists()).toBe(false);
    const output = await run("local");
    const original = await Bun.file(envFile).text();
    const values = original
      .trim()
      .split("\n")
      .map((line) => line.split("=")[1]!);
    expect(values).toHaveLength(2);
    expect(values[0]).not.toBe(values[1]);
    for (const value of values) {
      expect(value.length).toBeGreaterThanOrEqual(43);
      expect(output).not.toContain(value);
    }
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(await run("local")).toBe("");
    expect(await Bun.file(envFile).text()).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
