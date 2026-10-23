import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { plan } from "./planner";
import {
  capacityDecision,
  digest,
  ejectionKey,
  type Config,
  type Manifest,
  type MissingRun,
  type Observation,
  type Pull,
  type StageSample,
} from "./model";

interface JournalData {
  version: 1;
  coverageSince: string;
  lastObservedAt: string | null;
  conflicts: Record<string, { pull: Pull; at: string }>;
  stages: Record<string, StageSample>;
  missing: Record<string, MissingRun>;
  lastCapacityHold?: { at: string; runId: number; config: string; keys: string[] } | null;
}
const DAY = 86_400_000;
export const LATENCY_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_HOLD_GAP_MS = 300_000;
function creditedWait(
  waits: NonNullable<StageSample["mainCapacityWaits"]>,
  ready: number,
  start: number,
) {
  const intervals = waits
    .filter((w) => Number.isSafeInteger(w.mainRunId) && w.mainRunId > 0)
    .map((w) => [Date.parse(w.from), Date.parse(w.to)] as const)
    .filter(
      ([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= MAX_HOLD_GAP_MS,
    )
    .map(([a, b]) => [Math.max(a, ready), Math.min(b, start)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = ready;
  for (const [a, b] of intervals) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
export function latencySummary(
  stages: Record<string, StageSample>,
  now: string,
  adjustCapacity = true,
): { p95: number | null; samples: number } {
  const firstStarts = new Map<string, { readyAt: string; startedAt: string }>();
  const waits = new Map<string, NonNullable<StageSample["mainCapacityWaits"]>>();
  if (adjustCapacity)
    for (const sample of Object.values(stages))
      for (const wait of sample.mainCapacityWaits ?? []) {
        const list = waits.get(wait.key) ?? [];
        list.push(wait);
        waits.set(wait.key, list);
      }
  for (const sample of Object.values(stages))
    if (sample.ciStartedAt) {
      for (const binding of sample.readyBindings ?? []) {
        const prior = firstStarts.get(binding.key);
        if (!prior || sample.ciStartedAt < prior.startedAt)
          firstStarts.set(binding.key, { readyAt: binding.readyAt, startedAt: sample.ciStartedAt });
      }
    }
  const latencies = [...firstStarts.entries()]
    .filter(
      ([, s]) =>
        Date.parse(s.startedAt) >= Date.parse(now) - LATENCY_WINDOW_MS &&
        Date.parse(s.startedAt) <= Date.parse(now),
    )
    .map(([key, s]) => {
      const ready = Date.parse(s.readyAt),
        start = Date.parse(s.startedAt);
      return (
        (start - ready - (adjustCapacity ? creditedWait(waits.get(key) ?? [], ready, start) : 0)) /
        1000
      );
    })
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  return {
    p95: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null,
    samples: latencies.length,
  };
}
export class ObservationJournal {
  readonly path: string;
  private data: JournalData | null = null;
  constructor(readonly config: Config) {
    this.path = join(
      config.outputDir,
      `observations-${digest([config.repository, config.branchPrefix, config.mode])}.json`,
    );
  }
  async load(now: string): Promise<JournalData> {
    if (this.data) return this.data;
    try {
      const text = await readFile(this.path, "utf8");
      if (text.length > 16_000_000) throw new Error("journal too large");
      const value = JSON.parse(text) as JournalData;
      if (
        value.version !== 1 ||
        !value.stages ||
        !value.conflicts ||
        !value.missing ||
        !Number.isFinite(Date.parse(value.coverageSince))
      )
        throw new Error("invalid journal");
      this.data = value;
      this.data.lastObservedAt ??= null;
    } catch {
      this.data = {
        version: 1,
        coverageSince: now,
        lastObservedAt: null,
        conflicts: {},
        stages: {},
        missing: {},
      };
    }
    return this.data;
  }
  async save(now: string): Promise<void> {
    const data = await this.load(now);
    const stages = Object.values(data.stages).sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
    );
    const keep = stages
      .filter((s) => Date.parse(s.observedAt) >= Date.parse(now) - 2 * DAY)
      .slice(0, 4096);
    if (keep.length < stages.length && stages.length >= 4096) data.coverageSince = now; // truncation is not complete coverage
    data.stages = Object.fromEntries(keep.map((s) => [s.batchId, s]));
    // Conflict exclusions retain only currently ready exact events (pruned in observe).
    await mkdir(this.config.outputDir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  private sample(manifest: Manifest, now: string): StageSample {
    return {
      batchId: manifest.batchId,
      readyAt: new Date(
        Math.min(...manifest.pulls.map((p) => Date.parse(p.binding.at))),
      ).toISOString(),
      readyBindings: manifest.pulls.map((p) => ({
        key: ejectionKey(p),
        number: p.number,
        headSha: p.headSha,
        readyAt: p.binding.at,
      })),
      builtAt: null,
      publishedAt: null,
      ciStartedAt: null,
      ciCompletedAt: null,
      landedAt: null,
      observedAt: now,
    };
  }
  async event(
    manifest: Manifest,
    field: "builtAt" | "publishedAt" | "landedAt",
    at: string,
  ): Promise<StageSample> {
    const data = await this.load(at),
      sample = data.stages[manifest.batchId] ?? this.sample(manifest, at);
    sample[field] ??= at;
    sample.observedAt = at;
    data.stages[manifest.batchId] = sample;
    await this.save(at);
    return structuredClone(sample);
  }
  async conflict(pull: Pull, now: string): Promise<void> {
    (await this.load(now)).conflicts[ejectionKey(pull)] = { pull, at: now };
    await this.save(now);
  }
  async observe(o: Observation): Promise<Observation> {
    const data = await this.load(o.now);
    const previousAt = data.lastObservedAt;
    if (
      data.lastObservedAt &&
      Date.parse(o.now) - Date.parse(data.lastObservedAt) >
        Math.max(300_000, this.config.pollSeconds * 3000)
    )
      data.coverageSince = o.now; // An observation gap cannot become complete coverage after restart.
    data.lastObservedAt = o.now;
    for (const [key, sample] of Object.entries(o.ledger.stages)) {
      const local = data.stages[key];
      data.stages[key] = local
        ? {
            ...sample,
            ...local,
            builtAt: local.builtAt ?? sample.builtAt,
            publishedAt: local.publishedAt ?? sample.publishedAt,
            ciStartedAt: local.ciStartedAt ?? sample.ciStartedAt,
            ciCompletedAt: local.ciCompletedAt ?? sample.ciCompletedAt,
            landedAt: local.landedAt ?? sample.landedAt,
            mainCapacityWaits: [
              ...new Map(
                [...(sample.mainCapacityWaits ?? []), ...(local.mainCapacityWaits ?? [])].map(
                  (w) => [JSON.stringify(w), w],
                ),
              ).values(),
            ],
            ...(sample.retry ? { retry: sample.retry } : {}),
          }
        : structuredClone(sample);
    }
    for (const [id, item] of Object.entries(o.ledger.missingRuns))
      if (
        !data.missing[id] ||
        item.status === "released" ||
        Date.parse(item.updatedAt) > Date.parse(data.missing[id]!.updatedAt)
      )
        data.missing[id] = { ...item };
    const readyKeys = new Set(o.ready.map(ejectionKey));
    for (const key of Object.keys(data.conflicts))
      if (!readyKeys.has(key)) delete data.conflicts[key];
    for (const candidate of o.candidates) {
      const id = candidate.manifest.batchId;
      const sample = data.stages[id] ?? this.sample(candidate.manifest, o.now);
      // Never use deterministic manifest.createdAt as measured build time.
      for (const run of candidate.runs) {
        if (
          run.startedAt &&
          Number.isFinite(Date.parse(run.startedAt)) &&
          (!sample.ciStartedAt || run.startedAt < sample.ciStartedAt)
        )
          sample.ciStartedAt = run.startedAt;
        if (run.completedAt && (!sample.ciCompletedAt || run.completedAt > sample.ciCompletedAt))
          sample.ciCompletedAt = run.completedAt;
      }
      // Seeing main ancestry establishes containment, not its actual landing timestamp.
      sample.observedAt = o.now;
      data.stages[id] = sample;
      if (!candidate.runs.length) {
        const historical = candidate.containedInBase || o.ledger.landed.includes(id);
        const missing = data.missing[id] ?? {
          // Main containment cannot prove that a historical workflow is idle.
          // Age newly unavailable history from its observation, not an old
          // publication timestamp that would immediately abandon the hold.
          firstSeenAt: historical ? o.now : (sample.publishedAt ?? o.now),
          status: "holding" as const,
          updatedAt: o.now,
        };
        missing.kind ??= historical ? "historical-run-history" : "workflow-admission";
        if (
          missing.status === "holding" &&
          Date.parse(o.now) - Date.parse(missing.firstSeenAt) >=
            this.config.missingRunSeconds * 1000
        )
          data.missing[id] = { ...missing, status: "abandoned", updatedAt: o.now };
        else data.missing[id] = missing;
      }
    }
    const present = new Set(o.candidates.map((c) => c.manifest.batchId));
    for (const id of Object.keys(data.missing)) if (!present.has(id)) delete data.missing[id];
    const h = o.headroom,
      capacity = h?.capacity,
      demand = h?.mainDemand;
    const runId = capacity?.latestMain?.runId;
    // Unknown/incomplete scans and demand attributable only to other work earn
    // no credit. Both endpoints must show main alone blocking admission.
    const otherDemand = h ? h.occupied - (demand ?? 0) : NaN;
    const withoutMain =
      h && capacity && Number.isSafeInteger(otherDemand) && otherDemand >= 0
        ? capacityDecision({
            mainDemand: 0,
            otherDemand,
            latestMain: null,
            mainQueuedJobs: 0,
            preFanoutMainRuns: [],
            runnerBudget: h.budget ?? 0,
            mainReserve: this.config.mainReserve ?? 0,
            providerJobLimit: capacity.providerJobLimit ?? 0,
            otherRepositoryAllowance: capacity.otherRepositoryAllowance ?? -1,
          }).allowed
        : false;
    const beforeCredit = latencySummary(data.stages, o.now);
    const mainHold =
      withoutMain &&
      o.mainBusy === true &&
      h?.allowed === false &&
      Number.isSafeInteger(demand) &&
      demand! >= 0 &&
      Number.isSafeInteger(runId) &&
      runId! > 0 &&
      (capacity?.hold === "main-pre-fanout" ||
        capacity?.hold === "main-queued" ||
        (capacity?.hold === "repository-budget" &&
          demand! > (this.config.mainReserve ?? Infinity) &&
          demand! + 18 > (h.budget ?? Infinity)) ||
        (capacity?.hold === "provider-limit" &&
          demand! > 0 &&
          demand! + (capacity.otherRepositoryAllowance ?? -Infinity) + 18 >
            (capacity.providerJobLimit ?? Infinity)));
    // Credit only heads that would publish absent this main-capacity gate.
    // A simultaneous occupied batch slot, stale binding or local conflict is
    // not demonstrably main-capacity waiting and must remain unadjusted.
    const withoutMainHold = mainHold
      ? plan(
          {
            ...o,
            ready: o.ready.filter((p) => !data.conflicts[ejectionKey(p)]),
            missingRuns: structuredClone(data.missing),
            mainBusy: false,
            headroom: { ...h!, allowed: true },
            telemetry: {
              status:
                beforeCredit.p95 === null
                  ? "unknown"
                  : beforeCredit.p95 > 1800
                    ? "stop"
                    : "within-threshold",
              p95ReadyToCiSeconds: beforeCredit.p95,
              samples: beforeCredit.samples,
              coverageSince: data.coverageSince,
              completeWindow:
                Date.parse(o.now) - Date.parse(data.coverageSince) >= LATENCY_WINDOW_MS,
            },
          },
          this.config,
        )
      : null;
    const hold =
      mainHold && withoutMainHold?.kind === "build" && withoutMainHold.publish
        ? {
            at: o.now,
            runId: runId!,
            config: digest([
              h!.budget,
              this.config.mainReserve,
              capacity!.providerJobLimit,
              capacity!.otherRepositoryAllowance,
            ]),
            keys: withoutMainHold.spec.pulls.map(ejectionKey),
          }
        : null;
    const prior = data.lastCapacityHold;
    if (
      hold &&
      prior &&
      prior.at === previousAt &&
      prior.runId === hold.runId &&
      prior.config === hold.config &&
      Date.parse(hold.at) > Date.parse(prior.at) &&
      Date.parse(hold.at) - Date.parse(prior.at) <= MAX_HOLD_GAP_MS
    ) {
      for (const sample of Object.values(data.stages))
        for (const binding of sample.readyBindings ?? []) {
          if (
            !hold.keys.includes(binding.key) ||
            !prior.keys.includes(binding.key) ||
            sample.ciStartedAt
          )
            continue;
          sample.mainCapacityWaits ??= [];
          sample.mainCapacityWaits.push({
            key: binding.key,
            from: prior.at,
            to: hold.at,
            mainRunId: hold.runId,
          });
          sample.mainCapacityWaits = sample.mainCapacityWaits.slice(-4096);
        }
    }
    data.lastCapacityHold = hold;
    const { p95, samples } = latencySummary(data.stages, o.now);
    const excluded = [...o.excluded];
    const ready = o.ready.filter((p) => {
      if (!data.conflicts[ejectionKey(p)]) return true;
      excluded.push({
        number: p.number,
        reason: "local merge conflict exclusion for exact head and ready event",
      });
      return false;
    });
    await this.save(o.now);
    return {
      ...o,
      ready,
      excluded,
      missingRuns: structuredClone(data.missing),
      telemetry: {
        status: p95 === null ? "unknown" : p95 > 1800 ? "stop" : "within-threshold",
        p95ReadyToCiSeconds: p95,
        rawP95ReadyToCiSeconds: latencySummary(data.stages, o.now, false).p95,
        windowSeconds: LATENCY_WINDOW_MS / 1000,
        samples,
        coverageSince: data.coverageSince,
        completeWindow: Date.parse(o.now) - Date.parse(data.coverageSince) >= LATENCY_WINDOW_MS,
      },
    };
  }
  async records(now: string) {
    const data = await this.load(now);
    return { stages: structuredClone(data.stages), missingRuns: structuredClone(data.missing) };
  }
  async recoverMissing(id: string, o: Observation, confirmed: boolean): Promise<void> {
    const data = await this.load(o.now),
      candidate = o.candidates.find((c) => c.manifest.batchId === id);
    if (
      !confirmed ||
      !candidate ||
      candidate.runs.length ||
      data.missing[id]?.status !== "abandoned"
    )
      throw new Error(
        "Missing-run recovery requires abandoned exact candidate, no observed run and explicit confirmation",
      );
    data.missing[id] = {
      ...data.missing[id]!,
      status: "released",
      updatedAt: o.now,
      recovery: {
        confirmedNoRun: true,
        at: o.now,
        controllerId: null,
        tipSha: candidate.manifest.tipSha,
        previousStateSha: o.stateSha,
      },
    };
    await this.save(o.now);
  }
}
