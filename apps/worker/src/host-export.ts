/**
 * Lightweight host-export entrypoint for embedded API processes.
 *
 * Importing the worker package root initializes Temporal's native worker
 * dependency graph. Host applications that only project durable OpenGeni
 * events or usage must not need that native runtime (or its libc contract).
 */
export {
  createHostExportPump,
  type HostExportDrainResult,
  type HostExportPump,
  type HostExportPumpOptions,
} from "./host-export-pump";

export type {
  HostEventExport,
  HostEventExportBatch,
  HostEventSink,
  HostUsageExport,
  HostUsageExportBatch,
  HostUsageSink,
} from "@opengeni/contracts";
