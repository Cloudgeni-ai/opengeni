import { Buffer } from "node:buffer";

// Isolates byte counting, not JSON serialization, validation, or complete turns.
// No database, provider, or network access. Run with Bun or Node's TS support.
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const character of ["x", "ø", "😀"]) {
  for (const targetBytes of [1024 * 1024, 8 * 1024 * 1024]) {
    const text = JSON.stringify({
      schema: character.repeat(targetBytes / Buffer.byteLength(character)),
    });
    const expected = new TextEncoder().encode(text).byteLength;
    const elapsed: number[][] = [[], []];
    const cpu: number[][] = [[], []];
    const implementations = [
      () => new TextEncoder().encode(text).byteLength,
      () => Buffer.byteLength(text, "utf8"),
    ];
    for (let pair = 0; pair < 45; pair++) {
      for (const index of pair % 2 ? [1, 0] : [0, 1]) {
        const beforeCpu = process.cpuUsage();
        const before = performance.now();
        const bytes = implementations[index]!();
        const ms = performance.now() - before;
        const usage = process.cpuUsage(beforeCpu);
        if (bytes !== expected) throw Error("UTF-8 byte-count mismatch");
        if (pair >= 5) {
          elapsed[index]!.push(ms);
          cpu[index]!.push((usage.user + usage.system) / 1000);
        }
      }
    }
    console.log(
      JSON.stringify({
        runtime: process.versions,
        character,
        serializedBytes: expected,
        measuredPairs: 40,
        medianMs: elapsed.map(median),
        medianCpuMs: cpu.map(median),
      }),
    );
  }
}
