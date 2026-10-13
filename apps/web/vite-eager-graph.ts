import path from "node:path";

import type { Plugin } from "vite";

/**
 * Code-splitting groups place modules by group rules and entry-aware merging,
 * not only by what a page imports. A rule that pulls a small module needed by
 * an eager page into a chunk with large lazy-only code makes that page
 * download all of it: merged editor or settings code then loads with every
 * chat. Byte budgets cannot tell this apart from ordinary feature growth.
 *
 * This check measures exactly the misplaced code. For each eager graph (the
 * initial load, and the initial load plus a route that is opened directly) it
 * sums the rendered size of modules that the graph loads but that none of its
 * modules statically import, and fails the build above a small allowance.
 */

export type EagerGraphChunk = Readonly<{
  fileName: string;
  isEntry: boolean;
  /** Static chunk imports, as bundle file names. */
  imports: readonly string[];
  /** Rendered length of each module in the chunk. */
  modules: Readonly<Record<string, number>>;
}>;

export type EagerGraph = Readonly<{
  name: string;
  /** Module ids that the graph starts from. */
  roots: readonly string[];
}>;

export type EagerGraphReport = Readonly<{
  name: string;
  files: number;
  /** Rendered bytes loaded by the graph that none of its modules statically import. */
  unusedBytes: number;
  chunks: readonly Readonly<{
    fileName: string;
    unusedBytes: number;
    unusedModules: readonly Readonly<{ id: string; bytes: number }>[];
  }>[];
}>;

export function measureEagerGraphs(
  chunks: readonly EagerGraphChunk[],
  staticImports: (moduleId: string) => readonly string[],
  graphs: readonly EagerGraph[],
): EagerGraphReport[] {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const chunkOf = new Map<string, string>();
  for (const chunk of chunks) {
    for (const id of Object.keys(chunk.modules)) chunkOf.set(id, chunk.fileName);
  }
  return graphs.map((graph) => {
    const needed = new Set<string>(graph.roots);
    const pending = [...graph.roots];
    while (pending.length > 0) {
      for (const next of staticImports(pending.pop()!)) {
        if (needed.has(next)) continue;
        needed.add(next);
        pending.push(next);
      }
    }
    const loaded = new Set<string>();
    const pendingChunks = graph.roots.flatMap((root) => {
      const file = chunkOf.get(root);
      return file ? [file] : [];
    });
    while (pendingChunks.length > 0) {
      const file = pendingChunks.pop()!;
      if (loaded.has(file)) continue;
      loaded.add(file);
      pendingChunks.push(...(byFile.get(file)?.imports ?? []));
    }
    const reportChunks = [...loaded]
      .sort()
      .map((fileName) => {
        const unusedModules = Object.entries(byFile.get(fileName)?.modules ?? {})
          .filter(([id, bytes]) => bytes > 0 && !needed.has(id))
          .map(([id, bytes]) => ({ id, bytes }))
          .sort((left, right) => right.bytes - left.bytes);
        const unusedBytes = unusedModules.reduce((sum, module) => sum + module.bytes, 0);
        return { fileName, unusedBytes, unusedModules };
      })
      .filter((chunk) => chunk.unusedBytes > 0)
      .sort((left, right) => right.unusedBytes - left.unusedBytes);
    return {
      name: graph.name,
      files: loaded.size,
      unusedBytes: reportChunks.reduce((sum, chunk) => sum + chunk.unusedBytes, 0),
      chunks: reportChunks,
    };
  });
}

export function describeEagerGraphOverflow(
  reports: readonly EagerGraphReport[],
  allowanceBytes: number,
  root = "",
): string {
  const relative = (id: string) => {
    const clean = id.replace(/\0/g, "").split("?")[0]!;
    const nodeModules = clean.lastIndexOf("node_modules/");
    if (nodeModules >= 0) return clean.slice(nodeModules + "node_modules/".length);
    return root ? path.relative(root, clean) : clean;
  };
  const lines: string[] = [
    `Eager pages load code they never import (allowance ${allowanceBytes} rendered bytes per page).`,
    "A code-splitting group placed modules these pages need in the same chunk as lazy-only code.",
    "Pin the needed modules elsewhere, or stop the group from merging them into the lazy code.",
  ];
  for (const report of reports) {
    lines.push(`- ${report.name}: ${report.unusedBytes} unused bytes across ${report.files} files`);
    for (const chunk of report.chunks.slice(0, 4)) {
      const top = chunk.unusedModules
        .slice(0, 4)
        .map((module) => `${relative(module.id)} (${module.bytes})`)
        .join(", ");
      lines.push(`  ${chunk.fileName}: ${chunk.unusedBytes} unused, e.g. ${top}`);
    }
  }
  return lines.join("\n");
}

export type EagerGraphPluginOptions = {
  /**
   * Routes that people open directly, as module path suffixes. Each is
   * measured together with the entry, as a direct load would fetch them.
   */
  directRoutes: readonly string[];
  /** Rendered bytes of unimported code each page may load. */
  allowanceBytes: number;
};

/** Fails the build when an eager page loads more unimported code than allowed. */
export function eagerGraphPlugin(options: EagerGraphPluginOptions): Plugin {
  let root = "";
  return {
    name: "opengeni-eager-graph",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const chunks: EagerGraphChunk[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const modules: Record<string, number> = {};
        for (const [id, info] of Object.entries(output.modules)) modules[id] = info.renderedLength;
        chunks.push({
          fileName: output.fileName,
          isEntry: output.isEntry,
          imports: output.imports,
          modules,
        });
      }
      const entries = Object.values(bundle).flatMap((output) =>
        output.type === "chunk" && output.isEntry && output.facadeModuleId
          ? [output.facadeModuleId]
          : [],
      );
      const moduleIds = [...this.getModuleIds()];
      const graphs: EagerGraph[] = [{ name: "initial load", roots: entries }];
      for (const route of options.directRoutes) {
        const suffix = route.split("/").join(path.sep);
        const routeId = moduleIds.find((id) => id.endsWith(suffix) || id.endsWith(route));
        if (!routeId) {
          this.error(`Eager graph check: no module matches the direct route ${route}.`);
        }
        graphs.push({ name: `direct ${route}`, roots: [...entries, routeId] });
      }
      const reports = measureEagerGraphs(
        chunks,
        (id) => this.getModuleInfo(id)?.importedIds ?? [],
        graphs,
      );
      const overflowing = reports.filter((report) => report.unusedBytes > options.allowanceBytes);
      if (overflowing.length > 0) {
        this.error(describeEagerGraphOverflow(overflowing, options.allowanceBytes, root));
      }
    },
  };
}
