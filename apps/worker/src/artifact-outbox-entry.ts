import { createOutboxSidecarFromEnvironment } from "./editable-artifact-outbox-service";

/** Dedicated process: no Temporal/control worker is created or imported here. */
export async function runEditableArtifactOutboxSidecar(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configured = await createOutboxSidecarFromEnvironment(environment);
  if (!configured) throw new Error("Editable artifact outbox sidecar is disabled");
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: configured.httpPort,
    fetch: configured.service.fetch,
  });
  const stop = () => configured.service.drain("process signal");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await configured.service.run();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    server.stop(true);
    await configured.service.close();
  }
}

if (import.meta.main) {
  await runEditableArtifactOutboxSidecar();
}
