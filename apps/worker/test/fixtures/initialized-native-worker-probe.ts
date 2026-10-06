// Child-process diagnostic only. Never import this fixture into a worker host.
// Its loopback server supplies no tasks, and process exit owns final reclamation
// when the pinned SDK cannot dispose an initialized worker using public APIs.
import { spyOn } from "bun:test";
import { createRequire } from "node:module";
import { Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { createObservability } from "@opengeni/observability";
import { createOpenGeniWorkerService } from "../../src";
import * as workerHttp from "../../src/http";

const mode = process.argv[2];
if (!["initialized", "service-close", "startup-failure", "immediate-shutdown"].includes(mode ?? "")) {
  throw new Error("unknown initialized-worker probe mode");
}
setTimeout(() => process.exit(2), 10_000).unref();
Runtime.install({ logger: new DefaultLogger("ERROR", () => {}) });

const sdkRequire = createRequire(import.meta.resolve("@temporalio/client"));
const grpc = sdkRequire("@grpc/grpc-js");
const proto = sdkRequire("@temporalio/proto").temporal.api.workflowservice.v1;
const namespace = "initialized-worker-probe";
const taskQueue = "isolated-no-work-turns";
const server = new grpc.Server();
const polls = { activity: 0, workflow: 0 };
const service: Record<string, unknown> = {};
const handlers: Record<string, unknown> = {};
const rpc = (
  name: string,
  handler: (call: any, reply: (error: unknown, response?: unknown) => void) => void,
) => {
  const capitalized = name[0]!.toUpperCase() + name.slice(1);
  const request = proto[`${capitalized}Request`];
  const response = proto[`${capitalized}Response`];
  service[name] = {
    path: `/temporal.api.workflowservice.v1.WorkflowService/${capitalized}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (value: unknown) => Buffer.from(request.encode(value).finish()),
    requestDeserialize: (value: Buffer) => request.decode(value),
    responseSerialize: (value: unknown) => Buffer.from(response.encode(value).finish()),
    responseDeserialize: (value: Buffer) => response.decode(value),
  };
  handlers[name] = handler;
};
rpc("getSystemInfo", (_call, reply) => reply(null, {}));
rpc("describeNamespace", (_call, reply) => reply(null, {
  namespaceInfo: { name: namespace, id: "11111111-1111-4111-8111-111111111111", state: 1 },
  config: { workflowExecutionRetentionTtl: { seconds: 86_400 } },
}));
rpc("describeTaskQueue", (_call, reply) => reply(null, { stats: { approximateBacklogCount: 0 } }));
rpc("pollActivityTaskQueue", () => { polls.activity++; }); // No tasks, deliberately never reply.
rpc("pollWorkflowTaskQueue", () => { polls.workflow++; });
server.addService(service, handlers);
const port = await new Promise<number>((resolve, reject) => {
  server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error: unknown, boundPort: number) => {
    if (error) reject(error);
    else resolve(boundPort);
  });
});
const address = `127.0.0.1:${port}`;
const errors: string[] = [];
const errorSummary = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  // Only retain known diagnostic outcomes, never arbitrary SDK/config errors.
  if (message === "Not running. Current state: INITIALIZED") return message;
  if (message === "Cannot close connection while Workers hold a reference to it") return message;
  if (message === "worker shutdown request failed") return message;
  if (message === "fixture HTTP startup failed") return message;
  return error instanceof Error ? error.name : "unexpected fixture error";
};
let jsCloses = 0;
let nativeCloses = 0;
const originalJsClose = Connection.prototype.close;
spyOn(Connection.prototype, "close").mockImplementation(async function (this: Connection) {
  jsCloses++;
  await originalJsClose.call(this);
});
const originalNativeClose = NativeConnection.prototype.close;
spyOn(NativeConnection.prototype, "close").mockImplementation(async function (this: NativeConnection) {
  nativeCloses++;
  try {
    await originalNativeClose.call(this);
  } catch (error) {
    errors.push(errorSummary(error));
    throw error;
  }
});
const workers: Worker[] = [];
const originalCreate = Worker.create.bind(Worker);
spyOn(Worker, "create").mockImplementation(async (options) => {
  const worker = await originalCreate(options); // Actual SDK + native Rust worker, not a stub.
  workers.push(worker);
  return worker;
});
let closeResult = "not attempted";
let pollIssuedBeforeShutdown: boolean | undefined;
let serviceState: string | undefined;
try {
  if (mode === "initialized" || mode === "immediate-shutdown") {
    const connection = await NativeConnection.connect({ address });
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      activities: { noop: async () => {} },
      maxConcurrentActivityTaskExecutions: 1,
    });
    if (mode === "initialized") {
      try { worker.shutdown(); } catch (error) { errors.push(errorSummary(error)); }
      try { await connection.close(); } catch { /* Outcome recorded by the public close hook. */ }
      closeResult = "initialized ownership retained";
    } else {
      const running = worker.run();
      pollIssuedBeforeShutdown = worker.getStatus().hasOutstandingActivityPoll;
      worker.shutdown();
      await running;
      await connection.close();
      closeResult = "closed after starting native polling";
    }
  } else {
    if (mode === "startup-failure") {
      // Inject only the late HTTP construction fault. SDK Worker construction,
      // native ownership and every close call remain real.
      spyOn(workerHttp, "startWorkerHttpServer").mockImplementation(() => {
        throw new Error("fixture HTTP startup failed");
      });
    }
    const settings = testSettings({
      temporalHost: address,
      temporalNamespace: namespace,
      temporalTaskQueue: taskQueue,
      modelCatalogSource: "code",
    });
    const creating = createOpenGeniWorkerService({
      role: "turn",
      settings,
      http: mode === "startup-failure" ? {} : false,
      activityDependencies: {
        db: {} as never,
        bus: new MemoryEventBus(),
        observability: createObservability(settings, { component: "worker-turn" }),
      },
    });
    if (mode === "startup-failure") {
      try {
        await creating;
        closeResult = "unexpected startup success";
      } catch (error) {
        errors.push(errorSummary(error));
        closeResult = "startup error suppressed native close failure";
      }
    } else {
      const host = await creating;
      try {
        await host.close();
        closeResult = "unexpected close success";
      } catch (error) {
        errors.push(errorSummary(error));
        closeResult = "service close skipped owned cleanup";
      }
      serviceState = host.state();
    }
  }
  console.log(JSON.stringify({
    probe: "initialized-native-worker",
    mode,
    sdkVersion: sdkRequire("@temporalio/worker/package.json").version,
    closeResult,
    workerStates: workers.map((worker) => worker.getState()),
    occupancy: workers.map((worker) => worker.getStatus().numInFlightNonLocalActivities),
    polls,
    jsCloses,
    nativeCloses,
    errors,
    serviceState,
    pollIssuedBeforeShutdown,
  }));
  server.forceShutdown();
  // Reclaim this fixture's unresolved native worker at the OS process boundary.
  // This is deliberately NOT a proposed embedded-host cleanup implementation.
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({ probe: "initialized-native-worker", fixtureError: errorSummary(error) }));
  server.forceShutdown();
  process.exit(1);
}
