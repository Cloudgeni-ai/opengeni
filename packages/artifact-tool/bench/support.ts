export type PerfBudgets = {
  schemaVersion: 1;
  source: string;
  release: {
    measurement: string;
    gateEnvironment: string;
    operations: Record<string, { p95Ms: number; workUnits: number; implemented?: boolean }>;
  };
  ci: {
    operations: Record<string, { maxMs: number; workUnits: number }>;
    structural: Record<string, number>;
  };
  deepFixtures: Record<string, number>;
};

export type Measurement = {
  name: string;
  mode: "ci" | "deep";
  workUnits: number;
  samples: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  heapDeltaBytes?: number;
  rssDeltaBytes?: number;
  externalMemoryDeltaBytes?: number;
  outputBytes?: number;
  releaseBudgetMs?: number;
  releaseComparable?: boolean;
  releaseBudgetMet?: boolean;
  ciBudgetMs?: number;
  ciBudgetMet?: boolean;
  facts?: Record<string, string | number | boolean>;
};

export type BrowserBuildClosure = {
  eager: {
    rawBytes: number;
    gzipBytes: number;
    outputCount: number;
  };
  lazy: {
    rawBytes: number;
    gzipBytes: number;
    outputCount: number;
  };
  total: {
    rawBytes: number;
    gzipBytes: number;
    outputCount: number;
  };
  eagerExternalImports: readonly string[];
  lazyExternalImports: readonly string[];
};

export async function loadBudgets(): Promise<PerfBudgets> {
  return (await Bun.file(new URL("./budgets.json", import.meta.url)).json()) as PerfBudgets;
}

/**
 * Measures the code that loading an entry point actually evaluates separately
 * from chunks reachable only through dynamic imports.
 *
 * Summing every emitted chunk turns lazy codecs into an apparent startup cost;
 * looking only at the entry file misses shared static chunks. Walking the
 * emitted ESM graph gives the useful browser contract: entry points plus every
 * recursively referenced static import. The total remains visible so code
 * splitting cannot hide unbounded install/download growth.
 */
export async function measureBrowserBuildClosure(
  outputs: Awaited<ReturnType<typeof Bun.build>>["outputs"],
): Promise<BrowserBuildClosure> {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const modules = new Map<
    string,
    {
      bytes: Uint8Array;
      gzipBytes: number;
      imports: ReturnType<Bun.Transpiler["scan"]>["imports"];
      entrypoint: boolean;
    }
  >();

  for (const output of outputs) {
    const bytes = new Uint8Array(await output.arrayBuffer());
    const source = new TextDecoder().decode(bytes);
    modules.set(normalizeBuildPath(output.path), {
      bytes,
      gzipBytes: Bun.gzipSync(bytes).byteLength,
      imports: transpiler.scan(source).imports,
      entrypoint: output.kind === "entry-point",
    });
  }

  const eagerPaths = new Set<string>();
  const pending = [...modules].filter(([, module]) => module.entrypoint).map(([path]) => path);
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eagerPaths.has(path)) continue;
    eagerPaths.add(path);
    const module = modules.get(path);
    if (!module) throw new Error(`Missing emitted browser module: ${path}`);
    for (const imported of module.imports) {
      if (imported.kind !== "import-statement" || !imported.path.startsWith(".")) continue;
      const resolved = resolveBuildImport(path, imported.path);
      if (!modules.has(resolved)) {
        throw new Error(`Static browser import ${imported.path} from ${path} was not emitted`);
      }
      pending.push(resolved);
    }
  }

  const eager = { rawBytes: 0, gzipBytes: 0, outputCount: 0 };
  const lazy = { rawBytes: 0, gzipBytes: 0, outputCount: 0 };
  const eagerExternalImports = new Set<string>();
  const lazyExternalImports = new Set<string>();
  for (const [path, module] of modules) {
    const target = eagerPaths.has(path) ? eager : lazy;
    target.rawBytes += module.bytes.byteLength;
    target.gzipBytes += module.gzipBytes;
    target.outputCount += 1;
    const externalImports = eagerPaths.has(path) ? eagerExternalImports : lazyExternalImports;
    for (const imported of module.imports) {
      if (!imported.path.startsWith(".")) externalImports.add(imported.path);
    }
  }

  return {
    eager,
    lazy,
    total: {
      rawBytes: eager.rawBytes + lazy.rawBytes,
      gzipBytes: eager.gzipBytes + lazy.gzipBytes,
      outputCount: eager.outputCount + lazy.outputCount,
    },
    eagerExternalImports: [...eagerExternalImports].sort(),
    lazyExternalImports: [...lazyExternalImports].sort(),
  };
}

function normalizeBuildPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function resolveBuildImport(importer: string, imported: string): string {
  const url = new URL(imported, `https://opengeni.invalid/${importer}`);
  return url.pathname.slice(1);
}

export async function measure(
  name: string,
  mode: "ci" | "deep",
  workUnits: number,
  samples: number,
  operation: () => unknown | Promise<unknown>,
): Promise<Measurement> {
  const timings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = Bun.nanoseconds();
    await operation();
    timings.push(Number(Bun.nanoseconds() - started) / 1_000_000);
  }
  timings.sort((left, right) => left - right);
  return {
    name,
    mode,
    workUnits,
    samples,
    minMs: round(timings[0] ?? 0),
    medianMs: round(percentile(timings, 0.5)),
    p95Ms: round(percentile(timings, 0.95)),
    maxMs: round(timings.at(-1) ?? 0),
  };
}

export function attachBudgets(
  measurement: Measurement,
  budgets: PerfBudgets,
  releaseComparable = false,
): Measurement {
  const release = budgets.release.operations[measurement.name];
  const ci = budgets.ci.operations[measurement.name];
  const exactReleaseFixture = release && measurement.workUnits === release.workUnits;
  const ciComparable = ci && measurement.workUnits === ci.workUnits;
  return {
    ...measurement,
    ...(release
      ? {
          releaseBudgetMs: release.p95Ms,
          releaseComparable: Boolean(releaseComparable && exactReleaseFixture),
          ...(releaseComparable && exactReleaseFixture
            ? { releaseBudgetMet: measurement.p95Ms < release.p95Ms }
            : {}),
        }
      : {}),
    ...(ci
      ? {
          ciBudgetMs: ci.maxMs,
          ...(ciComparable ? { ciBudgetMet: measurement.maxMs < ci.maxMs } : {}),
        }
      : {}),
  };
}

export function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)]!;
}

export function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function matrix<T>(rows: number, columns: number, value: (index: number) => T): T[][] {
  return Array.from({ length: rows }, (_rowValue, row) =>
    Array.from({ length: columns }, (_columnValue, column) => value(row * columns + column)),
  );
}

/** Mulberry32 with an explicit unsigned seed: deterministic on every JS target. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
