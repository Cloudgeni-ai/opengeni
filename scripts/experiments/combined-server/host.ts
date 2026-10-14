// EXPERIMENT ONLY. Not a supported deployment entrypoint; do not ship or merge.
import type { OpenGeniWorkerService } from "../../../apps/worker/src/index";
import { resolve } from "node:path";

const selected = process.argv[2];
const roles =
  selected === "combined"
    ? ["control", "turn", "materializer", "outbox", "api", "web"]
    : selected === "workers"
      ? ["control", "turn"]
      : [selected];
const workers: OpenGeniWorkerService[] = [];
const services: Array<{ drain(reason?: string): unknown; close(): Promise<void> }> = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];
const running: Promise<void>[] = [];
let api: { close(): Promise<void> } | undefined;
let apiFatal: { markRunning(): void; dispose(): void } | undefined;
let stopping = false;
let failed = false;
let done!: () => void;
const stopped = new Promise<void>((resolveDone) => {
  done = resolveDone;
});

async function stop() {
  if (stopping) return;
  stopping = true;
  // Close public admission first. Keep worker-owned DB/NATS alive through drain.
  await api?.close();
  for (const server of servers) server.stop(true);
  for (const worker of workers) worker.drain("experiment host shutdown");
  for (const service of services) service.drain("experiment host shutdown");
  await Promise.allSettled(running);
  await Promise.allSettled(services.map((service) => service.close()));
  apiFatal?.dispose();
  done();
}

function watch(promise: Promise<void>) {
  const watched = promise
    .then(() => {
      if (!stopping) {
        console.error("Experiment role exited without a host drain; stopping peers");
        failed = true;
        void stop();
      }
    })
    .catch((error) => {
      console.error(error);
      failed = true;
      void stop();
    });
  running.push(watched);
}

process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
if (process.env.EXPERIMENT_FAULT === "rejection" && roles.includes("turn")) {
  process.on("SIGUSR1", () => {
    void Promise.reject(new Error("experiment detached worker rejection"));
  });
}
try {
  for (const role of roles) {
    if (role === "api") {
      const { startApi } = await import("../../../apps/api/src/index");
      const { getSettings } = await import("@opengeni/config");
      const { createObservability } = await import("@opengeni/observability");
      const settings = getSettings();
      const observability = createObservability(settings, { component: "api" });
      const { installApiFatalProcessBoundary } =
        await import("../../../apps/api/src/fatal-process-boundary");
      // Preserve the API's real failure policy. In combined mode this also
      // catches detached worker failures: an intentional risk to measure,
      // not something the prototype silently papers over.
      apiFatal = installApiFatalProcessBoundary({ observability });
      if (process.env.EXPERIMENT_DIAGNOSTICS === "true") {
        const record = observability.recordFailureDiagnostic.bind(observability);
        observability.recordFailureDiagnostic = (input) => {
          console.error("Local fixture diagnostic", input.error);
          return record(input);
        };
      }
      api = await startApi({ settings, observability });
      apiFatal.markRunning();
    } else if (role === "control" || role === "turn") {
      const { startWorker } = await import("../../../apps/worker/src/index");
      const { getSettings } = await import("@opengeni/config");
      const settings = {
        ...getSettings(),
        workerHttpPort: Number(process.env[`EXPERIMENT_${role.toUpperCase()}_PORT`]),
      };
      let runtime;
      if (role === "turn" && process.env.EXPERIMENT_HTTP_MODEL !== "true") {
        const { createProductionAgentRuntime } = await import("@opengeni/runtime");
        const { ExperimentModel } = await import("./model");
        runtime = createProductionAgentRuntime({ model: new ExperimentModel() });
      }
      let ready!: () => void;
      let reject!: (reason: unknown) => void;
      const created = new Promise<void>((resolveReady, rejectReady) => {
        ready = resolveReady;
        reject = rejectReady;
      });
      watch(
        startWorker({
          role,
          settings,
          runtime,
          shutdownSignals: false,
          onService(service) {
            workers.push(service);
            ready();
          },
        }).catch((error) => {
          reject(error);
          throw error;
        }),
      );
      await created;
    } else if (role === "materializer" || role === "outbox") {
      const configured =
        role === "materializer"
          ? await (
              await import("../../../apps/worker/src/editable-artifact-materializer-service")
            ).createMaterializerSidecarFromEnvironment()
          : await (
              await import("../../../apps/worker/src/editable-artifact-outbox-service")
            ).createOutboxSidecarFromEnvironment();
      if (!configured) throw new Error(`${role} unexpectedly disabled`);
      services.push(configured.service);
      servers.push(
        Bun.serve({
          hostname: "127.0.0.1",
          port: configured.httpPort,
          fetch: configured.service.fetch,
        }),
      );
      watch(configured.service.run());
    } else if (role === "web") {
      const { createWebHandler } = await import("../../../apps/web/src/server");
      const root = resolve(process.env.EXPERIMENT_WEB_ROOT!);
      servers.push(
        Bun.serve({
          hostname: "127.0.0.1",
          port: Number(process.env.EXPERIMENT_WEB_PORT),
          fetch: createWebHandler(root),
        }),
      );
    } else throw new Error(`Unknown experiment role ${role}`);
  }
  console.log(JSON.stringify({ experimentReady: selected, pid: process.pid }));
  await stopped;
} catch (error) {
  failed = true;
  console.error(error);
  await stop();
}
process.exit(failed ? 1 : 0);
