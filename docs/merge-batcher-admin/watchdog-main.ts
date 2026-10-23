/** Cloud Run job entrypoint; no agent or VM dependency. */
import { ObjectStore, WatchdogCloud } from "./watchdog-cloud";
import { createProvider, type RuntimeConfig } from "./watchdog-provider";
import { tick } from "./watchdog";

export async function main(env = process.env): Promise<number> {
  const started = new Date().toISOString();
  let config: RuntimeConfig | null = null;
  let executionName: string | null = null,
    stateSha: string | null = null;
  let incidentId: string | null = null,
    receiptDigest: string | null = null;
  let result: "healthy" | "off-verified" | "held-unknown" | "drift" | "error" = "error";
  let close: (() => Promise<void>) | undefined;
  try {
    const {
      WATCHDOG_CONFIG_BUCKET: bucket,
      WATCHDOG_CONFIG_OBJECT: object,
      WATCHDOG_CONFIG_GENERATION: generation,
      CLOUD_RUN_EXECUTION: execution,
      CLOUD_RUN_JOB: job,
    } = env;
    if (
      !bucket ||
      !object ||
      !generation ||
      !/^\d+$/.test(generation) ||
      !execution ||
      !job ||
      execution.includes("/") ||
      job.includes("/")
    )
      throw Error("Pinned config and actual Cloud Run execution required");
    const cloud = new WatchdogCloud();
    const pinned = await new ObjectStore(cloud, bucket).read<RuntimeConfig>(object, generation);
    if (!pinned) throw Error("Pinned config absent");
    config = pinned.value;
    if (!config.jobResource.endsWith(`/jobs/${job}`)) throw Error("Job identity mismatch");
    executionName = `${config.jobResource}/executions/${execution}`;
    const provider = await createProvider(config, cloud);
    close = provider.close;
    if ((await provider.ports.execution(executionName)) !== "running")
      throw Error("Execution/source binding not proven");
    const read = provider.ports.read;
    provider.ports.read = async () => {
      const observation = await read();
      if (!/^[a-f0-9]{40}$/.test(observation.revision))
        throw Error("Authoritative Git snapshot missing");
      stateSha = observation.revision;
      return observation;
    };
    const outcome = await tick(provider.ports, config.binding, executionName);
    const record = await provider.ports.load();
    incidentId = record?.value.incident?.id ?? null;
    receiptDigest = record?.value.receipt ?? null;
    result =
      outcome === "healthy"
        ? "healthy"
        : outcome === "manual" && receiptDigest
          ? "off-verified"
          : outcome.includes("drift") || outcome === "binding-hold"
            ? "drift"
            : "held-unknown";
    return result === "healthy" || result === "off-verified" ? 0 : 2;
  } catch {
    // Never print provider bodies, tokens, keys, raw URLs or exception messages.
    return 1;
  } finally {
    console.log(
      JSON.stringify({
        event: "batcher_watchdog_completed",
        schema: "batcher-watchdog/v1",
        executionName,
        jobResource: config?.jobResource ?? null,
        watchdogImageDigest: config?.watchdogImage.split("@")[1] ?? null,
        checkedAt: started,
        completedAt: new Date().toISOString(),
        serviceUid: config?.binding.deploymentUid ?? null,
        activationId: config?.binding.activation ?? null,
        stateSha,
        incidentId,
        result,
        receiptDigest,
      }),
    );
    await close?.();
  }
}
if (import.meta.main) {
  if (process.argv[2] !== "run")
    throw Error("Expected watchdog run; observer belongs to independent sweep");
  process.exitCode = await main();
}
