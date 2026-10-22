import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test.each([
  "acquireSharedTestDatabase",
  "acquireBlankTestDatabase",
  "acquireOwnerMigratedTestDatabase",
])(
  "%s fails required runs rather than silently skipping unavailable PostgreSQL",
  async (acquire) => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-required-pg-"));
    try {
      for (const required of ["0", "1"]) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `const { ${acquire} } = await import("@opengeni/testing/shared-pg"); console.log(JSON.stringify(await ${acquire}("unavailable-contract")));`,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              // No Docker on PATH and no shared fixture/lock state. Never contact
              // or mutate the machine's real PostgreSQL or Docker installation.
              PATH: directory,
              TMPDIR: directory,
              OPENGENI_TEST_PG_URL: undefined,
              OPENGENI_TEST_PG_NATIVE: undefined,
              OPENGENI_REQUIRE_REAL_DB: required,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (required === "1") {
          expect(exitCode).not.toBe(0);
          expect(stderr).toContain(
            "OPENGENI_REQUIRE_REAL_DB=1 but disposable PostgreSQL is unavailable",
          );
          expect(stdout).toBe("");
        } else {
          expect(exitCode).toBe(0);
          expect(stdout.trim()).toBe("null");
          expect(stderr).toBe("");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  // Each child intentionally exhausts the fixture's bounded Docker retry path.
  // Match the canonical unit runner when this file is run directly as well.
  30_000,
);

test("dedicated-schema proof fails when its required PostgreSQL fixture is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-required-dedicated-pg-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "test",
        "./packages/db/test/rls-dedicated-schema-isolation.test.ts",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: directory,
          TMPDIR: directory,
          OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL: undefined,
          OPENGENI_REQUIRE_REAL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain(
      "OPENGENI_REQUIRE_REAL_DB=1 but dedicated-schema PostgreSQL is unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
