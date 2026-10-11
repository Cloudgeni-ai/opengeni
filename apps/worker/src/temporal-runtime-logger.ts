import { createTemporalSdkLogger, type Observability } from "@opengeni/observability";
import { makeTelemetryFilterString, Runtime, type RuntimeOptions } from "@temporalio/worker";

/**
 * Runtime options that send every Temporal SDK log record, including records
 * forwarded from the Rust core, through the structured Opengeni logger.
 * Without this the SDK's DefaultLogger prints multi-line objects (with task
 * tokens, raw errors and stacks) and core prints plain text, both outside the
 * public log projection and the one-JSON-object-per-line contract.
 */
export function temporalRuntimeLoggingOptions(
  observability: Pick<Observability, "log">,
): RuntimeOptions {
  return {
    logger: createTemporalSdkLogger(observability),
    telemetryOptions: {
      logging: {
        // The SDK's default core filter, now forwarded instead of printed.
        filter: makeTelemetryFilterString({ core: "WARN", other: "ERROR" }),
        forward: {},
      },
    },
  };
}

type RuntimeInstaller = {
  readonly _instance?: unknown;
  install(options: RuntimeOptions): unknown;
};

/**
 * Install the process-wide Temporal Runtime with the structured logger. Must
 * run before the first NativeConnection or Worker is created. Returns false
 * when an embedding host already installed its own Runtime, which is left
 * untouched.
 */
export function installTemporalRuntimeLogging(
  observability: Pick<Observability, "log">,
  runtime: RuntimeInstaller = Runtime,
): boolean {
  if (runtime._instance !== undefined) return false;
  runtime.install(temporalRuntimeLoggingOptions(observability));
  return true;
}
