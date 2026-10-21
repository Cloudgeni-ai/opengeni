import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
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
}
const DAY = 86_400_000;
export function latencySummary(
  stages: Record<string, StageSample>,
  now: string,
): { p95: number | null; samples: number } {
  const firstStarts = new Map<string, { readyAt: string; startedAt: string }>();
  for (const sample of Object.values(stages))
    if (sample.ciStartedAt) {
      for (const binding of sample.readyBindings ?? []) {
        const prior = firstStarts.get(binding.key);
        if (!prior || sample.ciStartedAt < prior.startedAt)
          firstStarts.set(binding.key, { readyAt: binding.readyAt, startedAt: sample.ciStartedAt });
      }
    }
  const latencies = [...firstStarts.values()]
    .filter(
      (s) =>
        Date.parse(s.startedAt) >= Date.parse(now) - DAY &&
        Date.parse(s.startedAt) <= Date.parse(now),
    )
    .map((s) => (Date.parse(s.startedAt) - Date.parse(s.readyAt)) / 1000)
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
      if (!candidate.runs.length && !candidate.containedInBase) {
        const missing = data.missing[id] ?? {
          firstSeenAt: sample.publishedAt ?? o.now,
          status: "holding" as const,
          updatedAt: o.now,
        };
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
        samples,
        coverageSince: data.coverageSince,
        completeWindow: Date.parse(o.now) - Date.parse(data.coverageSince) >= DAY,
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
    data.missing[id] = { ...data.missing[id]!, status: "released", updatedAt: o.now };
    await this.save(o.now);
  }
}
