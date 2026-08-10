import { createMaterializerSidecarFromEnvironment } from "./editable-artifact-materializer-service";

/**
 * Dedicated editable-artifact materializer process. This entry deliberately
 * does not import/create a Temporal worker and is never called by control/turn
 * startup. Deploy it as a separate sidecar/service with its own DSN.
 */
export async function runEditableArtifactMaterializerSidecar(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configured = await createMaterializerSidecarFromEnvironment(environment);
  if (!configured) {
    throw new Error("Editable artifact materializer sidecar is disabled");
  }
  const server = Bun.serve({
    hostname: configured.httpHostname,
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
  await runEditableArtifactMaterializerSidecar();
}
