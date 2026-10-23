#!/usr/bin/env bun

/** Unknown installer failures are operational holds, not speculative PR blame.
 * Bun's explicit frozen-lockfile mismatch is a deterministic source verdict. */
export function classifyInstallExit(exitCode: number, output: string): number {
  if (exitCode === 0) return 0;
  if (exitCode === 130 || exitCode === 143 || exitCode >= 128) return exitCode;
  return /lockfile had changes, but lockfile is frozen/i.test(output) ? 1 : 75;
}

if (import.meta.main) {
  const phase = process.argv[2];
  // Syntax/import failures are candidate code failures, not unavailable Docker.
  const acquireBlankTestDatabase =
    phase === "postgres"
      ? (await import("../../packages/testing/src/shared-pg")).acquireBlankTestDatabase
      : undefined;
  try {
    if (phase === "install") {
      const child = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "inherit",
      });
      let diagnostic = "";
      const consume = async (
        stream: ReadableStream<Uint8Array>,
        destination: NodeJS.WriteStream,
      ) => {
        for await (const bytes of stream) {
          const text = new TextDecoder().decode(bytes);
          diagnostic = (diagnostic + text).slice(-65536);
          destination.write(bytes);
        }
      };
      await Promise.all([
        consume(child.stdout, process.stdout),
        consume(child.stderr, process.stderr),
      ]);
      process.exit(classifyInstallExit(await child.exited, diagnostic));
    } else if (phase === "postgres") {
      // Exercise container/image/server setup before attributing test assertions.
      // Blank acquisition does not apply candidate migrations; those stay tests.
      const fixture = await acquireBlankTestDatabase!("batch-infrastructure");
      if (!fixture) throw new Error("Real PostgreSQL fixture is unavailable");
      await recordPostgresIdentity(fixture.databaseUrl);
      await fixture.release();
    } else throw new Error("usage: batch-setup.ts install|postgres");
  } catch (error) {
    console.error(
      "Batch setup could not complete:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(75);
  }
}

/** Comparison evidence only: a failure to record never changes the setup verdict. */
async function recordPostgresIdentity(adminUrl: string): Promise<void> {
  const path = process.env.BATCH_POSTGRES_EVIDENCE;
  if (!path) return;
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(adminUrl, { max: 1 });
    try {
      const [row] = await sql<{ version: string }[]>`select version() as version`;
      if (row?.version)
        (await import("node:fs")).writeFileSync(
          path,
          JSON.stringify({ serverVersion: row.version }) + "\n",
        );
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (error) {
    console.error(
      "PostgreSQL identity not recorded:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
