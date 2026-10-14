// Disposable local infrastructure only. Never source deployment credentials.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startTestServices } from "../../../packages/testing/src/compose";
import { provisionRoles } from "@opengeni/db/provision-roles";
import postgres from "postgres";

const state = resolve(import.meta.dir, ".state");
await mkdir(`${state}/tmp`, { recursive: true });
process.env.TMPDIR = `${state}/tmp`;
const services = await startTestServices({ temporal: true, objectStorage: true });
await Bun.write(`${state}/stack.json`, JSON.stringify(services, null, 2));
try {
  // The test Temporal container and app share PostgreSQL. Preserve all normal
  // application pool sizes; give this disposable fixture enough connections.
  const sql = postgres(services.databaseUrl, { max: 1 });
  await sql.unsafe("ALTER SYSTEM SET max_connections = '250'");
  await sql.end();
  const restart = Bun.spawn(["docker", "restart", `${services.projectName}-postgres-1`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await restart.exited) !== 0) throw new Error("Fixture PostgreSQL restart failed");
  for (let attempt = 0; ; attempt++) {
    const probe = postgres(services.databaseUrl, { max: 1, connect_timeout: 2 });
    try {
      await probe`select 1`;
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await Bun.sleep(200);
    } finally {
      await probe.end();
    }
  }
  await services.migrate();
  await provisionRoles(services.databaseUrl, {
    appPassword: "opengeni_app",
    artifactOutboxDispatcherPassword: "experiment",
    artifactMaterializerPassword: "experiment",
  });
  console.log(JSON.stringify({ ready: true, project: services.projectName }));
  // The generic fixture helper retains deadline timers after successful
  // startup. This setup command deliberately hands ownership to stack.json.
  process.exit(0);
} catch (error) {
  await services.down();
  throw error;
}
