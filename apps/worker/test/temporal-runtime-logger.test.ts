import { expect, test } from "bun:test";
import type { RuntimeOptions } from "@temporalio/worker";
import {
  installTemporalRuntimeLogging,
  temporalRuntimeLoggingOptions,
} from "../src/temporal-runtime-logger";

type Logged = { level: string; message: string; attributes: Record<string, unknown> };

function recordingObservability() {
  const logged: Logged[] = [];
  return {
    logged,
    observability: {
      log: (level: Logged["level"], message: string, attributes: Logged["attributes"] = {}) => {
        logged.push({ level, message, attributes });
      },
    },
  };
}

test("the runtime forwards core logs and routes SDK records to the structured logger", () => {
  const { logged, observability } = recordingObservability();
  const options = temporalRuntimeLoggingOptions(observability);

  const logging = options.telemetryOptions?.logging as { forward?: object; filter?: string };
  expect(logging.forward).toEqual({});
  expect(logging.filter).toContain("temporalio_sdk_core=WARN");

  options.logger!.warn("Activity failed", {
    sdkComponent: "activity",
    activityType: "drainSandboxLease",
    taskToken: "CiQprivate==",
    attempt: 3,
    error: new Error("private cause"),
  });
  expect(logged).toEqual([
    {
      level: "warn",
      message: "Activity failed",
      attributes: {
        sdkComponent: "activity",
        activity: "drainSandboxLease",
        attempt: 3,
        errorClass: "TemporalSdkOperationError",
        errorCode: "temporal_sdk_failure_logged",
        origin: "worker",
      },
    },
  ]);
});

test("installs the process runtime once and leaves an embedding host's runtime alone", () => {
  const { observability } = recordingObservability();
  const installed: RuntimeOptions[] = [];
  const runtime = {
    _instance: undefined as unknown,
    install(options: RuntimeOptions) {
      installed.push(options);
      this._instance = {};
      return this._instance;
    },
  };

  expect(installTemporalRuntimeLogging(observability, runtime)).toBe(true);
  expect(installTemporalRuntimeLogging(observability, runtime)).toBe(false);
  expect(installed).toHaveLength(1);
  expect(installed[0]!.logger).toBeDefined();
});
